const $ = (id) => document.getElementById(id);
// Escape anything that goes into innerHTML. File names are untrusted and
// this page holds an RPC channel to the backend.
const esc = (s) => String(s).replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = { engine: null, enginePath: null, model: null, modelPath: null, queue: [], busy: false, jobs: new Map() };

const base = (p) => p.split(/[\\/]/).pop();
const fmtBytes = (n) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(2)} MB`;
const fmtTime = (s) => s < 60 ? `${s.toFixed(s < 10 ? 1 : 0)} s` : `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;

// ---- setup / model ---------------------------------------------------------

async function loadSettings() {
  state.enginePath = (await tiny.store.get('enginePath')) || null;
  state.modelPath = (await tiny.store.get('modelPath')) || null;
  const adv = (await tiny.store.get('advanced')) || {};
  if (adv.nCtx != null) $('nCtx').value = adv.nCtx;
  if (adv.overlap) $('overlap').value = adv.overlap;
  if (adv.gpuLayers != null) $('gpuLayers').value = adv.gpuLayers;
}

async function refreshStatus() {
  const st = await tiny.api.call('status', { engine: state.enginePath, model: state.modelPath });
  state.engine = st.engine;
  state.model = st.model;
  $('setup').hidden = !!st.engine;
  $('installCmd').textContent = 'pipx install git+https://github.com/alexbuz/llama-zip.git';
  const el = $('modelName');
  if (st.model) {
    el.textContent = `${st.model.name} (${fmtBytes(st.model.size)})`;
    el.classList.add('set');
  } else {
    el.textContent = 'No model selected';
    el.classList.remove('set');
  }
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

$('pickModel').addEventListener('click', async () => {
  const p = await tiny.dialog.openFile({ types: ['gguf'] });
  if (!p) return;
  state.modelPath = p;
  await tiny.store.set('modelPath', p);
  await refreshStatus();
});
$('pickEngine').addEventListener('click', async () => {
  const p = await tiny.dialog.openFile();
  if (!p) return;
  state.enginePath = p;
  await tiny.store.set('enginePath', p);
  await refreshStatus();
});
$('recheck').addEventListener('click', refreshStatus);
$('copyInstall').addEventListener('click', () => tiny.clipboard.write({ text: $('installCmd').textContent }));

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
    if (!state.engine) throw new Error('llama-zip was not found. See the setup box above.');
    const info = await tiny.api.call('inspect', { path: job.path });
    job.mode = info.llmz ? 'decompress' : 'compress';
    job.stage = job.mode === 'compress' ? 'Compressing' : 'Decompressing';
    render();
    const common = { input: job.path, model: state.modelPath, engine: state.enginePath };
    job.result = job.mode === 'compress'
      ? await tiny.api.call('compress', { ...common, ...advanced() })
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
  const name = esc(base(j.path));
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
  await refreshStatus();
})().catch((e) => { document.body.insertAdjacentHTML('afterbegin', `<p class="err">${esc(e)}</p>`); });
