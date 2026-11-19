import { TESTED_TEXT } from '../shared/llama.js';
import { MODELS } from '../shared/models.js';

import { createDiagram } from './diagram.js';

const
    $ = id => document.getElementById(id),
    // Escape anything that goes into innerHTML. File names are untrusted and
    // this page holds an RPC channel to the backend.
    esc = text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c])),
    base = path => path.split(/[\\/]/).pop(),
    fmtBytes = n => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB`
                  : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(2)} GB`,
    fmtTime = s => s < 60 ? `${s.toFixed(s < 10 ? 1 : 0)} s` : `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`,
    byteLength = text => new TextEncoder().encode(text).length,
    errorText = error => String(error && error.message ? error.message : error),
    // Jobs that keep their recorded steps for "Replay diagram".
    KEPT_RECORDINGS = 4;

const state = {
    lib: null, libPath: null, model: null, modelPath: null,
    installers: { tool: 'brew', exe: null }, installing: null,
    models: [], exclusive: null, // 'install' | 'download' while one runs
    queue: [], busy: false, jobs: new Map(),
    diagramOpen: true, diagramShown: null
};

const diagram = createDiagram($('diagram'));

// ---- setup / model ---------------------------------------------------------

const loadSettings = async () => {
    state.libPath = await tiny.store.get('libPath') || null;
    state.modelPath = await tiny.store.get('modelPath') || null;
    state.tab = await tiny.store.get('tab') === 'text' ? 'text' : 'file';
    state.diagramOpen = await tiny.store.get('diagramOpen') !== false;
    $('diagramPanel').open = state.diagramOpen;
    const adv = await tiny.store.get('advanced') || {};
    if (adv.nCtx != null) $('nCtx').value = adv.nCtx;
    if (adv.overlap) $('overlap').value = adv.overlap;
    if (adv.gpuLayers != null) $('gpuLayers').value = adv.gpuLayers;
    $('diagramFiles').checked = !!adv.diagramFiles;
};

// What the backend needs to pick the right prebuilt libllama. The backend cannot tell the CPU.
let systemCache = null;
const systemInfo = async () => systemCache ??= { os: tiny.system.os(), arch: await tiny.system.architecture() };

const refreshStatus = async () => {
    const [status, lib, installers] = await Promise.all([
        tiny.api.call('status', { lib: state.libPath, model: state.modelPath }),
        tiny.api.call('listModels'),
        tiny.api.call('installers', await systemInfo())
    ]);
    state.lib = status.lib;
    state.model = status.model;
    state.models = lib.models;
    state.installers = installers;
    renderSetup();
    renderModel();
    renderCatalog();
    updateControls();
};

const renderSetup = () => {
    $('setup').hidden = !!state.lib;
    const { tool, exe, guide, dryRun } = state.installers;
    const name = tool === 'winget' ? 'winget' : 'Homebrew';
    const button = $('installTool');
    button.dataset.tool = tool;
    button.title = exe || `${name} was not found on this machine`;
    $('setupHow').textContent = tool === 'winget'
        ? `winget downloads a prebuilt package (ggml.llamacpp), no compiler needed. It installs the latest release, which can be newer than llama.cpp ${TESTED_TEXT}, the version LLM Zip was tested with. A newer version is refused until LLM Zip is updated.`
        : `Homebrew normally downloads a prebuilt package (llama.cpp), so the install takes a minute or two. LLM Zip was tested with llama.cpp ${TESTED_TEXT}.`;
    $('dryNote').hidden = !dryRun;
    const { prebuilt } = state.installers;
    $('installPrebuilt').hidden = !prebuilt;
    if (prebuilt)
        $('setupHow').textContent += ` "From GitHub" skips the package manager and compiling: it downloads the llama.cpp ${prebuilt.tag} release (${fmtBytes(prebuilt.size)}), checks its SHA-256 and unpacks it into the app's data folder.`;
    const hint = $('noInstaller');
    hint.hidden = !!exe || !!dryRun;
    hint.innerHTML = `${esc(name)} was not found. ${prebuilt ? 'Use the prebuilt download, or install' : 'Install'} ${esc(name)}, then choose "Check again". <a href="#" id="installGuide">How to install ${esc(name)}</a>`;
    const link = $('installGuide');
    if (link) link.addEventListener('click', event => {
        event.preventDefault();
        tiny.app.shell.open(guide);
    });
};

const renderModel = () => {
    const select = $('modelSelect');
    const options = state.models.map(m => `<option value="${esc(m.path)}">${esc(m.name)} (${fmtBytes(m.size)})</option>`);
    const external = state.modelPath && !state.models.some(m => m.path === state.modelPath);
    if (external) options.unshift(`<option value="${esc(state.modelPath)}">${esc(base(state.modelPath))} (chosen file)</option>`);
    if (!state.modelPath) options.unshift('<option value="">No model selected</option>');
    select.innerHTML = options.join('');
    select.value = state.modelPath || '';
    $('modelInfo').textContent = state.model
        ? `${base(state.modelPath)}, ${fmtBytes(state.model.size)}. Decompression needs this exact file.`
        : 'Download a model or choose a .gguf file. Decompression needs the exact same model file.';
};

const renderCatalog = () => {
    $('catalog').innerHTML = MODELS.map(m => {
        const have = state.models.find(x => x.name === m.file && x.size === m.size);
        const action = have
            ? `<button data-act="use" data-id="${esc(m.id)}">Use</button><button data-act="del" data-id="${esc(m.id)}">Delete</button>`
            : `<button data-act="get" data-id="${esc(m.id)}" ${state.exclusive ? 'disabled' : ''}>Download</button>`;
        return `<li class="cat"><div><strong>${esc(m.name)}</strong> <span class="muted">${esc(m.quant)} · ${fmtBytes(m.size)}${have ? ' · downloaded' : ''}</span>
      <div class="muted small">${esc(m.note)}</div></div><div class="actions">${action}</div></li>`;
    }).join('');
};

const updateControls = () => {
    const busy = !!state.exclusive;
    const button = $('installTool');
    const tool = button.dataset.tool;
    const name = tool === 'winget' ? 'winget' : 'Homebrew';
    button.disabled = busy || !(state.installers.exe || state.installers.dryRun);
    button.textContent = state.installing === tool ? `installing with ${name}…` : `using ${name}`;
    const prebuilt = $('installPrebuilt');
    prebuilt.disabled = busy;
    prebuilt.textContent = state.installing === 'prebuilt' ? 'downloading…' : 'from GitHub';
    $('cancelInstall').hidden = state.exclusive !== 'install';
    $('dlUrlGo').disabled = busy;
    for (const b of $('catalog').querySelectorAll('button[data-act=get]'))
        b.disabled = busy;
};

const selectModel = async path => {
    state.modelPath = path || null;
    await tiny.store.set('modelPath', state.modelPath);
    await refreshStatus();
};

const advanced = () => ({
    nCtx: Math.max(0, parseInt($('nCtx').value, 10) || 0),
    overlap: $('overlap').value.trim() || '0%',
    gpuLayers: parseInt($('gpuLayers').value, 10)
});

for (const id of ['nCtx', 'overlap', 'gpuLayers', 'diagramFiles'])
    $(id).addEventListener('change', () => tiny.store.set('advanced', {
        nCtx: $('nCtx').value, overlap: $('overlap').value, gpuLayers: $('gpuLayers').value, diagramFiles: $('diagramFiles').checked
    }));

$('modelSelect').addEventListener('change', event => selectModel(event.target.value));
$('pickModel').addEventListener('click', async () => {
    const path = await tiny.dialog.openFile({ types: ['gguf'] });
    if (path) await selectModel(path);
});
$('pickLib').addEventListener('click', async () => {
    const path = await tiny.dialog.openFile();
    if (!path) return;
    state.libPath = path;
    await tiny.store.set('libPath', path);
    await refreshStatus();
});
$('recheck').addEventListener('click', refreshStatus);

// ---- install libllama --------------------------------------------------------

let installLog = '';
tiny.api.on('install', ({ text }) => {
    installLog = (installLog + text).replace(/\r(?!\n)/g, '\n').slice(-6000);
    const pre = $('installLog');
    pre.hidden = false;
    pre.textContent = installLog;
    pre.scrollTop = pre.scrollHeight;
});

const install = async (event, prebuilt = false) => {
    const tool = prebuilt ? 'prebuilt' : $('installTool').dataset.tool;
    if (state.exclusive || (!prebuilt && !(state.installers.exe || state.installers.dryRun))) return;
    state.exclusive = 'install';
    state.installing = tool;
    installLog = '';
    $('installErr').textContent = '';
    updateControls();
    try {
        await (prebuilt ? tiny.api.call('installPrebuilt', await systemInfo()) : tiny.api.call('installLibllama', { tool }));
    }
    catch (error) {
        const message = errorText(error);
        $('installErr').textContent = message === 'Cancelled' ? 'Install cancelled.' : message;
    }
    state.exclusive = null;
    state.installing = null;
    await refreshStatus();
};
$('installTool').addEventListener('click', install);
$('installPrebuilt').addEventListener('click', event => install(event, true));
$('cancelInstall').addEventListener('click', () => tiny.api.call('cancel'));

// ---- download models --------------------------------------------------------

$('toggleDl').addEventListener('click', () => {
    $('dlPanel').hidden = !$('dlPanel').hidden;
});

tiny.api.on('download', ({ received, total }) => {
    const pct = total ? Math.min(100, received / total * 100) : null;
    $('dlText').textContent = total
        ? `${fmtBytes(received)} of ${fmtBytes(total)} · ${pct.toFixed(0)}%`
        : fmtBytes(received);
    const bar = $('dlBar');
    bar.className = pct == null ? '' : 'det';
    bar.style.width = pct == null ? '' : `${pct}%`;
});

const download = async (params, label) => {
    if (state.exclusive) return;
    state.exclusive = 'download';
    $('dlErr').textContent = '';
    $('dlProgress').hidden = false;
    $('dlText').textContent = `Starting ${label}…`;
    $('dlBar').style.width = '0';
    updateControls();
    try {
        const result = await tiny.api.call('downloadModel', params);
        state.modelPath = result.path;
        await tiny.store.set('modelPath', result.path);
        if (params.url) $('dlUrl').value = '';
    }
    catch (error) {
        const message = errorText(error);
        $('dlErr').textContent = message === 'Cancelled' ? 'Download cancelled.' : message;
    }
    state.exclusive = null;
    $('dlProgress').hidden = true;
    await refreshStatus();
};

$('catalog').addEventListener('click', async event => {
    const button = event.target.closest('button[data-act]');
    if (!button) return;
    const model = MODELS.find(x => x.id === button.dataset.id);
    const have = state.models.find(x => x.name === model.file);
    if (button.dataset.act === 'get') await download({ id: model.id }, model.name);
    if (button.dataset.act === 'use' && have) await selectModel(have.path);
    if (button.dataset.act === 'del' && have) {
        const ok = await tiny.dialog.confirm(`Delete ${model.name}?`, {
            detail: 'Files compressed with this model cannot be decompressed until you download it again.'
        });
        if (!ok) return;
        await tiny.api.call('deleteModel', { path: have.path });
        if (state.modelPath === have.path) await selectModel(null);
        else await refreshStatus();
    }
});
$('dlUrlGo').addEventListener('click', () => {
    const url = $('dlUrl').value.trim();
    if (url) download({ url }, 'model');
});
$('dlUrl').addEventListener('keydown', event => {
    if (event.key === 'Enter') $('dlUrlGo').click();
});
$('cancelDl').addEventListener('click', () => tiny.api.call('cancel'));

// ---- the diagram -------------------------------------------------------------

$('diagramPanel').addEventListener('toggle', () => {
    state.diagramOpen = $('diagramPanel').open;
    tiny.store.set('diagramOpen', state.diagramOpen);
});

// Steps are only recorded when the diagram was requested for the job, and
// only the newest few jobs keep them.
const wantsDiagram = job => job.text != null || job.trace ? state.diagramOpen : $('diagramFiles').checked;

const trimRecordings = () => {
    const kept = [...state.jobs.values()].filter(job => job.steps?.length).slice(-KEPT_RECORDINGS);
    for (const job of state.jobs.values())
        if (job.steps && !kept.includes(job)) job.steps = null;
};

const showDiagram = (job, { live, originalBytes }) => {
    state.diagramShown = job;
    $('diagramCard').hidden = false;
    $('diagramPanel').open = true;
    $('diagramTitle').textContent = `Diagram: ${job.label || base(job.path)}`;
    if (live) diagram.reset({ originalBytes: originalBytes || 0 });
    else diagram.load(job.steps, { total: job.total || job.steps.length, originalBytes: job.originalBytes || 0 });
};

const runningJob = () => [...state.jobs.values()].find(job => job.status === 'running');

tiny.api.on('ready', ({ tokens, originalBytes }) => {
    const job = runningJob();
    if (!job) return;
    job.total = tokens;
    job.originalBytes = originalBytes;
    if (job.diagram) {
        showDiagram(job, { live: true, originalBytes });
        diagram.setTotal(tokens);
    }
});

tiny.api.on('steps', ({ steps }) => {
    const job = runningJob();
    if (!job || !job.diagram) return;
    job.steps.push(...steps);
    if (state.diagramShown === job) diagram.push(steps);
});

// ---- jobs ------------------------------------------------------------------

const enqueue = job => {
    state.jobs.set(job.key, job);
    state.queue.push(job);
    render();
    pump();
};

const addFiles = paths => {
    for (const path of paths)
        enqueue({ key: Math.random().toString(36).slice(2), path, status: 'queued' });
};

const pump = async () => {
    if (state.busy) return;
    state.busy = true;
    while (state.queue.length) {
        while (state.exclusive) await new Promise(resolve => setTimeout(resolve, 300));
        await runJob(state.queue.shift());
    }
    state.busy = false;
};

const runJob = async job => {
    job.model = state.modelPath ? base(state.modelPath) : null;
    Object.assign(job, { status: 'running', percent: null, error: null, tokens: 0, total: 0, bps: null, steps: [], diagram: false, lzma: null, startedAt: Date.now() });
    render();
    try {
        if (!state.lib) throw new Error('libllama is not installed. Use the install box above.');
        const info = job.text != null ? { llmz: false } : await tiny.api.call('inspect', { path: job.path });
        job.mode = job.trace ? 'trace' : info.llmz ? 'decompress' : 'compress';
        job.stage = job.mode === 'decompress' ? 'Decompressing' : job.mode === 'trace' ? 'Tracing' : 'Compressing';
        job.diagram = wantsDiagram(job);
        if (job.mode === 'decompress') job.originalBytes = info.meta?.size;
        render();
        const common = { input: job.path, model: state.modelPath, lib: state.libPath, diagram: job.diagram };
        const textArgs = job.text != null ? { text: job.text, name: 'text.txt' } : {};
        if (job.mode === 'trace')
            job.result = await tiny.api.call('traceText', { text: job.text, model: state.modelPath, lib: state.libPath, ...advanced() });
        else if (job.mode === 'compress')
            job.result = await tiny.api.call('compress', { ...common, ...textArgs, ...advanced() });
        else
            job.result = await tiny.api.call('decompress', { ...common, force: !!job.force });
        job.status = 'done';
        if (job.mode === 'compress') compareLzma(job);
    }
    catch (error) {
        const message = errorText(error);
        job.status = message === 'Cancelled' ? 'cancelled' : 'error';
        job.error = message;
        job.canForce = /differs from the one used/.test(message);
    }
    if (job.target) {
        // A diagram run belongs to the compression job it was started from, which then offers the replay.
        job.target.tracing = false;
        if (job.status === 'done') {
            Object.assign(job.target, { steps: job.steps, total: job.total, originalBytes: job.originalBytes });
            job.steps = null;
            if (state.diagramShown === job) {
                state.diagramShown = job.target;
                $('diagramTitle').textContent = `Diagram: ${job.target.label || base(job.target.path)}`;
            }
        }
    }
    if (state.diagramShown === job || state.diagramShown === job.target) diagram.finish();
    trimRecordings();
    render();
};

tiny.api.on('job', event => {
    const job = runningJob();
    if (!job) return;
    if (event.stage) job.stage = event.stage;
    if (event.total) {
        job.tokens = event.tokens;
        job.total = event.total;
        job.percent = Math.min(100, Math.floor(event.tokens / event.total * 100));
        job.bps = event.bps;
    }
    render();
});

// Compresses the same input with LZMA in the background and shows it next to the model's result.
const compareLzma = job => {
    job.lzma = { pending: true };
    tiny.api.call('lzma', { input: job.path, text: job.text })
        .then(result => job.lzma = result)
        .catch(error => job.lzma = { error: errorText(error) })
        .finally(render);
};

const lzmaLine = job => {
    const { result, lzma } = job;
    if (!lzma) return '';
    if (lzma.pending) return '\nLZMA: computing…';
    if (lzma.error) return `\nLZMA: ${esc(lzma.error)}`;
    const ratio = result.inputSize ? (result.inputSize / lzma.size).toFixed(2) : '–';
    const versus = size => size < lzma.size ? `${(lzma.size / size).toFixed(1)}x smaller` : `${(size / lzma.size).toFixed(1)}x larger`;
    return `\nLZMA level ${lzma.level}: ${fmtBytes(lzma.size)} (ratio ${ratio}:1, ${fmtTime(lzma.seconds)}). ` +
        `The model's compressed data is ${versus(result.payloadSize)} than this, its whole file ${versus(result.outputSize)}.`;
};

const runningText = job => {
    const progress = job.total ? ` · ${job.tokens} of ${job.total} tokens${job.bps ? ` · ${fmtBytes(job.bps)}/s` : ''}` : '';
    return `${job.stage || 'Working'} · ${fmtTime((Date.now() - job.startedAt) / 1000)}${progress}`;
};

// The backend reports progress about once a second, so the timer of the running job is updated here.
// Only its text changes, because rebuilding the list would swallow clicks on the Cancel button.
setInterval(() => {
    const job = runningJob();
    const text = job && document.querySelector(`li.job[data-key="${job.key}"] .jstate`);
    if (text) text.textContent = runningText(job);
}, 100);

const jobHtml = job => {
    const name = esc(job.label || base(job.path));
    let stateText = '', cls = '', detail = '', bar = '', actions = '';
    if (job.status === 'queued') stateText = 'Waiting';
    if (job.status === 'running') {
        stateText = runningText(job);
        bar = `<div class="bar"><i class="${job.percent != null ? 'det' : ''}" style="${job.percent != null ? `width:${job.percent}%` : ''}"></i></div>`;
        actions = '<button data-act="cancel">Cancel</button>';
    }
    if (job.status === 'done') {
        const result = job.result;
        cls = 'ok';
        if (job.mode === 'compress') {
            stateText = `Done · ${fmtTime(result.seconds)}`;
            const ratioOf = size => result.inputSize ? (result.inputSize / size).toFixed(2) : '–';
            const header = result.outputSize - result.payloadSize;
            const saved = job.savedTo ? `Saved to ${esc(job.savedTo)}` : 'Not saved yet';
            detail = `${fmtBytes(result.inputSize)} → ${fmtBytes(result.outputSize)} file (ratio ${ratioOf(result.outputSize)}:1)\n` +
                `Compressed data ${fmtBytes(result.payloadSize)} (ratio ${ratioOf(result.payloadSize)}:1), header ${fmtBytes(header)}\n${saved}${job.saveError ? `\n<span class="err">${esc(job.saveError)}</span>` : ''}${lzmaLine(job)}`;
        }
        else if (job.mode === 'decompress') {
            stateText = `Verified · ${fmtTime(result.seconds)}`;
            detail = `${fmtBytes(result.inputSize)} → ${fmtBytes(result.outputSize)}, checksum matches\n${esc(result.output)}`;
        }
        else {
            stateText = `Done · ${fmtTime(result.seconds)}`;
            detail = `${result.tokens} tokens, nothing was saved\nThe diagram is on the compression job.`;
        }
        if (job.mode === 'compress') actions = `<button data-act="save" class="primary">Save…</button><button data-act="decompress">Decompress</button>${job.savedTo ? '<button data-act="reveal">Show in folder</button>' : ''}`;
        if (job.mode === 'decompress') actions = '<button data-act="view" class="primary">View text</button><button data-act="reveal">Show in folder</button>';
        if (job.steps?.length) actions += '<button data-act="diagram">Replay diagram</button>';
        else if (job.tracing) actions += '<button disabled>Preparing diagram…</button>';
        else if (job.text != null && job.mode === 'compress') actions += '<button data-act="trace">Show diagram for this text</button>';
    }
    if (['error', 'cancelled'].includes(job.status)) {
        cls = job.status === 'error' ? 'err' : '';
        stateText = job.status === 'error' ? 'Failed' : 'Cancelled';
        detail = job.status === 'error' ? esc(job.error) : '';
        if (job.canForce) actions = '<button data-act="force">Try anyway</button>';
        actions += '<button data-act="retry">Retry</button>';
    }
    if (job.model) detail = `Model: ${esc(job.model)}${detail ? `\n${detail}` : ''}`;
    return `<li class="job" data-key="${esc(job.key)}">
    <div class="jname">${name}</div><div class="jstate ${cls}">${esc(stateText)}</div>
    ${bar}${detail ? `<div class="jdetail">${detail}</div>` : ''}
    ${actions ? `<div class="jactions">${actions}</div>` : ''}</li>`;
};

// Removes the jobs that are finished. Queued and running jobs stay. The
// compressed files of the removed jobs can no longer be saved, so the backend
// deletes them from the temporary folder.
const clearHistory = () => {
    const finished = [...state.jobs.values()].filter(job => ['done', 'error', 'cancelled'].includes(job.status));
    const files = finished.filter(job => ['compress', 'decompress'].includes(job.mode) && job.result?.output).map(job => job.result.output);
    for (const job of finished) {
        state.jobs.delete(job.key);
        if (state.diagramShown === job) state.diagramShown = null;
    }
    if (files.length) void tiny.api.call('discard', { files }).catch(() => {});
    render();
};
$('clearJobs').addEventListener('click', clearHistory);

// The viewer is a modal <dialog> that shows the text a decompress job wrote.
const viewText = async job => {
    const viewer = $('viewer');
    $('viewerTitle').textContent = base(job.result.output);
    $('viewerText').textContent = 'Loading…';
    $('viewerNote').hidden = true;
    $('viewerCopy').disabled = true;
    viewer.showModal();
    const [{ value, reason }] = await Promise.allSettled([tiny.api.call('readText', { path: job.result.output })]);
    $('viewerNote').hidden = !(reason || value.binary || value.truncated);
    if (reason) {
        $('viewerText').textContent = '';
        $('viewerNote').textContent = errorText(reason);
    }
    else if (value.binary) {
        $('viewerText').textContent = '';
        $('viewerNote').textContent = `This file is not text (${fmtBytes(value.size)}). Use "Show in folder" to open it.`;
    }
    else {
        $('viewerText').textContent = value.text;
        $('viewerNote').textContent = `Showing the first ${fmtBytes(new TextEncoder().encode(value.text).length)} of ${fmtBytes(value.size)}.`;
        $('viewerCopy').disabled = false;
    }
};
$('viewerClose').addEventListener('click', () => $('viewer').close());
$('viewerCopy').addEventListener('click', async () => {
    await navigator.clipboard.writeText($('viewerText').textContent);
    $('viewerCopy').textContent = 'Copied';
    setTimeout(() => $('viewerCopy').textContent = 'Copy', 1200);
});

const render = () => {
    const jobs = [...state.jobs.values()].reverse();
    $('jobsCard').hidden = jobs.length === 0;
    $('clearJobs').disabled = !jobs.some(job => ['done', 'error', 'cancelled'].includes(job.status));
    $('jobs').innerHTML = jobs.map(jobHtml).join('');
};

$('jobs').addEventListener('click', async event => {
    const button = event.target.closest('button[data-act]');
    const item = event.target.closest('li.job');
    if (!button || !item) return;
    const job = state.jobs.get(item.dataset.key);
    const act = button.dataset.act;
    if (act === 'cancel') await tiny.api.call('cancel');
    if (act === 'reveal') await tiny.app.shell.reveal(job.savedTo || job.result.output);
    if (act === 'decompress')
        // The compressed file in the temporary folder is decompressed again, which also proves it decodes.
        enqueue({
            key: Math.random().toString(36).slice(2), path: job.result.output,
            label: `Decompress ${job.label || base(job.path)}`, status: 'queued'
        });
    if (act === 'view') await viewText(job);
    if (act === 'save') {
        const stem = (job.label?.startsWith('Text') ? 'text' : base(job.path)).replace(/\.llmz$/i, '');
        const to = await tiny.dialog.saveFile({ types: ['llmz'], name: stem });
        if (!to) return;
        const [{ value, reason }] = await Promise.allSettled([tiny.api.call('save', { from: job.result.output, to })]);
        if (reason) job.saveError = errorText(reason);
        else Object.assign(job, { savedTo: value.output, saveError: null });
        render();
    }
    if (act === 'diagram' && !runningJob()) showDiagram(job, { live: false });
    if (act === 'trace') {
        // The live run was not recorded, so run the coder again on the text without saving.
        // The recording goes to this job, which then offers the replay.
        job.tracing = true;
        enqueue({
            key: Math.random().toString(36).slice(2), path: job.path, text: job.text, trace: true, target: job,
            label: `Diagram for ${job.label}`, status: 'queued'
        });
    }
    if (['retry', 'force'].includes(act)) {
        job.force = act === 'force';
        Object.assign(job, { savedTo: null, saveError: null });
        if (job.target) job.target.tracing = true;
        job.status = 'queued';
        state.queue.push(job);
        render();
        pump();
    }
});

// ---- input tabs ---------------------------------------------------------------

const showTab = (name, focus = false) => {
    state.tab = name;
    for (const tab of ['file', 'text']) {
        const selected = tab === name;
        const button = $(tab === 'file' ? 'tabFile' : 'tabText');
        button.setAttribute('aria-selected', String(selected));
        button.tabIndex = selected ? 0 : -1;
        $(tab === 'file' ? 'paneFile' : 'paneText').hidden = !selected;
        if (selected && focus) button.focus();
    }
    if (name === 'text') $('textIn').focus();
    tiny.store.set('tab', name);
};
$('tabFile').addEventListener('click', () => showTab('file'));
$('tabText').addEventListener('click', () => showTab('text'));
$('tabFile').parentElement.addEventListener('keydown', event => {
    if (['ArrowRight', 'ArrowLeft'].includes(event.key)) {
        event.preventDefault();
        showTab(state.tab === 'file' ? 'text' : 'file', true);
    }
});

// ---- text input -------------------------------------------------------------

$('textIn').addEventListener('input', () => {
    const text = $('textIn').value;
    $('textCount').textContent = `${[...text].length} characters, ${byteLength(text)} bytes`;
    $('textGo').disabled = text.length === 0;
});
const compressText = async () => {
    const text = $('textIn').value;
    if (!text) return;
    enqueue({
        key: Math.random().toString(36).slice(2), path: 'text.txt', text,
        label: `Text (${byteLength(text)} bytes)`, status: 'queued'
    });
};
$('textGo').addEventListener('click', compressText);
$('textIn').addEventListener('keydown', event => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        compressText();
    }
});

// ---- drop / choose ---------------------------------------------------------

tiny.win.onDrop(paths => {
    $('drop').classList.remove('over');
    addFiles(paths);
});
for (const name of ['dragenter', 'dragover'])
    document.addEventListener(name, event => {
        event.preventDefault();
        $('drop').classList.add('over');
    });
for (const name of ['dragleave', 'drop'])
    document.addEventListener(name, event => {
        event.preventDefault();
        $('drop').classList.remove('over');
    });
tiny.app.onOpenFiles(paths => addFiles(paths));
$('pickFiles').addEventListener('click', async () => {
    const paths = await tiny.dialog.openFiles();
    if (paths && paths.length) addFiles(paths);
});

// ---- start -----------------------------------------------------------------

(async () => {
    await tiny.api.call('ping');
    await loadSettings();
    showTab(state.tab);
    await refreshStatus();
})().catch(error => document.body.insertAdjacentHTML('afterbegin', `<p class="err">${esc(error)}</p>`));
