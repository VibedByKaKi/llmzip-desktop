// Compression worker (txiki.js Worker).
//
// libllama calls block the thread that makes them, so the model runs here and
// the backend thread stays free to talk to the page. One worker serves one job.
//
// Messages from the backend:
//   { type: 'start', mode: 'compress' | 'decompress', lib, model, bytes,
//     params: { nCtx, overlap, overlapTokens?, gpuLayers, nThreads, nBatch },
//     tokens?, topK, maxSteps }
//   { type: 'cancel' }
// Messages to the backend:
//   { type: 'ready', info }   model loaded
//   { type: 'progress', tokens, total, bytes }
//   { type: 'steps', steps }  coalesced coder steps for the diagram
//   { type: 'result', bytes, tokens }
//   { type: 'error', message, aborted }
import { dlopen } from 'tjs:ffi';

import { LlamaZip } from './vendor/llama-zip.js/js/llamazip.js';
import { bytesToUtf8 } from './vendor/llama-zip.js/js/utf8.js';

const FLUSH_MS = 100;
const PROGRESS_MS = 250;

const textEncoder = new TextEncoder();

let controller = null;

// Overlap as typed in the app ("25%" or a token count) to a token count,
// computed like llama-zip's -w option.
const parseOverlap = (text, nCtx) => {
    const value = String(text ?? '0%').trim();
    if (value.endsWith('%')) {
        const percent = Number(value.slice(0, -1));
        if (!(percent >= 0 && percent <= 100)) throw new Error('Window overlap must be between 0% and 100%.');
        return Math.trunc(percent / 100 * (nCtx - 1));
    }
    const tokens = Number(value);
    if (!Number.isInteger(tokens) || tokens < 0 || tokens >= nCtx)
        throw new Error(`Window overlap must be a percentage or a token count below ${nCtx}.`);
    return tokens;
};

// The llama.cpp build number comes from the library's file name and the CPU
// features from llama_print_system_info. Both are optional, a failure gives null.
const libraryInfo = async lib => {
    const info = { build: null, system: null };
    if (!lib) return info;
    try {
        const real = await tjs.realPath(lib);
        const match = real.split(/[\\/]/).pop().match(/\.(\d{3,})(?:\.dylib|\.so)?$/) || real.match(/llama\.cpp[\\/](\d{3,})[\\/]/);
        if (match) info.build = Number(match[1]);
    }
    catch { /* keep null */ }
    try {
        const symbols = dlopen(lib, { llama_print_system_info: { args: [], returns: 'string' } }).symbols;
        info.system = String(symbols.llama_print_system_info()).trim().replace(/\s+/g, ' ');
    }
    catch { /* keep null */ }
    return info;
};

const pieceLength = step => step.pieceBytes ? step.pieceBytes.length : textEncoder.encode(step.piece).length;

const run = async job => {
    if (job.lib) tjs.env.LLAMA_LIB = job.lib;
    controller = new AbortController();
    const { mode, params } = job;
    const zip = new LlamaZip(job.model, {
        nCtx: params.nCtx,
        nGpuLayers: params.gpuLayers,
        nThreads: params.nThreads,
        nBatch: params.nBatch
    });
    try {
        const overlap = params.overlapTokens ?? parseOverlap(params.overlap, zip.model.nCtx);
        const lib = await libraryInfo(job.lib);
        let total = job.tokens ?? 0;
        if (mode === 'compress')
            total = zip.model.tokenize(bytesToUtf8(job.bytes), { addBos: false }).length + 1;
        postMessage({
            type: 'ready',
            info: { nCtx: zip.model.nCtx, nBatch: zip.model.nBatch, overlapTokens: overlap, tokens: total, llamaBuild: lib.build, llamaSystem: lib.system }
        });

        let pending = [], sent = 0, done = 0, bytes = 0, lastFlush = 0, lastProgress = 0;
        const flush = () => {
            if (!pending.length) return;
            postMessage({ type: 'steps', steps: pending });
            pending = [];
            lastFlush = Date.now();
        };
        const onStep = step => {
            done++;
            bytes += pieceLength(step);
            if (sent < job.maxSteps) {
                pending.push(step);
                sent++;
            }
            const now = Date.now();
            if (now - lastFlush >= FLUSH_MS || sent >= job.maxSteps) flush();
            if (now - lastProgress >= PROGRESS_MS) {
                lastProgress = now;
                postMessage({ type: 'progress', tokens: done, total, bytes });
            }
        };
        const options = { signal: controller.signal, onStep, topK: job.topK };
        const output = mode === 'compress'
            ? await zip.compress(job.bytes, overlap, options)
            : await zip.decompress(job.bytes, overlap, { ...options, maxTokens: Math.max(0, total - 1) });
        // compress() answers an abort with a finished stream of the part it had read
        if (controller.signal.aborted) throw new Error('Cancelled');
        flush();
        postMessage({ type: 'progress', tokens: done, total, bytes });
        postMessage({ type: 'result', bytes: output, tokens: done });
    }
    finally {
        zip.close();
    }
};

self.onmessage = ({ data }) => {
    if (data.type === 'cancel')
        controller?.abort();
    else if (data.type === 'start')
        run(data).catch(error => postMessage({
            type: 'error',
            message: String(error?.message ?? error),
            aborted: !!controller?.signal.aborted
        }));
};
