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
import { libraryBuild } from './libllama.js';
import { libraryInfo } from './vendor/llama-zip.js/js/llama.js';
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

// The version and build that libllama reports ('1.0.0 (build 12359)') and the CPU features
// from llama_print_system_info. The file name is only a fallback for the version. Both are
// optional, a failure gives null.
const libraryDetails = async (zip, lib) => {
    let build = zip.model.llamaBuild || null;
    if (!build && lib)
        try {
            build = await libraryBuild(lib);
        }
        catch { /* keep null */ }
    const system = String(zip.model.systemInfo ?? '').trim().replace(/\s+/g, ' ');
    return { build, system: system || null };
};

// llama.cpp logs "unknown model architecture: 'xyz'" and the load fails, when the model is
// newer than the library.
const loadFailure = error => {
    const message = String(error?.message ?? error);
    if (!/unknown model architecture/i.test(message)) return error;
    let version = 'unknown version';
    try {
        version = libraryInfo().text;
    }
    catch { /* the message is still right without the version */ }
    return new Error(`This model needs a newer llama.cpp than the one installed (${version}). Update llama.cpp or choose another model.`);
};

const pieceLength = step => step.pieceBytes ? step.pieceBytes.length : textEncoder.encode(step.piece).length;

const run = async job => {
    if (job.lib) tjs.env.LLAMA_LIB = job.lib;
    controller = new AbortController();
    const { mode, params } = job;
    let zip;
    try {
        zip = new LlamaZip(job.model, {
            nCtx: params.nCtx,
            nGpuLayers: params.gpuLayers,
            nThreads: params.nThreads,
            nBatch: params.nBatch
        });
    }
    catch (error) {
        throw loadFailure(error);
    }
    try {
        const overlap = params.overlapTokens ?? parseOverlap(params.overlap, zip.model.nCtx);
        const lib = await libraryDetails(zip, job.lib);
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
