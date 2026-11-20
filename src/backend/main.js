// LLM Zip backend (txiki.js).
//
// The compressor is llama-zip.js (vendor/llama-zip.js), a port of llama-zip
// that binds the system libllama through FFI. It runs in a Worker, because
// libllama calls block their thread, and this file wraps its output in a small
// container (".llmz") that records everything the decoder needs to reproduce
// the encoder's predictions: engine, model fingerprint, context length, window
// overlap, GPU layers, thread and batch counts, the llama.cpp build, plus the
// original size and SHA-256.
import { createHash } from 'tjs:hashing';

import { PREBUILT, PREBUILT_TAG, TESTED_TEXT } from '../shared/llama.js';
import { MODELS } from '../shared/models.js';

import {
    decodeHeader, encodeHeader, FORMAT_VERSION, hashMatches, readPreamble, writePreamble
} from './header.js';
import {
    describeBuild, findLibllama, findTool, GUIDE, installCommand, installTool, IS_WIN, joinPath, LLAMA_PACKAGE, libraryBuild, platformKey, prebuiltDir, sameBuild, useRuntimeArch, toolEnv
} from './libllama.js';
import LZMA from './vendor/lzma-js/lzma-c.js';

const TEMP_DIR = joinPath(tjs.tmpDir, 'app.vibedbykaki.llmzip');

// The files that decompress jobs wrote. readText only opens these.
const DECOMPRESSED = new Set();
const VIEW_LIMIT = 2 * 1024 * 1024;

// Compressed files from an earlier run are gone from the jobs list, so nothing can save them.
void tjs.remove(TEMP_DIR).catch(() => {});

export const api = {
    status: async ({ lib, model }, app) => {
        const found = await findLibllama(lib, await dataDir(app));
        return {
            platform: IS_WIN ? 'windows' : 'unix',
            lib: found,
            model: model && await exists(model) ? await modelFingerprint(model) : null
        };
    },

    inspect: async ({ path }) => {
        const header = await readHeader(path);
        return header ? { llmz: true, version: header.version, meta: header.meta } : { llmz: false };
    },

    // Compresses a file (`input`) or typed text (`text`). The result goes to the
    // temporary folder unless `output` is given, and `save` copies it from there.
    // `diagram` asks for coder steps to be pushed to the page as 'steps' events.
    compress: async ({ input, text, name, output, model, lib, nCtx = 0, overlap = '0%', gpuLayers = 0, diagram = false }, app) => {
        const found = await requireLibllama(lib, app);
        if (!model || !await exists(model)) throw new Error('Choose a model (.gguf file) first.');
        const textBytes = typeof text === 'string' ? enc.encode(text) : null;
        if (textBytes && !textBytes.length) throw new Error('Type or paste some text first.');
        if (!textBytes && !input) throw new Error('No input.');

        return startJob(app, 'compress', async job => {
            const stem = textBytes ? baseName(name || 'text.txt') : baseName(input);
            if (!output) await tjs.makeDir(TEMP_DIR, { recursive: true });
            const out = await uniquePath(output || joinPath(TEMP_DIR, `${stem}.llmz`));
            const part = `${out}.part`;
            const bytes = textBytes || await tjs.readFile(input);
            const fingerprint = await modelFingerprint(model);
            const sha256 = createHash('sha256').update(bytes).digest();
            const params = { nCtx, overlap, gpuLayers, nThreads: DEFAULT_THREADS, nBatch: DEFAULT_BATCH };

            job.stage = 'Loading model';
            const { bytes: payload, info } = await runWorker(app, job, {
                mode: 'compress', lib: found.path, prebuilt: found.source === 'prebuilt', model, bytes, params, originalBytes: bytes.length, ...stepOptions(diagram, !!textBytes)
            });
            const meta = {
                name: textBytes ? baseName(name || 'text.txt') : baseName(input),
                size: bytes.length,
                sha256,
                tokens: info.tokens,
                model: fingerprint,
                params: {
                    nCtx, gpuLayers,
                    nCtxUsed: info.nCtx,
                    overlapTokens: info.overlapTokens,
                    nThreads: params.nThreads,
                    nBatch: info.nBatch
                },
                llama: { build: info.llamaBuild, systemDigest: createHash('sha256').update(info.llamaSystem || '').digest().slice(0, 8) }
            };
            const outputSize = await writeContainer(part, out, meta, payload);
            return { output: out, inputSize: bytes.length, outputSize, payloadSize: payload.length, tokens: info.tokens };
        });
    },

    // Compresses the same input with LZMA-JS, for comparison with the model.
    // Returns the size of the raw .lzma stream. It runs on this thread, in
    // chunks that yield to the event loop, so it does not use the worker.
    lzma: async ({ input, text, level = 9 }) => {
        const bytes = typeof text === 'string' ? enc.encode(text) : await tjs.readFile(input);
        if (!bytes.length) throw new Error('There is nothing to compress.');
        const start = Date.now();
        const size = await new Promise((resolve, reject) => LZMA.compress(bytes, level, (result, error) => error ? reject(error) : resolve(result.length)));
        return { size, level, seconds: (Date.now() - start) / 1000 };
    },

    // The text of a file a decompress job wrote, for the viewer. Reads at most VIEW_LIMIT bytes.
    // Content that is not valid UTF-8 is reported as binary instead.
    readText: async ({ path }) => {
        if (!DECOMPRESSED.has(path)) throw new Error('Only the result of a decompression can be viewed.');
        const file = await tjs.open(path, 'r');
        try {
            const size = (await file.stat()).size;
            const bytes = await readExactly(file, Math.min(size, VIEW_LIMIT), 0);
            try {
                // `stream` lets the cut at the limit fall inside a character.
                const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: true });
                return { text, size, truncated: size > bytes.length };
            }
            catch {
                return { binary: true, size };
            }
        }
        finally {
            await file.close();
        }
    },

    // Deletes compressed files from the temporary folder, for jobs removed from the history.
    discard: async ({ files = [] }) => {
        for (const file of files)
            if (dirName(file) === TEMP_DIR)
                await tjs.remove(file).catch(() => {});
        return { removed: files.length };
    },

    // Copies a compressed file from the temporary folder to the place the user chose.
    save: async ({ from, to }) => {
        if (!from || !to) throw new Error('Nothing to save.');
        if (dirName(from) !== TEMP_DIR || !await exists(from)) throw new Error('This compressed file is no longer available. Compress it again.');
        const part = `${to}.part`;
        await tjs.copyFile(from, part);
        await tjs.rename(part, to);
        return { output: to };
    },

    decompress: async ({ input, output, model, lib, force = false, diagram = false }, app) => {
        const found = await requireLibllama(lib, app);
        const header = await readHeader(input);
        if (!header) throw new Error('This is not an .llmz file.');
        const { version, meta, headerLen } = header;
        if (version === 1) throw new Error(
            'This file was made by an earlier version of LLM Zip that used the Python llama-zip (format version 1). ' +
            'This version cannot decode it, because the JavaScript coder is not interchangeable with the Python one. ' +
            'Decompress it with the Python llama-zip: the data after the header is plain llama-zip output.'
        );
        if (version > FORMAT_VERSION) throw new Error('This file needs a newer version of LLM Zip.');
        if (meta.engine !== ENGINE) throw new Error(`This file was made by ${meta.engine}, which this version cannot decode.`);
        if (!model || !await exists(model)) {
            const error = new Error(`Choose the model this file was made with: ${meta.model.name}`);
            error.code = 'MODEL_MISSING';
            throw error;
        }
        const fingerprint = await modelFingerprint(model);
        if (!force && (!hashMatches(fingerprint.sha256, toHex(meta.model.sha256)) || fingerprint.size !== meta.model.size)) {
            const error = new Error(
                `The selected model (${fingerprint.name}) differs from the one used to compress this file (${meta.model.name}). ` +
                'Decompressing with another model produces garbage or fails.'
            );
            error.code = 'MODEL_MISMATCH';
            throw error;
        }

        return startJob(app, 'decompress', async job => {
            const out = await uniquePath(output || joinPath(dirName(input), meta.name));
            const part = `${out}.part`;
            const payload = (await tjs.readFile(input)).subarray(headerLen);
            const { nCtx, overlapTokens, gpuLayers, nThreads, nBatch } = meta.params;
            const params = { nCtx, overlap: String(overlapTokens), overlapTokens, gpuLayers, nThreads, nBatch };

            job.stage = 'Loading model';
            let result;
            try {
                result = await runWorker(app, job, {
                    mode: 'decompress', lib: found.path, prebuilt: found.source === 'prebuilt', model, bytes: payload, params, tokens: meta.tokens, originalBytes: meta.size,
                    ...stepOptions(diagram, meta.size <= TEXT_LIMIT)
                });
            }
            catch (error) {
                if (job.cancelled) throw error;
                throw new Error(`${error.message}\n${await differences(meta, found.path)}`.trim());
            }
            const bytes = result.bytes;
            if (bytes.length !== meta.size || !hashMatches(createHash('sha256').update(bytes).digest(), toHex(meta.sha256))) {
                throw new Error(
                    'The decompressed data does not match the original checksum. ' +
                    'llama.cpp can give different predictions on different hardware, builds or thread counts, ' +
                    'so this file may only decompress on the machine that created it. ' +
                    `A model's tokenizer can also drop a few byte values, which breaks the round trip for binary data.\n${await differences(meta, found.path, result.info)}`.trim()
                );
            }
            await tjs.writeFile(part, bytes);
            await tjs.rename(part, out);
            DECOMPRESSED.add(out);
            return { output: out, inputSize: (await tjs.stat(input)).size, outputSize: bytes.length, verified: true, tokens: meta.tokens };
        });
    },

    // Runs the compressor on text without saving anything, so the page can draw
    // the diagram for text whose live run it missed.
    traceText: async ({ text, model, lib, nCtx = 0, overlap = '0%', gpuLayers = 0 }, app) => {
        const found = await requireLibllama(lib, app);
        if (!model || !await exists(model)) throw new Error('Choose a model (.gguf file) first.');
        const bytes = enc.encode(String(text ?? ''));
        if (!bytes.length) throw new Error('There is no text to show.');
        return startJob(app, 'trace', async job => {
            job.stage = 'Loading model';
            const params = { nCtx, overlap, gpuLayers, nThreads: DEFAULT_THREADS, nBatch: DEFAULT_BATCH };
            const { info } = await runWorker(app, job, {
                mode: 'compress', lib: found.path, prebuilt: found.source === 'prebuilt', model, bytes, params, originalBytes: bytes.length, ...stepOptions(true, true)
            });
            return { tokens: info.tokens };
        });
    },

    installers: async (_params, app) => ({
        prebuilt: await prebuiltSpec(app).then(spec => spec ? { tag: PREBUILT_TAG, size: spec.size } : null),
        tool: installTool(),
        exe: await findTool(installTool()),
        windows: IS_WIN,
        guide: GUIDE,
        dryRun: dryRunInstall()
    }),

    // Installs libllama with Homebrew or winget. Output streams to the page as
    // 'install' events.
    installLibllama: async ({ tool }, app) => {
        if (tool !== installTool()) throw new Error(`Use ${installTool()} on this system.`);
        const dry = dryRunInstall();
        // A dry run works without the installer, so the flow can be tried anywhere.
        const exe = await findTool(tool) || (dry ? tool : null);
        if (!exe) throw new Error(`${tool} was not found on this machine.`);
        return startJob(app, 'install', async job => {
            job.stage = 'installing';
            const args = installCommand(tool, exe);
            app.push('install', { text: `$ ${args.join(' ')}\n` });
            if (dry) {
                for (const line of [
                    '[dry run] Resolving packages',
                    `[dry run] Downloading ${LLAMA_PACKAGE} (simulated)`,
                    `[dry run] The latest release may be newer than the tested ${TESTED_TEXT}`,
                    '[dry run] Nothing was installed. Unset LLMZIP_DRY_RUN_INSTALL to install for real.'
                ]) {
                    await sleep(700);
                    if (job.cancelled) throw new Error('Cancelled');
                    app.push('install', { text: `${line}\n` });
                }
                return { dryRun: true, command: args.join(' ') };
            }
            const proc = tjs.spawn(args, { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: toolEnv() });
            job.proc = proc;
            let tail = '';
            const pump = stream => {
                const decoder = new TextDecoder();
                return drain(stream, chunk => {
                    const text = decoder.decode(chunk, { stream: true });
                    tail = (tail + text).slice(-3000);
                    app.push('install', { text });
                });
            };
            try {
                await Promise.all([pump(proc.stdout), pump(proc.stderr)]);
                const status = await proc.wait();
                if (job.cancelled) throw new Error('Cancelled');
                if (status.exit_status !== 0 || status.term_signal) {
                    const lines = tail.replace(/\r/g, '\n').split('\n').map(line => line.trim()).filter(Boolean).slice(-6);
                    throw new Error(`${tool} failed (exit ${status.exit_status ?? status.term_signal})\n${lines.join('\n')}`);
                }
            }
            finally {
                job.proc = null;
            }
            const lib = await findLibllama(null, await dataDir(app));
            if (!lib) throw new Error(`${tool} finished, but libllama was not found. Restart the app, or use "Use an existing libllama".`);
            return { lib: lib.path };
        });
    },

    // Installs libllama without a package manager: downloads the prebuilt llama.cpp release
    // that LLM Zip was tested with, checks its SHA-256 and unpacks it into the app's data
    // folder. Output streams to the page as 'install' events, like installLibllama.
    installPrebuilt: async (_params, app) => {
        const spec = await prebuiltSpec(app);
        if (!spec) throw new Error(`There is no prebuilt libllama for this system (${await platformKey()}).`);
        const dry = dryRunInstall();
        const data = await dataDir(app);
        const dir = await prebuiltDir(data);
        return startJob(app, 'install', async job => {
            job.stage = 'installing';
            const say = text => app.push('install', { text: `${text}\n` });
            say(`Downloading ${spec.url}`);
            if (dry) {
                for (const line of [
                    '[dry run] Downloading (simulated)',
                    '[dry run] Checking SHA-256 (simulated)',
                    `[dry run] Would unpack into ${dir}`,
                    '[dry run] Nothing was installed. Unset LLMZIP_DRY_RUN_INSTALL to install for real.'
                ]) {
                    await sleep(700);
                    if (job.cancelled) throw new Error('Cancelled');
                    say(line);
                }
                return { dryRun: true, command: spec.url };
            }
            const root = joinPath(data, 'libllama');
            await tjs.makeDir(root, { recursive: true });
            const archive = joinPath(root, `${PREBUILT_TAG}${spec.url.endsWith('.zip') ? '.zip' : '.tar.gz'}.part`);
            const staging = `${dir}.part`;
            const cleanup = async () => {
                for (const path of [archive, staging])
                    await tjs.remove(path).catch(() => {});
            };
            await cleanup();
            try {
                const res = await fetch(spec.url, { redirect: 'follow' });
                if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
                const total = Number(res.headers.get('content-length')) || spec.size;
                const reader = res.body.getReader();
                job.cancelFn = () => void reader.cancel().catch(() => {});
                const sha = createHash('sha256');
                const file = await tjs.open(archive, 'w');
                let received = 0, nextReport = 0.1;
                try {
                    for (;;) {
                        const { value, done } = await reader.read();
                        if (done) break;
                        sha.update(value);
                        await file.write(value, received);
                        received += value.length;
                        if (total && received / total >= nextReport) {
                            say(`${Math.floor(received / total * 100)}% of ${(total / 1048576).toFixed(1)} MB`);
                            nextReport = Math.floor(received / total * 10) / 10 + 0.1;
                        }
                    }
                }
                finally {
                    await file.close().catch(() => {});
                    job.cancelFn = null;
                }
                if (job.cancelled) throw new Error('Cancelled');
                if (received !== spec.size) throw new Error(`Download ended early or has the wrong size (${received} of ${spec.size} bytes).`);
                if (sha.digest() !== spec.sha256) throw new Error('The downloaded file does not match its published SHA-256. It was deleted.');
                say('SHA-256 matches. Unpacking.');
                await tjs.makeDir(staging, { recursive: true });
                // bsdtar ships with macOS, Windows 10 and later, and most Linux systems, and it reads ZIPs too.
                const tar = await findTool('tar') || 'tar';
                const args = [tar, '-xf', archive, '-C', staging, ...spec.strip ? ['--strip-components=1'] : []];
                say(`$ ${args.join(' ')}`);
                const proc = tjs.spawn(args, { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: toolEnv() });
                job.proc = proc;
                let tail = '';
                const pump = stream => {
                    const decoder = new TextDecoder();
                    return drain(stream, chunk => {
                        tail = (tail + decoder.decode(chunk, { stream: true })).slice(-1000);
                    });
                };
                try {
                    await Promise.all([pump(proc.stdout), pump(proc.stderr)]);
                    const status = await proc.wait();
                    if (job.cancelled) throw new Error('Cancelled');
                    if (status.exit_status !== 0 || status.term_signal)
                        throw new Error(`tar failed (exit ${status.exit_status ?? status.term_signal})\n${tail.trim()}`);
                }
                finally {
                    job.proc = null;
                }
                await tjs.remove(dir).catch(() => {});
                await tjs.rename(staging, dir);
            }
            catch (error) {
                await cleanup();
                throw error;
            }
            await tjs.remove(archive).catch(() => {});
            const lib = await findLibllama(null, data);
            if (!lib) throw new Error(`The download unpacked into ${dir}, but libllama was not found there. Use "Use an existing libllama".`);
            say(`Installed ${lib.path}`);
            return { lib: lib.path };
        });
    },

    listModels: async (_params, app) => listModelFiles(app),

    deleteModel: async ({ path }, app) => {
        const { models } = await listModelFiles(app);
        if (!models.some(model => model.path === path)) throw new Error('Only downloaded models can be deleted here.');
        await tjs.remove(path);
        return true;
    },

    // Downloads a GGUF into the app's models folder. `id` picks a catalog
    // entry (verified against its SHA-256), `url` is any https link to a .gguf.
    downloadModel: async ({ id, url }, app) => {
        const spec = resolveDownload({ id, url });
        const dir = await modelsDir(app);
        const out = joinPath(dir, spec.file);
        if (await exists(out)) {
            const size = (await tjs.stat(out)).size;
            if (!spec.size || size === spec.size) return { path: out, size, skipped: true };
            throw new Error(`${spec.file} already exists with a different size. Delete it first.`);
        }
        return startJob(app, 'download', async job => {
            const part = `${out}.part`;
            const res = await fetch(spec.url, { redirect: 'follow' });
            if (!res.ok)
                throw new Error(`Download failed: HTTP ${res.status}${[401, 403].includes(res.status) ? ' (this file may need a login)' : ''}`);
            const total = Number(res.headers.get('content-length')) || spec.size || 0;
            const reader = res.body.getReader();
            job.cancelFn = () => void reader.cancel().catch(() => {});
            const sha = createHash('sha256');
            const file = await tjs.open(part, 'w');
            let received = 0, lastPush = 0;
            try {
                for (;;) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    if (received === 0 && !(value.length >= 4 && dec.decode(value.subarray(0, 4)) === 'GGUF'))
                        throw new Error('That URL did not return a GGUF file.');
                    sha.update(value);
                    await file.write(value, received);
                    received += value.length;
                    const now = Date.now();
                    if (now - lastPush > 250) {
                        lastPush = now;
                        app.push('download', { received, total });
                    }
                }
                if (job.cancelled) throw new Error('Cancelled');
                if (total && received !== total) throw new Error(`Download ended early (${received} of ${total} bytes).`);
                await file.close();
                const digest = sha.digest();
                if (spec.sha256 && digest !== spec.sha256)
                    throw new Error('The downloaded file does not match its published SHA-256. It was deleted.');
                await tjs.rename(part, out);
                app.push('download', { received, total: received });
                return { path: out, size: received, sha256: digest, verified: !!spec.sha256 };
            }
            catch (error) {
                try {
                    await file.close();
                }
                catch { /* ignore */ }
                try {
                    await tjs.remove(part);
                }
                catch { /* ignore */ }
                throw error;
            }
        });
    },

    cancel: async () => {
        if (!current) return false;
        current.cancelled = true;
        try {
            current.cancelFn?.();
        }
        catch { /* ignore */ }
        try {
            current.proc?.kill();
        }
        catch { /* already gone */ }
        return true;
    }
};

export const init = () => {};

const
    ENGINE = 'llama-zip.js',
    // Version 2 headers hold hex, or base64 without padding in the ones written for a short while.
    // Version 3 headers are decoded to hex. toHex turns any of them into hex.
    toHex = hash => /^[0-9a-f]+$/.test(hash) && [16, 32, 64].includes(hash.length)
        ? hash
        : [...atob(hash)].map(char => char.charCodeAt(0).toString(16).padStart(2, '0')).join(''),
    FINGERPRINT_SPAN = 1024 * 1024,
    // Thread and batch size change llama.cpp's floating point results, so they are
    // fixed here and stored in the header. They match the defaults of llama-zip.js.
    DEFAULT_THREADS = 4,
    DEFAULT_BATCH = 512,
    // The diagram gets every step of a text job up to this many, and the first
    // FILE_STEPS of a file job. Bigger inputs run the same, only the page stops
    // recording.
    TEXT_STEPS = 1000,
    FILE_STEPS = 200,
    TEXT_LIMIT = 8 * 1024,
    CANCEL_GRACE_MS = 5000,
    enc = new TextEncoder(),
    dec = new TextDecoder(),
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

let current = null; // the running job, if any

// ---- small helpers ---------------------------------------------------------

const
    baseName = path => path.replace(/[\\/]+$/, '').split(/[\\/]/).pop(),
    dirName = path => {
        const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
        return i < 0 ? '.' : path.slice(0, i) || '/';
    },
    exists = async path => {
        try {
            await tjs.stat(path);
            return true;
        }
        catch {
            return false;
        }
    },
    uniquePath = async path => {
        if (!await exists(path)) return path;
        const dot = path.lastIndexOf('.');
        const hasExt = dot > Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1;
        const stem = hasExt ? path.slice(0, dot) : path;
        const ext = hasExt ? path.slice(dot) : '';
        for (let i = 1; i < 1000; i++) {
            const candidate = `${stem} (${i})${ext}`;
            if (!await exists(candidate)) return candidate;
        }
        throw new Error('Could not find a free output file name');
    },
    readExactly = async (file, length, offset) => {
        const buf = new Uint8Array(length);
        let got = 0;
        while (got < length) {
            const n = await file.read(buf.subarray(got), offset + got);
            if (n === null || n === 0) break;
            got += n;
        }
        return buf.subarray(0, got);
    },
    // Reads a stream to the end, calling onChunk for each piece.
    drain = async (stream, onChunk) => {
        const reader = stream.getReader();
        for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            await onChunk(value);
        }
    };

// Returns { version, meta, headerLen } for an .llmz file, or null for anything else.
const readHeader = async path => {
    const file = await tjs.open(path, 'r');
    try {
        const preamble = readPreamble(await readExactly(file, 16, 0));
        if (!preamble) return null;
        const { version, length, start } = preamble;
        const bytes = await readExactly(file, length, start);
        if (bytes.length < length) return null;
        return { version, meta: decodeHeader(version, bytes), headerLen: start + length };
    }
    catch {
        return null;
    }
    finally {
        await file.close();
    }
};

// magic, version, header length, header, then the coder's output
const writeContainer = async (part, out, meta, payload) => {
    const metaBytes = encodeHeader(meta);
    const file = await tjs.open(part, 'w');
    let pos = 0;
    try {
        for (const piece of [writePreamble(metaBytes.length), metaBytes, payload]) {
            await file.write(piece, pos);
            pos += piece.length;
        }
        await file.close();
        await tjs.rename(part, out);
        return pos;
    }
    catch (error) {
        try {
            await file.close();
        }
        catch { /* ignore */ }
        try {
            await tjs.remove(part);
        }
        catch { /* ignore */ }
        throw error;
    }
};

// The app's data folder. Asking for it also settles the CPU that the library lookup needs.
const dataDir = async app => {
    await useRuntimeArch(app);
    return (await app.paths()).data;
};

const prebuiltSpec = async app => {
    await useRuntimeArch(app);
    return PREBUILT[await platformKey()] ?? null;
};

const requireLibllama = async (chosen, app) => {
    const found = await findLibllama(chosen, await dataDir(app));
    if (!found) throw new Error('libllama was not found. See the setup instructions in the app.');
    return found;
};

// Cheap fingerprint: file size plus SHA-256 of the first and last 1 MiB.
// Enough to tell two different GGUF files apart without hashing gigabytes.
const modelFingerprint = async path => {
    const file = await tjs.open(path, 'r');
    try {
        const size = (await file.stat()).size;
        const hash = createHash('sha256');
        hash.update(await readExactly(file, Math.min(FINGERPRINT_SPAN, size), 0));
        if (size > FINGERPRINT_SPAN) {
            const tail = Math.min(FINGERPRINT_SPAN, size - FINGERPRINT_SPAN);
            hash.update(await readExactly(file, tail, size - tail));
        }
        return { name: baseName(path), size, sha256: hash.digest().slice(0, 32) };
    }
    finally {
        await file.close();
    }
};

// What differs between the machine that compressed and this one, for the
// error message of a failed decode.
const differences = async (meta, libPath, info) => {
    const lines = [];
    const stored = meta.llama || {};
    // The worker's answer comes from the library. A file name only says the version.
    const build = info?.llamaBuild ?? await libraryBuild(libPath);
    if (stored.build && build && !sameBuild(stored.build, build))
        lines.push(`The file was made with llama.cpp ${describeBuild(stored.build)}, this machine has llama.cpp ${describeBuild(build)}. ` +
            'Predictions can differ between llama.cpp versions, so the file may not decode here.');
    if (stored.system && info?.llamaSystem && stored.system !== info.llamaSystem)
        lines.push(`CPU features differ.\nThen: ${stored.system}\nNow: ${info.llamaSystem}`);
    // Version 3 files keep only a digest of the CPU feature string, so they cannot say what differs.
    else if (stored.systemDigest && info?.llamaSystem && stored.systemDigest !== createHash('sha256').update(info.llamaSystem).digest().slice(0, 8))
        lines.push('The CPU features differ from those of the machine that made the file.');
    return lines.join('\n');
};

// ---- model files -----------------------------------------------------------

const modelsDir = async app => {
    const dir = joinPath((await app.paths()).data, 'models');
    await tjs.makeDir(dir, { recursive: true });
    return dir;
};

const listModelFiles = async app => {
    const dir = await modelsDir(app);
    const models = [];
    for await (const entry of await tjs.readDir(dir)) {
        if (!/\.gguf$/i.test(entry.name)) continue;
        const path = joinPath(dir, entry.name);
        try {
            models.push({ name: entry.name, path, size: (await tjs.stat(path)).size });
        }
        catch { /* vanished */ }
    }
    models.sort((a, b) => a.name.localeCompare(b.name));
    return { dir, models };
};

// Turns a catalog id or a user-supplied URL into { url, file, sha256, size }.
const resolveDownload = ({ id, url }) => {
    if (id) {
        const model = MODELS.find(item => item.id === id);
        if (!model) throw new Error('Unknown model');
        return { url: model.url, file: model.file, sha256: model.sha256, size: model.size };
    }
    let parsed;
    try {
        parsed = new URL(String(url).trim());
    }
    catch {
        throw new Error('That is not a valid URL.');
    }
    if (parsed.protocol !== 'https:') throw new Error('Only https:// URLs are accepted.');
    // A Hugging Face "blob" page URL becomes the raw file URL.
    const blob = parsed.pathname.match(/^\/([^/]+\/[^/]+)\/blob\/(.+)$/);
    if (/(^|\.)huggingface\.co$/.test(parsed.hostname) && blob) parsed.pathname = `/${blob[1]}/resolve/${blob[2]}`;
    const last = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() || '');
    const file = last.replace(/[^\w.+() -]/g, '_').replace(/^\.+/, '');
    if (!/\.gguf$/i.test(file)) throw new Error('The URL must point to a .gguf file.');
    return { url: parsed.toString(), file, sha256: null, size: 0 };
};

// ---- the installer -----------------------------------------------------------

// LLMZIP_DRY_RUN_INSTALL=1 makes the install flow print the command it would
// run and simulate the output, without running brew or winget. Any value
// except empty, "0" or "false" turns it on.
const dryRunInstall = () => {
    const value = String(tjs.env.LLMZIP_DRY_RUN_INSTALL ?? '').trim().toLowerCase();
    return value !== '' && value !== '0' && value !== 'false';
};

// ---- the worker --------------------------------------------------------------

const stepOptions = (diagram, isText) => ({
    topK: diagram ? 16 : 0,
    maxSteps: !diagram ? 0 : isText ? TEXT_STEPS : FILE_STEPS
});

const workerUrl = () => new URL('./engine-worker.js', import.meta.url);

const reportProgress = (app, job, extra = {}) => app.push('job', {
    id: job.id,
    elapsed: Math.round((Date.now() - job.startedAt) / 1000),
    stage: job.stage,
    ...extra
});

// Runs engine-worker.js for one job. Resolves with { bytes, info }. Steps and
// progress go to the page while it runs. Cancelling asks the worker to abort
// through an AbortSignal, and the worker is terminated if it does not answer.
const runWorker = (app, job, request) => new Promise((resolve, reject) => {
    const worker = new Worker(workerUrl());
    let info = null, progress = {}, settled = false, graceTimer = null, generationStart = 0;
    const timer = setInterval(() => reportProgress(app, job, progress), 5000);
    const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearInterval(timer);
        clearTimeout(graceTimer);
        job.cancelFn = null;
        worker.terminate();
        fn(value);
    };
    job.cancelFn = () => {
        worker.postMessage({ type: 'cancel' });
        graceTimer = setTimeout(() => finish(reject, new Error('Cancelled')), CANCEL_GRACE_MS);
    };
    worker.onmessage = ({ data }) => {
        if (data.type === 'ready') {
            info = data.info;
            job.stage = request.mode === 'compress' ? 'Compressing' : 'Decompressing';
            generationStart = Date.now();
            progress = { tokens: 0, total: info.tokens, bytes: 0 };
            app.push('ready', { id: job.id, tokens: info.tokens, nCtx: info.nCtx, originalBytes: request.originalBytes });
            reportProgress(app, job, progress);
        }
        else if (data.type === 'steps')
            app.push('steps', { id: job.id, steps: data.steps });
        else if (data.type === 'progress') {
            const seconds = (Date.now() - generationStart) / 1000;
            progress = { tokens: data.tokens, total: data.total, bytes: data.bytes, bps: seconds > 0.5 ? Math.round(data.bytes / seconds) : null };
            reportProgress(app, job, progress);
        }
        else if (data.type === 'result')
            finish(resolve, { bytes: data.bytes, info });
        else if (data.type === 'error')
            finish(reject, new Error(job.cancelled ? 'Cancelled' : data.message));
    };
    worker.onerror = event => finish(reject, new Error(job.cancelled ? 'Cancelled' : `The compression worker failed: ${event?.message ?? event}`));
    worker.postMessage({ type: 'start', ...request });
});

// ---- jobs --------------------------------------------------------------------

const startJob = async (app, kind, run) => {
    if (current) throw new Error('Another job is already running');
    const job = { id: Date.now().toString(36), kind, startedAt: Date.now(), cancelled: false, stage: 'starting' };
    current = job;
    try {
        const result = await run(job);
        return { id: job.id, seconds: (Date.now() - job.startedAt) / 1000, ...result };
    }
    finally {
        current = null;
    }
};
