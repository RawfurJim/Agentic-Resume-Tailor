/* ------------------------------------------------------------------
   CV Optimiser - batch page logic

   Flow:  page loads -> fetch /api/defaults (for placeholders)
          user picks a CSV/xlsx and clicks Start
          -> POST /api/batch (multipart)  -> job status JSON
          -> poll GET /api/batch/{id} every 3 s and redraw the table
          -> when state === "done": stop polling, show the zip link
   The API key is only ever read from the input box when the request is
   sent. It is never saved (no storage, no cookies).
   ------------------------------------------------------------------ */

'use strict';

// ---- 1. elements ------------------------------------------------------
const form         = document.getElementById('batch-form');
const fileInput    = document.getElementById('file');
const providerSel  = document.getElementById('provider');
const modelInput   = document.getElementById('model');
const modelHelp    = document.getElementById('model_help');
const keyInput     = document.getElementById('api_key');
const keyHelp      = document.getElementById('api_key_help');
const toggleKeyBtn = document.getElementById('toggle_key');
const startBtn     = document.getElementById('start');

const statusBox    = document.getElementById('status');
const elapsedEl    = document.getElementById('elapsed');
const errorBox     = document.getElementById('error');
const resultsBox   = document.getElementById('results');
const progressText = document.getElementById('progress_text');
const zipLink      = document.getElementById('zip_link');
const rowsBody     = document.getElementById('rows');

const POLL_MS = 3000;

// ---- 2. defaults (same as app.js) ------------------------------------
let defaults = {
  provider: 'deepseek',
  deepseek: { extract_model: 'deepseek-flash', rewrite_model: 'deepseek-reasoner' },
  gemini:   { extract_model: 'gemini-2.5-flash', rewrite_model: 'gemini-2.5-flash' },
};

async function loadDefaults() {
  try {
    const resp = await fetch('/api/defaults');
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const data = await resp.json();
    if (data && data.deepseek && data.gemini) defaults = data;
  } catch (_err) {
    // keep the hard-coded defaults
  }
  updateProviderHints();
}

function updateProviderHints() {
  const provider = providerSel.value;
  if (provider === 'gemini') {
    const g = defaults.gemini;
    modelInput.placeholder = g.extract_model;
    modelHelp.textContent  = 'Used for both steps. Leave blank for ' + g.extract_model + '.';
    keyHelp.textContent    = 'Required for Gemini.';
  } else {
    const d = defaults.deepseek;
    modelInput.placeholder = d.extract_model + ' (extract) + ' + d.rewrite_model + ' (rewrite)';
    modelHelp.textContent  = 'Leave blank to use the defaults. If you type a model it is used for both steps.';
    keyHelp.textContent    = "Optional. Leave blank to use the server's key from .env.";
  }
}

providerSel.addEventListener('change', updateProviderHints);

toggleKeyBtn.addEventListener('click', () => {
  const showing = keyInput.type === 'text';
  keyInput.type = showing ? 'password' : 'text';
  toggleKeyBtn.textContent = showing ? 'Show' : 'Hide';
  toggleKeyBtn.setAttribute('aria-pressed', String(!showing));
});

// ---- 3. small UI helpers ---------------------------------------------
function showError(message) {
  errorBox.textContent = message;
  errorBox.hidden = false;
}

function setBusy(busy) {
  startBtn.disabled = busy;
  startBtn.textContent = busy ? 'Running…' : 'Start batch';
  for (const el of [fileInput, providerSel, modelInput, keyInput, toggleKeyBtn]) el.disabled = busy;
  form.classList.toggle('busy', busy);
  statusBox.hidden = !busy;
}

let timerId = null;
let startedAt = 0;

function startTimer() {
  startedAt = Date.now();
  elapsedEl.textContent = '0 s';
  timerId = setInterval(() => {
    elapsedEl.textContent = Math.round((Date.now() - startedAt) / 1000) + ' s';
  }, 1000);
}

function stopTimer() {
  clearInterval(timerId);
  timerId = null;
}

// 422 -> detail is a list of {loc, msg}; every other error -> a string.
function messageFromDetail(detail, status) {
  if (Array.isArray(detail)) {
    const msgs = detail.map((d) => (d && d.msg) ? String(d.msg) : '').filter(Boolean);
    if (msgs.length) return msgs.join('; ');
  }
  if (typeof detail === 'string' && detail) return detail;
  return 'Request failed (HTTP ' + status + ').';
}

async function errorMessageFromResponse(resp) {
  try {
    const body = await resp.json();
    return messageFromDetail(body && body.detail, resp.status);
  } catch (_err) {
    return 'Request failed (HTTP ' + resp.status + ').';
  }
}

// ---- 4. drawing the table --------------------------------------------
function cell(tr, text) {
  const td = document.createElement('td');
  td.textContent = text;
  tr.appendChild(td);
  return td;
}

function render(job) {
  const rows = job.rows || [];
  const done   = rows.filter((r) => r.status === 'done').length;
  const failed = rows.filter((r) => r.status === 'failed').length;
  progressText.textContent = (done + failed) + ' of ' + rows.length + ' finished'
                           + ' (' + done + ' done, ' + failed + ' failed)';

  rowsBody.textContent = '';                       // clear and rebuild
  for (const r of rows) {
    const tr = document.createElement('tr');
    cell(tr, String(r.index + 1));
    cell(tr, r.job_title || r.title || '');
    cell(tr, r.company || '');

    const linkTd = cell(tr, '');
    if (/^https?:\/\//i.test(r.link || '')) {
      const a = document.createElement('a');
      a.href = r.link;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = 'Open';
      linkTd.appendChild(a);
    } else {
      linkTd.textContent = r.link || '';
    }

    const statusTd = cell(tr, '');
    const badge = document.createElement('span');
    badge.className = 'badge ' + r.status;
    badge.textContent = r.status;
    statusTd.appendChild(badge);
    if (r.status === 'failed' && r.error) {
      const err = document.createElement('div');
      err.className = 'row-error';
      err.textContent = r.error;
      statusTd.appendChild(err);
    }

    const cvTd = cell(tr, '');
    if (r.status === 'done' && r.download_url) {
      const a = document.createElement('a');
      a.className = 'dl';
      a.href = r.download_url;
      a.setAttribute('download', '');
      a.textContent = 'Download';
      cvTd.appendChild(a);
    }
    rowsBody.appendChild(tr);
  }

  if (job.state === 'done' && job.zip_url) {
    zipLink.href = job.zip_url;
    zipLink.hidden = false;
  }
  resultsBox.hidden = false;
}

// ---- 5. polling --------------------------------------------------------
let pollId = null;

function stopPolling() {
  clearTimeout(pollId);
  pollId = null;
}

async function poll(jobId) {
  let resp;
  try {
    resp = await fetch('/api/batch/' + encodeURIComponent(jobId));
  } catch (_networkErr) {
    pollId = setTimeout(() => poll(jobId), POLL_MS);   // server hiccup: try again
    return;
  }
  if (!resp.ok) {
    showError(await errorMessageFromResponse(resp));
    finish();
    return;
  }
  const job = await resp.json();
  render(job);
  if (job.state === 'done') {
    finish();
  } else {
    pollId = setTimeout(() => poll(jobId), POLL_MS);
  }
}

function finish() {
  stopPolling();
  stopTimer();
  setBusy(false);
}

// ---- 6. submit -----------------------------------------------------------
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorBox.hidden = true;

  const file = fileInput.files && fileInput.files[0];
  const provider = providerSel.value;
  const model = modelInput.value.trim();
  const apiKey = keyInput.value.trim();

  if (!file) {
    showError('Please choose a .csv or .xlsx file.');
    fileInput.focus();
    return;
  }
  if (!/\.(csv|xlsx)$/i.test(file.name)) {
    showError('Please upload a .csv or .xlsx file.');
    return;
  }
  if (provider === 'gemini' && !apiKey) {
    showError('An API key is required for Gemini.');
    keyInput.focus();
    return;
  }

  const fd = new FormData();
  fd.append('file', file);
  fd.append('provider', provider);
  if (model) fd.append('model', model);
  if (apiKey) fd.append('api_key', apiKey);

  zipLink.hidden = true;
  rowsBody.textContent = '';
  setBusy(true);
  startTimer();

  let resp;
  try {
    resp = await fetch('/api/batch', { method: 'POST', body: fd });
  } catch (_networkErr) {
    showError('Could not reach the server. Is it running?');
    finish();
    return;
  }
  keyInput.value = '';                              // the key is not kept in the page

  if (!resp.ok) {
    showError(await errorMessageFromResponse(resp));
    finish();
    return;
  }

  const job = await resp.json();
  render(job);
  if (job.state === 'done') {
    finish();
  } else {
    pollId = setTimeout(() => poll(job.id), POLL_MS);
  }
});

// ---- 7. start -----------------------------------------------------------
updateProviderHints();
loadDefaults();
