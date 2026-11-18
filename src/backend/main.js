// LLM Zip backend (txiki.js).
//
// The backend never does the compression itself. It finds the `llama-zip`
// command line tool, feeds it a file, and wraps the result in a small
// container (".llmz") that records everything the decoder needs to
// reproduce the encoder's predictions: model fingerprint, context length,
// window overlap, GPU layers, plus the original size and SHA-256.
import { createHash } from 'tjs:hashing';
import { MODELS } from '../shared/models.js';

const MAGIC = new Uint8Array([0x4c, 0x4c, 0x4d, 0x5a]); // "LLMZ"
const FORMAT_VERSION = 1;
const CHUNK = 64 * 1024;
const FINGERPRINT_SPAN = 1024 * 1024;

const IS_WIN = /\.exe$/i.test(tjs.exePath) || tjs.exePath.includes('\\');
const SEP = IS_WIN ? ';' : ':';
const enc = new TextEncoder();
const dec = new TextDecoder();

let current = null; // the running job, if any

// ---- small helpers ---------------------------------------------------------

const baseName = (p) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
const dirName = (p) => {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i < 0 ? '.' : p.slice(0, i) || '/';
};
const joinPath = (dir, name) => dir.replace(/[\\/]+$/, '') + '/' + name;

async function exists(path) {
  try { await tjs.stat(path); return true; } catch { return false; }
}

async function uniquePath(path) {
  if (!(await exists(path))) return path;
  const dot = path.lastIndexOf('.');
  const hasExt = dot > Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1;
  const stem = hasExt ? path.slice(0, dot) : path;
  const ext = hasExt ? path.slice(dot) : '';
  for (let i = 1; i < 1000; i++) {
    const candidate = `${stem} (${i})${ext}`;
    if (!(await exists(candidate))) return candidate;
  }
  throw new Error('Could not find a free output file name');
}

function u32le(n) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
}

async function readExactly(file, length, offset) {
  const buf = new Uint8Array(length);
  let got = 0;
  while (got < length) {
    const n = await file.read(buf.subarray(got), offset + got);
    if (n === null || n === 0) break;
    got += n;
  }
  return buf.subarray(0, got);
}

// Returns { meta, headerLen } for an .llmz file, or null for anything else.
async function readHeader(path) {
  const file = await tjs.open(path, 'r');
  try {
    const head = await readExactly(file, 9, 0);
    if (head.length < 9 || MAGIC.some((b, i) => head[i] !== b)) return null;
    const len = new DataView(head.buffer, head.byteOffset).getUint32(5, true);
    const meta = JSON.parse(dec.decode(await readExactly(file, len, 9)));
    return { meta, headerLen: 9 + len };
  } catch {
    return null;
  } finally {
    await file.close();
  }
}

// ---- engine discovery ------------------------------------------------------

// A .app started from Finder gets a bare PATH, so also look where pip, pipx
// and Homebrew put console scripts.
function searchDirs() {
  const home = tjs.homeDir;
  const dirs = (tjs.env.PATH || '').split(SEP).filter(Boolean);
  if (IS_WIN) {
    const appData = tjs.env.APPDATA;
    const local = tjs.env.LOCALAPPDATA;
    dirs.push(`${home}\\.local\\bin`);
    if (appData) dirs.push(`${appData}\\Python\\Scripts`);
    if (local) dirs.push(`${local}\\Programs\\Python\\Scripts`);
  } else {
    dirs.push(`${home}/.local/bin`, '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin');
  }
  return [...new Set(dirs)];
}

async function findEngine(override) {
  if (override && (await exists(override))) return override;
  const names = IS_WIN ? ['llama-zip.exe', 'llama-zip.cmd', 'llama-zip'] : ['llama-zip'];
  for (const dir of searchDirs()) {
    for (const name of names) {
      const candidate = joinPath(dir, name);
      if (await exists(candidate)) return candidate;
    }
  }
  return null;
}

// Cheap fingerprint: file size plus SHA-256 of the first and last 1 MiB.
// Enough to tell two different GGUF files apart without hashing gigabytes.
async function modelFingerprint(path) {
  const file = await tjs.open(path, 'r');
  try {
    const size = (await file.stat()).size;
    const h = createHash('sha256');
    h.update(await readExactly(file, Math.min(FINGERPRINT_SPAN, size), 0));
    if (size > FINGERPRINT_SPAN) {
      const tail = Math.min(FINGERPRINT_SPAN, size - FINGERPRINT_SPAN);
      h.update(await readExactly(file, tail, size - tail));
    }
    return { name: baseName(path), size, sha256: h.digest().slice(0, 32) };
  } finally {
    await file.close();
  }
}

// ---- installers (uv / pipx) ------------------------------------------------

const ENGINE_REPO = 'git+https://github.com/alexbuz/llama-zip.git';

async function findTool(name) {
  const names = IS_WIN ? [`${name}.exe`, `${name}.cmd`] : [name];
  const dirs = [...searchDirs(), joinPath(tjs.homeDir, '.cargo/bin')];
  for (const dir of dirs) {
    for (const n of names) {
      const candidate = joinPath(dir, n);
      if (await exists(candidate)) return candidate;
    }
  }
  return null;
}

// Child processes get the widened PATH so uv and pipx can find git and Python
// even when the app was started from Finder.
function toolEnv() {
  const env = Object.assign({}, tjs.env);
  for (const k of Object.keys(env)) if (/^path$/i.test(k)) delete env[k];
  env.PATH = searchDirs().join(SEP);
  return env;
}

async function capture(args) {
  try {
    const proc = tjs.spawn(args, { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore', env: toolEnv() });
    const text = await proc.stdout.text();
    const status = await proc.wait();
    return status.exit_status === 0 ? text.trim() : null;
  } catch {
    return null;
  }
}

// ---- model files -----------------------------------------------------------

async function modelsDir(app) {
  const dir = joinPath((await app.paths()).data, 'models');
  await tjs.makeDir(dir, { recursive: true });
  return dir;
}

async function listModelFiles(app) {
  const dir = await modelsDir(app);
  const models = [];
  for await (const e of await tjs.readDir(dir)) {
    if (!/\.gguf$/i.test(e.name)) continue;
    const path = joinPath(dir, e.name);
    try { models.push({ name: e.name, path, size: (await tjs.stat(path)).size }); } catch { /* vanished */ }
  }
  models.sort((a, b) => a.name.localeCompare(b.name));
  return { dir, models };
}

// Turns a catalog id or a user-supplied URL into { url, file, sha256, size }.
function resolveDownload({ id, url }) {
  if (id) {
    const m = MODELS.find((x) => x.id === id);
    if (!m) throw new Error('Unknown model');
    return { url: m.url, file: m.file, sha256: m.sha256, size: m.size };
  }
  let u;
  try { u = new URL(String(url).trim()); } catch { throw new Error('That is not a valid URL.'); }
  if (u.protocol !== 'https:') throw new Error('Only https:// URLs are accepted.');
  // A Hugging Face "blob" page URL becomes the raw file URL.
  const blob = u.pathname.match(/^\/([^/]+\/[^/]+)\/blob\/(.+)$/);
  if (/(^|\.)huggingface\.co$/.test(u.hostname) && blob) u.pathname = `/${blob[1]}/resolve/${blob[2]}`;
  const last = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '');
  const file = last.replace(/[^\w.+() -]/g, '_').replace(/^\.+/, '');
  if (!/\.gguf$/i.test(file)) throw new Error('The URL must point to a .gguf file.');
  return { url: u.toString(), file, sha256: null, size: 0 };
}

// ---- the engine process ----------------------------------------------------

function engineArgs(exe, model, mode, o) {
  const args = [exe, model, mode === 'compress' ? '-c' : '-d'];
  args.push('--n-ctx', String(o.nCtx ?? 0));
  args.push('-w', String(o.overlap ?? '0%'));
  args.push('--n-gpu-layers', String(o.gpuLayers ?? 0));
  return args;
}

function reportProgress(app, job, extra = {}) {
  app.push('job', {
    id: job.id,
    elapsed: Math.round((Date.now() - job.startedAt) / 1000),
    ...extra,
  });
}

// Reads a stream to the end, calling onChunk for each piece.
async function drain(stream, onChunk) {
  const reader = stream.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    await onChunk(value);
  }
}

// Runs llama-zip: pipes `feed` into stdin and `onOut` receives stdout bytes.
async function runEngine(app, job, args, feed, onOut) {
  const proc = tjs.spawn(args, { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  job.proc = proc;
  let stderrTail = '';
  let stderrAll = '';
  const timer = setInterval(() => reportProgress(app, job, { stage: job.stage }), 1000);
  try {
    const errDone = drain(proc.stderr, (chunk) => {
      const text = dec.decode(chunk);
      stderrTail = (stderrTail + text).slice(-4000);
      if (stderrAll.length < 200000) stderrAll += text;
      // tqdm prints "  42%|" when the engine runs verbose
      const m = [...text.matchAll(/(\d{1,3})%\|/g)].pop();
      if (m) reportProgress(app, job, { stage: job.stage, percent: Math.min(100, +m[1]) });
    });
    const outDone = drain(proc.stdout, onOut);
    const writer = proc.stdin.getWriter();
    try {
      await feed(writer);
    } catch (e) {
      // the engine may exit early (bad model path); its stderr says why
      if (!job.cancelled) job.feedError = e;
    }
    try { await writer.close(); } catch { /* already closed */ }
    await Promise.all([outDone, errDone]);
    const status = await proc.wait();
    if (job.cancelled) throw new Error('Cancelled');
    // llama-zip can exit 0 after a swallowed Python exception (for example NaN
    // logits from a broken GPU backend), leaving garbage output.
    const swallowed = /Traceback \(most recent call last\)/.test(stderrAll);
    if (status.exit_status !== 0 || status.term_signal || swallowed) {
      const lines = stderrTail.replace(/\r/g, '\n').split('\n').map((l) => l.trim()).filter((l) => l && !/\d+%\|/.test(l));
      const hint = /NaN/.test(stderrAll) ? '\nThis usually means GPU offload is broken on this machine. Set GPU layers to 0.' : '';
      throw new Error(`llama-zip failed (exit ${status.exit_status ?? status.term_signal})\n${lines.slice(-5).join('\n')}${hint}`);
    }
  } finally {
    clearInterval(timer);
    job.proc = null;
  }
}

// ---- API -------------------------------------------------------------------

async function startJob(app, kind, run) {
  if (current) throw new Error('Another job is already running');
  const job = { id: Date.now().toString(36), kind, startedAt: Date.now(), cancelled: false, stage: 'starting' };
  current = job;
  try {
    const result = await run(job);
    return { id: job.id, seconds: (Date.now() - job.startedAt) / 1000, ...result };
  } finally {
    current = null;
  }
}

export const api = {
  async status({ engine, model }) {
    const exe = await findEngine(engine);
    return {
      platform: IS_WIN ? 'windows' : 'unix',
      engine: exe,
      model: model && (await exists(model)) ? await modelFingerprint(model) : null,
    };
  },

  async inspect({ path }) {
    const header = await readHeader(path);
    return header ? { llmz: true, meta: header.meta } : { llmz: false };
  },

  // Compresses a file (`input`) or typed text (`text`, which needs an `output`
  // path). With `overwrite`, an existing `output` is replaced, not renamed.
  async compress({ input, text, name, output, overwrite = false, model, engine, nCtx = 0, overlap = '0%', gpuLayers = 0 }, app) {
    const exe = await findEngine(engine);
    if (!exe) throw new Error('llama-zip was not found. See the setup instructions in the app.');
    if (!model || !(await exists(model))) throw new Error('Choose a model (.gguf file) first.');
    const textBytes = typeof text === 'string' ? enc.encode(text) : null;
    if (textBytes && !textBytes.length) throw new Error('Type or paste some text first.');
    if (textBytes && !output) throw new Error('Choose where to save the compressed text.');
    if (!textBytes && !input) throw new Error('No input.');

    return startJob(app, 'compress', async (job) => {
      const out = overwrite && output ? output : await uniquePath(output || input + '.llmz');
      const part = out + '.part';
      const inputSize = textBytes ? textBytes.length : (await tjs.stat(input)).size;
      const fingerprint = await modelFingerprint(model);

      // Hash while the engine reads the file, so the header can carry the
      // checksum of the original without a second pass.
      const sha = createHash('sha256');
      const outFile = await tjs.open(part, 'w');
      const chunks = [];
      job.stage = 'compressing';
      try {
        await runEngine(
          app, job, engineArgs(exe, model, 'compress', { nCtx, overlap, gpuLayers }),
          async (stdin) => {
            if (textBytes) {
              sha.update(textBytes);
              for (let i = 0; i < textBytes.length; i += CHUNK) await stdin.write(textBytes.subarray(i, i + CHUNK));
              return;
            }
            const f = await tjs.open(input, 'r');
            try {
              const buf = new Uint8Array(CHUNK);
              for (let pos = 0; ; ) {
                const n = await f.read(buf, pos);
                if (n === null || n === 0) break;
                const piece = buf.slice(0, n);
                sha.update(piece);
                await stdin.write(piece);
                pos += n;
              }
            } finally {
              await f.close();
            }
          },
          (chunk) => { chunks.push(chunk.slice()); },
        );

        const payloadSize = chunks.reduce((s, c) => s + c.length, 0);
        const meta = {
          v: FORMAT_VERSION,
          name: textBytes ? (baseName(name || 'text.txt')) : baseName(input),
          size: inputSize,
          sha256: sha.digest(),
          model: fingerprint,
          params: { nCtx, overlap, gpuLayers },
        };
        const metaBytes = enc.encode(JSON.stringify(meta));
        let pos = 0;
        for (const piece of [MAGIC, new Uint8Array([FORMAT_VERSION]), u32le(metaBytes.length), metaBytes, ...chunks]) {
          await outFile.write(piece, pos);
          pos += piece.length;
        }
        await outFile.close();
        await tjs.rename(part, out);
        return { output: out, inputSize, outputSize: pos, payloadSize };
      } catch (e) {
        try { await outFile.close(); } catch { /* ignore */ }
        try { await tjs.remove(part); } catch { /* ignore */ }
        throw e;
      }
    });
  },

  async decompress({ input, output, model, engine, force = false }, app) {
    const exe = await findEngine(engine);
    if (!exe) throw new Error('llama-zip was not found. See the setup instructions in the app.');
    const header = await readHeader(input);
    if (!header) throw new Error('This is not an .llmz file.');
    const { meta, headerLen } = header;
    if (meta.v > FORMAT_VERSION) throw new Error('This file needs a newer version of LLM Zip.');
    if (!model || !(await exists(model))) {
      const err = new Error(`Choose the model this file was made with: ${meta.model.name}`);
      err.code = 'MODEL_MISSING';
      throw err;
    }
    const fingerprint = await modelFingerprint(model);
    if (!force && (fingerprint.sha256 !== meta.model.sha256 || fingerprint.size !== meta.model.size)) {
      const err = new Error(
        `The selected model (${fingerprint.name}) differs from the one used to compress this file (${meta.model.name}). ` +
        'Decompressing with another model produces garbage or fails.',
      );
      err.code = 'MODEL_MISMATCH';
      throw err;
    }

    return startJob(app, 'decompress', async (job) => {
      const out = await uniquePath(output || joinPath(dirName(input), meta.name));
      const part = out + '.part';
      const sha = createHash('sha256');
      const outFile = await tjs.open(part, 'w');
      let written = 0;
      job.stage = 'decompressing';
      try {
        await runEngine(
          app, job, engineArgs(exe, model, 'decompress', meta.params),
          async (stdin) => {
            const f = await tjs.open(input, 'r');
            try {
              const buf = new Uint8Array(CHUNK);
              for (let pos = headerLen; ; ) {
                const n = await f.read(buf, pos);
                if (n === null || n === 0) break;
                await stdin.write(buf.slice(0, n));
                pos += n;
              }
            } finally {
              await f.close();
            }
          },
          async (chunk) => {
            sha.update(chunk);
            await outFile.write(chunk, written);
            written += chunk.length;
          },
        );
        await outFile.close();
        const digest = sha.digest();
        if (written !== meta.size || digest !== meta.sha256) {
          throw new Error(
            'The decompressed data does not match the original checksum. ' +
            'llama.cpp can give different predictions on different hardware, drivers, or GPU settings, ' +
            'so this file may only decompress on the machine that created it.',
          );
        }
        await tjs.rename(part, out);
        return { output: out, inputSize: (await tjs.stat(input)).size, outputSize: written, verified: true };
      } catch (e) {
        try { await outFile.close(); } catch { /* ignore */ }
        try { await tjs.remove(part); } catch { /* ignore */ }
        throw e;
      }
    });
  },

  async installers() {
    return { uv: await findTool('uv'), pipx: await findTool('pipx'), git: !!(await findTool('git')), windows: IS_WIN };
  },

  // Installs llama-zip with `uv tool install` or `pipx install`. The package
  // compiles llama.cpp, so this can take many minutes. Output streams to the
  // page as 'install' events.
  async installEngine({ tool }, app) {
    if (tool !== 'uv' && tool !== 'pipx') throw new Error('Choose uv or pipx.');
    const exe = await findTool(tool);
    if (!exe) throw new Error(`${tool} was not found on this machine.`);
    return startJob(app, 'install', async (job) => {
      job.stage = 'installing';
      const args = tool === 'uv'
        ? [exe, 'tool', 'install', '--force', ENGINE_REPO]
        : [exe, 'install', '--force', ENGINE_REPO];
      app.push('install', { text: `$ ${args.join(' ')}\n` });
      const proc = tjs.spawn(args, { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: toolEnv() });
      job.proc = proc;
      let tail = '';
      const pump = (stream) => {
        const d = new TextDecoder();
        return drain(stream, (chunk) => {
          const text = d.decode(chunk, { stream: true });
          tail = (tail + text).slice(-3000);
          app.push('install', { text });
        });
      };
      try {
        await Promise.all([pump(proc.stdout), pump(proc.stderr)]);
        const status = await proc.wait();
        if (job.cancelled) throw new Error('Cancelled');
        if (status.exit_status !== 0 || status.term_signal) {
          const lines = tail.replace(/\r/g, '\n').split('\n').map((l) => l.trim()).filter(Boolean).slice(-6);
          throw new Error(`${tool} failed (exit ${status.exit_status ?? status.term_signal})\n${lines.join('\n')}`);
        }
      } finally {
        job.proc = null;
      }
      let engine = await findEngine(null);
      if (!engine) {
        const binDir = tool === 'uv'
          ? await capture([exe, 'tool', 'dir', '--bin'])
          : await capture([exe, 'environment', '--value', 'PIPX_BIN_DIR']);
        if (binDir) engine = await findEngine(joinPath(binDir, IS_WIN ? 'llama-zip.exe' : 'llama-zip'));
      }
      if (!engine) {
        throw new Error(
          `${tool} finished, but llama-zip is not on your PATH. ` +
          `Run \`${tool === 'uv' ? 'uv tool update-shell' : 'pipx ensurepath'}\`, restart the app, or use "Choose existing llama-zip".`,
        );
      }
      return { engine };
    });
  },

  async listModels(_params, app) {
    return listModelFiles(app);
  },

  async deleteModel({ path }, app) {
    const { models } = await listModelFiles(app);
    if (!models.some((m) => m.path === path)) throw new Error('Only downloaded models can be deleted here.');
    await tjs.remove(path);
    return true;
  },

  // Downloads a GGUF into the app's models folder. `id` picks a catalog
  // entry (verified against its SHA-256); `url` is any https link to a .gguf.
  async downloadModel({ id, url }, app) {
    const spec = resolveDownload({ id, url });
    const dir = await modelsDir(app);
    const out = joinPath(dir, spec.file);
    if (await exists(out)) {
      const size = (await tjs.stat(out)).size;
      if (!spec.size || size === spec.size) return { path: out, size, skipped: true };
      throw new Error(`${spec.file} already exists with a different size. Delete it first.`);
    }
    return startJob(app, 'download', async (job) => {
      const part = out + '.part';
      const res = await fetch(spec.url, { redirect: 'follow' });
      if (!res.ok) {
        throw new Error(`Download failed: HTTP ${res.status}${res.status === 401 || res.status === 403 ? ' (this file may need a login)' : ''}`);
      }
      const total = Number(res.headers.get('content-length')) || spec.size || 0;
      const reader = res.body.getReader();
      job.cancelFn = () => { reader.cancel().catch(() => {}); };
      const sha = createHash('sha256');
      const file = await tjs.open(part, 'w');
      let received = 0;
      let lastPush = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (received === 0 && !(value.length >= 4 && dec.decode(value.subarray(0, 4)) === 'GGUF')) {
            throw new Error('That URL did not return a GGUF file.');
          }
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
        if (spec.sha256 && digest !== spec.sha256) {
          throw new Error('The downloaded file does not match its published SHA-256. It was deleted.');
        }
        await tjs.rename(part, out);
        app.push('download', { received, total: received });
        return { path: out, size: received, sha256: digest, verified: !!spec.sha256 };
      } catch (e) {
        try { await file.close(); } catch { /* ignore */ }
        try { await tjs.remove(part); } catch { /* ignore */ }
        throw e;
      }
    });
  },

  async cancel() {
    if (!current) return false;
    current.cancelled = true;
    try { current.cancelFn?.(); } catch { /* ignore */ }
    try { current.proc?.kill(); } catch { /* already gone */ }
    return true;
  },
};

export function init() {}
