const $ = (id) => document.getElementById(id);
// Escape anything that goes into innerHTML. File names are untrusted and
// this page holds an RPC channel to the backend.
const esc = (s) => String(s).replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

import { MODELS } from '../shared/models.js';

const state = {
  engine: null, enginePath: null, model: null, modelPath: null,
  installers: { uv: null, pipx: null, git: true }, installing: null,
  models: [], exclusive: null, // 'install' | 'download' while one runs
  queue: [], busy: false, jobs: new Map(),
};

const base = (p) => p.split(/[\\/]/).pop();
const fmtBytes = (n) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB`
  : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(2)} GB`;
const fmtTime = (s) => s < 60 ? `${s.toFixed(s < 10 ? 1 : 0)} s` : `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;

// ---- setup / model ---------------------------------------------------------

async function loadSettings() {
  state.enginePath = (await tiny.store.get('enginePath')) || null;
  state.modelPath = (await tiny.store.get('modelPath')) || null;
  state.tab = (await tiny.store.get('tab')) === 'text' ? 'text' : 'file';
  const adv = (await tiny.store.get('advanced')) || {};
  if (adv.nCtx != null) $('nCtx').value = adv.nCtx;
  if (adv.overlap) $('overlap').value = adv.overlap;
  if (adv.gpuLayers != null) $('gpuLayers').value = adv.gpuLayers;
}

async function refreshStatus() {
  const [st, lib, inst] = await Promise.all([
    tiny.api.call('status', { engine: state.enginePath, model: state.modelPath }),
    tiny.api.call('listModels'),
    tiny.api.call('installers'),
  ]);
  state.engine = st.engine;
  state.model = st.model;
  state.models = lib.models;
  state.installers = inst;
  renderSetup();
  renderModel();
  renderCatalog();
  updateControls();
}

function renderSetup() {
  $('setup').hidden = !!state.engine;
  const { uv, pipx, git } = state.installers;
  $('installUv').title = uv ? uv : 'uv was not found on this machine';
  $('installPipx').title = pipx ? pipx : 'pipx was not found on this machine';
  const hint = $('noInstaller');
  const missing = [!uv && 'uv', !pipx && 'pipx'].filter(Boolean);
  hint.hidden = missing.length === 0;
  hint.innerHTML = !uv && !pipx
    ? 'Neither uv nor pipx was found. Install one of them, then choose "Check again". <a href="#" id="uvDocs">How to install uv</a>'
    : `${missing[0]} was not found, so its button is disabled.`;
  const docs = $('uvDocs');
  if (docs) docs.addEventListener('click', (e) => {
    e.preventDefault();
    tiny.app.shell.open('https://docs.astral.sh/uv/getting-started/installation/');
  });
  $('noGit').hidden = git !== false;
}

function renderModel() {
  const sel = $('modelSelect');
  const options = state.models.map((m) => `<option value="${esc(m.path)}">${esc(m.name)} (${fmtBytes(m.size)})</option>`);
  const external = state.modelPath && !state.models.some((m) => m.path === state.modelPath);
  if (external) options.unshift(`<option value="${esc(state.modelPath)}">${esc(base(state.modelPath))} (chosen file)</option>`);
  if (!state.modelPath) options.unshift('<option value="">No model selected</option>');
  sel.innerHTML = options.join('');
  sel.value = state.modelPath || '';
  const info = $('modelInfo');
  info.textContent = state.model
    ? `${base(state.modelPath)}, ${fmtBytes(state.model.size)}. Decompression needs this exact file.`
    : 'Download a model or choose a .gguf file. Decompression needs the exact same model file.';
}

function renderCatalog() {
  $('catalog').innerHTML = MODELS.map((m) => {
    const have = state.models.find((x) => x.name === m.file && x.size === m.size);
    const action = have
      ? `<button data-act="use" data-id="${esc(m.id)}">Use</button><button data-act="del" data-id="${esc(m.id)}">Delete</button>`
      : `<button data-act="get" data-id="${esc(m.id)}" ${state.exclusive ? 'disabled' : ''}>Download</button>`;
    return `<li class="cat"><div><strong>${esc(m.name)}</strong> <span class="muted">${esc(m.quant)} · ${fmtBytes(m.size)}${have ? ' · downloaded' : ''}</span>
      <div class="muted small">${esc(m.note)}</div></div><div class="actions">${action}</div></li>`;
  }).join('');
}

function updateControls() {
  const busy = !!state.exclusive;
  for (const b of document.querySelectorAll('#setup button[data-tool]')) {
    const tool = b.dataset.tool;
    b.disabled = busy || !state.installers[tool];
    b.textContent = state.installing === tool ? `installing with ${tool}…` : `using ${tool}`;
  }
  $('cancelInstall').hidden = state.exclusive !== 'install';
  $('dlUrlGo').disabled = busy;
  for (const b of $('catalog').querySelectorAll('button[data-act=get]')) b.disabled = busy;
}

async function selectModel(path) {
  state.modelPath = path || null;
  await tiny.store.set('modelPath', state.modelPath);
  await refreshStatus();
}

function advanced() {
  return {
    nCtx: Math.max(0, parseInt($('nCtx').value, 10) || 0),
    overlap: $('overlap').value.trim() || '0%',
    gpuLayers: parseInt($('gpuLayers').value, 10),
  };
}

for (const id of ['nCtx', 'overlap', 'gpuLayers']) {
  $(id).addEventListener('change', () => tiny.store.set('advanced', {
    nCtx: $('nCtx').value, overlap: $('overlap').value, gpuLayers: $('gpuLayers').value,
  }));
}

$('modelSelect').addEventListener('change', (e) => selectModel(e.target.value));
$('pickModel').addEventListener('click', async () => {
  const p = await tiny.dialog.openFile({ types: ['gguf'] });
  if (p) await selectModel(p);
});
$('pickEngine').addEventListener('click', async () => {
  const p = await tiny.dialog.openFile();
  if (!p) return;
  state.enginePath = p;
  await tiny.store.set('enginePath', p);
  await refreshStatus();
});
$('recheck').addEventListener('click', refreshStatus);

// ---- install llama-zip ------------------------------------------------------

let installLog = '';
tiny.api.on('install', ({ text }) => {
  installLog = (installLog + text).replace(/\r(?!\n)/g, '\n').slice(-6000);
  const pre = $('installLog');
  pre.hidden = false;
  pre.textContent = installLog;
  pre.scrollTop = pre.scrollHeight;
});

async function install(tool) {
  if (!state.installers[tool] || state.exclusive) return;
  state.exclusive = 'install';
  state.installing = tool;
  installLog = '';
  $('installErr').textContent = '';
  updateControls();
  try {
    const r = await tiny.api.call('installEngine', { tool });
    state.enginePath = r.engine;
    await tiny.store.set('enginePath', r.engine);
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    $('installErr').textContent = msg === 'Cancelled' ? 'Install cancelled.' : msg;
  }
  state.exclusive = null;
  state.installing = null;
  await refreshStatus();
}
for (const b of document.querySelectorAll('#setup button[data-tool]')) {
  b.addEventListener('click', () => install(b.dataset.tool));
}
$('cancelInstall').addEventListener('click', () => tiny.api.call('cancel'));

// ---- download models --------------------------------------------------------

$('toggleDl').addEventListener('click', () => { $('dlPanel').hidden = !$('dlPanel').hidden; });

tiny.api.on('download', ({ received, total }) => {
  const pct = total ? Math.min(100, (received / total) * 100) : null;
  $('dlText').textContent = total
    ? `${fmtBytes(received)} of ${fmtBytes(total)} · ${pct.toFixed(0)}%`
    : fmtBytes(received);
  const bar = $('dlBar');
  bar.className = pct == null ? '' : 'det';
  bar.style.width = pct == null ? '' : `${pct}%`;
});

async function download(params, label) {
  if (state.exclusive) return;
  state.exclusive = 'download';
  $('dlErr').textContent = '';
  $('dlProgress').hidden = false;
  $('dlText').textContent = `Starting ${label}…`;
  $('dlBar').style.width = '0';
  updateControls();
  try {
    const r = await tiny.api.call('downloadModel', params);
    state.modelPath = r.path;
    await tiny.store.set('modelPath', r.path);
    if (params.url) $('dlUrl').value = '';
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    $('dlErr').textContent = msg === 'Cancelled' ? 'Download cancelled.' : msg;
  }
  state.exclusive = null;
  $('dlProgress').hidden = true;
  await refreshStatus();
}

$('catalog').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('button[data-act]');
  if (!btn) return;
  const m = MODELS.find((x) => x.id === btn.dataset.id);
  const have = state.models.find((x) => x.name === m.file);
  if (btn.dataset.act === 'get') await download({ id: m.id }, m.name);
  if (btn.dataset.act === 'use' && have) await selectModel(have.path);
  if (btn.dataset.act === 'del' && have) {
    const ok = await tiny.dialog.confirm(`Delete ${m.name}?`, {
      detail: 'Files compressed with this model cannot be decompressed until you download it again.',
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
$('dlUrl').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('dlUrlGo').click(); });
$('cancelDl').addEventListener('click', () => tiny.api.call('cancel'));

// ---- jobs ------------------------------------------------------------------

function addFiles(paths) {
  for (const path of paths) {
    const job = { key: Math.random().toString(36).slice(2), path, status: 'queued', detail: '' };
    state.jobs.set(job.key, job);
    state.queue.push(job);
  }
  render();
  pump();
}

async function pump() {
  if (state.busy) return;
  state.busy = true;
  while (state.queue.length) {
    while (state.exclusive) await new Promise((r) => setTimeout(r, 300));
    const job = state.queue.shift();
    await runJob(job);
  }
  state.busy = false;
}

async function runJob(job) {
  job.status = 'running';
  job.elapsed = 0;
  job.percent = null;
  job.error = null;
  render();
  try {
    if (!state.engine) throw new Error('llama-zip is not installed. Use the install box above.');
    const info = job.text != null ? { llmz: false } : await tiny.api.call('inspect', { path: job.path });
    job.mode = info.llmz ? 'decompress' : 'compress';
    job.stage = job.mode === 'compress' ? 'Compressing' : 'Decompressing';
    render();
    const common = { input: job.path, model: state.modelPath, engine: state.enginePath };
    const textArgs = job.text != null ? { text: job.text, output: job.output, overwrite: true, name: 'text.txt' } : {};
    job.result = job.mode === 'compress'
      ? await tiny.api.call('compress', { ...common, ...textArgs, ...advanced() })
      : await tiny.api.call('decompress', { ...common, force: !!job.force });
    job.status = 'done';
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    job.status = msg === 'Cancelled' ? 'cancelled' : 'error';
    job.error = msg;
    job.canForce = /differs from the one used/.test(msg);
  }
  render();
}

tiny.api.on('job', (ev) => {
  for (const job of state.jobs.values()) {
    if (job.status !== 'running') continue;
    job.elapsed = ev.elapsed;
    if (ev.percent != null) job.percent = ev.percent;
    render();
  }
});

function jobHtml(j) {
  const name = esc(j.label || base(j.path));
  let stateText = '', cls = '', detail = '', bar = '', actions = '';
  if (j.status === 'queued') stateText = 'Waiting';
  if (j.status === 'running') {
    stateText = `${j.stage || 'Working'} · ${fmtTime(j.elapsed || 0)}${j.percent != null ? ` · ${j.percent}%` : ''}`;
    bar = `<div class="bar"><i class="${j.percent != null ? 'det' : ''}" style="${j.percent != null ? `width:${j.percent}%` : ''}"></i></div>`;
    actions = `<button data-act="cancel">Cancel</button>`;
  }
  if (j.status === 'done') {
    const r = j.result;
    cls = 'ok';
    if (j.mode === 'compress') {
      stateText = `Done · ${fmtTime(r.seconds)}`;
      const ratio = r.inputSize ? (r.inputSize / r.outputSize).toFixed(2) : '–';
      detail = `${fmtBytes(r.inputSize)} → ${fmtBytes(r.outputSize)} (ratio ${ratio}:1)\n${esc(r.output)}`;
    } else {
      stateText = `Verified · ${fmtTime(r.seconds)}`;
      detail = `${fmtBytes(r.inputSize)} → ${fmtBytes(r.outputSize)}, checksum matches\n${esc(r.output)}`;
    }
    actions = `<button data-act="reveal">Show in folder</button>`;
  }
  if (j.status === 'error' || j.status === 'cancelled') {
    cls = j.status === 'error' ? 'err' : '';
    stateText = j.status === 'error' ? 'Failed' : 'Cancelled';
    detail = j.status === 'error' ? esc(j.error) : '';
    if (j.canForce) actions = `<button data-act="force">Try anyway</button>`;
    actions += `<button data-act="retry">Retry</button>`;
  }
  return `<li class="job" data-key="${esc(j.key)}">
    <div class="jname">${name}</div><div class="jstate ${cls}">${esc(stateText)}</div>
    ${bar}${detail ? `<div class="jdetail">${detail}</div>` : ''}
    ${actions ? `<div class="jactions">${actions}</div>` : ''}</li>`;
}

function render() {
  const jobs = [...state.jobs.values()].reverse();
  $('jobsCard').hidden = jobs.length === 0;
  $('jobs').innerHTML = jobs.map(jobHtml).join('');
}

$('jobs').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('button[data-act]');
  const li = ev.target.closest('li.job');
  if (!btn || !li) return;
  const job = state.jobs.get(li.dataset.key);
  const act = btn.dataset.act;
  if (act === 'cancel') await tiny.api.call('cancel');
  if (act === 'reveal') await tiny.app.shell.reveal(job.result.output);
  if (act === 'retry' || act === 'force') {
    job.force = act === 'force';
    job.status = 'queued';
    state.queue.push(job);
    render();
    pump();
  }
});

// ---- input tabs ---------------------------------------------------------------

function showTab(name, focus = false) {
  state.tab = name;
  for (const t of ['file', 'text']) {
    const sel = t === name;
    const tab = $(t === 'file' ? 'tabFile' : 'tabText');
    tab.setAttribute('aria-selected', String(sel));
    tab.tabIndex = sel ? 0 : -1;
    $(t === 'file' ? 'paneFile' : 'paneText').hidden = !sel;
    if (sel && focus) tab.focus();
  }
  if (name === 'text') $('textIn').focus();
  tiny.store.set('tab', name);
}
$('tabFile').addEventListener('click', () => showTab('file'));
$('tabText').addEventListener('click', () => showTab('text'));
$('tabFile').parentElement.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    e.preventDefault();
    showTab(state.tab === 'file' ? 'text' : 'file', true);
  }
});

// ---- text input -------------------------------------------------------------

const byteLength = (t) => new TextEncoder().encode(t).length;
$('textIn').addEventListener('input', () => {
  const t = $('textIn').value;
  $('textCount').textContent = `${[...t].length} characters, ${byteLength(t)} bytes`;
  $('textGo').disabled = t.length === 0;
});
async function compressText() {
  const text = $('textIn').value;
  if (!text) return;
  const output = await tiny.dialog.saveFile({ types: ['llmz'], name: 'text' });
  if (!output) return;
  const job = {
    key: Math.random().toString(36).slice(2), path: output, output, text,
    label: `Text (${byteLength(text)} bytes)`, status: 'queued', detail: '',
  };
  state.jobs.set(job.key, job);
  state.queue.push(job);
  render();
  pump();
}
$('textGo').addEventListener('click', compressText);
$('textIn').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); compressText(); }
});

// ---- drop / choose ---------------------------------------------------------

tiny.win.onDrop((paths) => { $('drop').classList.remove('over'); addFiles(paths); });
for (const ev of ['dragenter', 'dragover']) {
  document.addEventListener(ev, (e) => { e.preventDefault(); $('drop').classList.add('over'); });
}
for (const ev of ['dragleave', 'drop']) {
  document.addEventListener(ev, (e) => { e.preventDefault(); $('drop').classList.remove('over'); });
}
tiny.app.onOpenFiles((paths) => addFiles(paths));
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
})().catch((e) => { document.body.insertAdjacentHTML('afterbegin', `<p class="err">${esc(e)}</p>`); });
