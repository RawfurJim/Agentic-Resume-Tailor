/* ------------------------------------------------------------------
   CV Optimiser - scraped-jobs page logic

   Flow:  page loads -> fetch /api/defaults and /api/scrape/latest
          user adds Indeed links one at a time (Enter or Add), picks options
          -> POST /api/scrape (JSON)  -> job status JSON
          -> poll GET /api/scrape/{id} every 3 s while scraping / generating
          -> Generate CV on a row -> POST .../rows/{i}/generate, poll again
   The API key is read from the input box when a request is sent (start and
   every Generate click). It is never saved (no storage, no cookies).
   ------------------------------------------------------------------ */

'use strict';

// ---- 1. elements ------------------------------------------------------
const form         = document.getElementById('scrape-form');
const linkInput    = document.getElementById('indeed_link');
const addLinkBtn   = document.getElementById('add_link');
const linkHelp     = document.getElementById('link_help');
const linkList     = document.getElementById('indeed_list');
const linkCount    = document.getElementById('indeed_count');
const capInput     = document.getElementById('top_cap');
const limitInput   = document.getElementById('match_limit');
const reuseInput   = document.getElementById('reuse_latest');
const reuseHelp    = document.getElementById('reuse_help');
const providerSel  = document.getElementById('provider');
const modelInput   = document.getElementById('model');
const modelHelp    = document.getElementById('model_help');
const keyInput     = document.getElementById('api_key');
const keyHelp      = document.getElementById('api_key_help');
const toggleKeyBtn = document.getElementById('toggle_key');
const startBtn     = document.getElementById('start');

const statusBox    = document.getElementById('status');
const statusText   = document.getElementById('status_text');
const elapsedEl    = document.getElementById('elapsed');
const logBox       = document.getElementById('log_box');
const logPre       = document.getElementById('log');
const errorBox     = document.getElementById('error');
const resultsBox   = document.getElementById('results');
const progressText = document.getElementById('progress_text');
const zipLink      = document.getElementById('zip_link');
const rowsBody     = document.getElementById('rows');

const POLL_MS = 3000;
const LINK_HELP_DEFAULT = linkHelp.textContent;

// ---- 2. defaults (same as batch.js) ----------------------------------
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

async function loadLatest() {
  try {
    const resp = await fetch('/api/scrape/latest');
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const data = await resp.json();
    if (data && data.csv_name) {
      reuseHelp.textContent = 'Newest file: ' + data.csv_name
        + (typeof data.rows === 'number' ? ' (' + data.rows + ' jobs)' : '') + '.';
    } else {
      reuseHelp.textContent = 'No scraped file yet; the first run has to scrape.';
    }
  } catch (_err) {
    reuseHelp.textContent = '';
  }
}

function updateProviderHints() {
  const provider = providerSel.value;
  if (provider === 'gemini') {
    const g = defaults.gemini;
    modelInput.placeholder = g.extract_model;
    modelHelp.textContent  = 'Used for both steps. Leave blank for ' + g.extract_model + '.';
    keyHelp.textContent    = 'Required for Gemini. The scraper\'s matcher still uses the DeepSeek key in scraper/.env.';
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

// ---- 3. the Indeed link list --------------------------------------------
const links = [];                                  // in memory only

function jobKey(url) {
  const m = /[?&]v?jk=(\w{8,32})/.exec(url);
  return m ? m[1] : null;
}

function renderLinks() {
  linkList.textContent = '';
  links.forEach((url, i) => {
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.textContent = url;
    li.appendChild(span);
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'ghost small';
    rm.textContent = '✕';
    rm.setAttribute('aria-label', 'Remove link ' + (i + 1));
    rm.dataset.index = String(i);
    li.appendChild(rm);
    linkList.appendChild(li);
  });
  linkCount.textContent = links.length === 0
    ? 'No Indeed links — the Indeed step is skipped.'
    : links.length + (links.length === 1 ? ' link' : ' links') + ' — the Indeed step runs first.';
}

function addLink() {
  const url = linkInput.value.trim();
  linkHelp.textContent = LINK_HELP_DEFAULT;
  if (!url) return;
  if (!/^https?:\/\//i.test(url) || !/indeed\./i.test(url)) {
    linkHelp.textContent = 'That does not look like an Indeed link.';
    return;
  }
  const key = jobKey(url);
  if (!key) {
    linkHelp.textContent = 'The link needs the job key (jk= or vjk=). Open the job on Indeed and copy its address.';
    return;
  }
  if (links.some((u) => jobKey(u) === key)) {
    linkHelp.textContent = 'That job is already in the list.';
    linkInput.value = '';
    return;
  }
  links.push(url);
  linkInput.value = '';
  renderLinks();
  linkInput.focus();
}

function removeLink(index) {
  links.splice(index, 1);
  renderLinks();
}

addLinkBtn.addEventListener('click', addLink);
linkInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {                     // Enter adds a link, never submits the form
    event.preventDefault();
    addLink();
  }
});
linkList.addEventListener('click', (event) => {
  const btn = event.target.closest('button[data-index]');
  if (btn) removeLink(Number(btn.dataset.index));
});

// ---- 4. small UI helpers ---------------------------------------------
function showError(message) {
  errorBox.textContent = message;
  errorBox.hidden = false;
}

const formControls = [linkInput, addLinkBtn, capInput, limitInput, reuseInput, providerSel, modelInput];

function setBusy(busy) {
  startBtn.disabled = busy;
  startBtn.textContent = busy ? 'Working…' : 'Scrape and generate';
  for (const el of formControls) el.disabled = busy;
  form.classList.toggle('busy', busy);
  statusBox.hidden = !busy;
}

let timerId = null;
let startedAt = 0;

function startTimer() {
  startedAt = Date.now();
  elapsedEl.textContent = '0 s';
  timerId = setInterval(() => {
    const s = Math.round((Date.now() - startedAt) / 1000);
    elapsedEl.textContent = s < 120 ? s + ' s' : Math.floor(s / 60) + ' min ' + (s % 60) + ' s';
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

function currentModelBody() {
  const body = { provider: providerSel.value };
  const model = modelInput.value.trim();
  const apiKey = keyInput.value.trim();
  if (model) body.model = model;
  if (apiKey) body.api_key = apiKey;
  return body;
}

// ---- 5. drawing the table --------------------------------------------
function cell(tr, text) {
  const td = document.createElement('td');
  td.textContent = text;
  tr.appendChild(td);
  return td;
}

const MATCH_LABEL = { top: 'top', medium: 'medium', low: 'low', none: '—' };

function render(job) {
  const rows = job.rows || [];
  const c = job.counts || {};
  const parts = [(c.top || 0) + ' top', (c.medium || 0) + ' medium', (c.low || 0) + ' low'];
  if (c.none) parts.push(c.none + ' unscored / no description');
  let text = rows.length + ' jobs: ' + parts.join(' · ');
  if (rows.length) {
    text += ' — CVs: ' + (c.done || 0) + ' done';
    if (c.failed) text += ', ' + c.failed + ' failed';
    if (c.queued) text += ', ' + c.queued + ' queued';
  }
  progressText.textContent = text;

  statusText.textContent = job.phase || (job.state === 'scraping' ? 'Scraping…' : 'Working…');
  if (job.log && job.log.length) {
    logPre.textContent = job.log.join('\n');
    logBox.hidden = false;
    logPre.scrollTop = logPre.scrollHeight;
  }

  rowsBody.textContent = '';                       // clear and rebuild
  for (const r of rows) {
    const tr = document.createElement('tr');
    cell(tr, String(r.index + 1));

    const matchTd = cell(tr, '');
    const mb = document.createElement('span');
    mb.className = 'badge ' + (r.match || 'none');
    mb.textContent = MATCH_LABEL[r.match] || r.match;
    if (r.match_note && r.match === 'none') mb.title = r.match_note;
    matchTd.appendChild(mb);

    cell(tr, r.job_title || r.title || '');
    cell(tr, r.company || '');
    cell(tr, r.location || '');

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
    const statusClass = r.status === 'queued' ? 'running' : r.status;
    badge.className = 'badge ' + statusClass;
    badge.textContent = r.status === 'pending' ? (r.auto ? 'waiting' : '') : r.status;
    if (badge.textContent) statusTd.appendChild(badge);
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
    } else if (r.can_generate) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ghost small';
      btn.dataset.index = String(r.index);
      btn.textContent = r.status === 'failed' ? 'Retry' : 'Generate CV';
      btn.disabled = job.state === 'scraping';
      cvTd.appendChild(btn);
    }
    rowsBody.appendChild(tr);
  }

  if (job.zip_url) {
    zipLink.href = job.zip_url;
    zipLink.hidden = false;
  } else {
    zipLink.hidden = true;
  }
  resultsBox.hidden = false;
}

// ---- 6. polling --------------------------------------------------------
let pollId = null;
let currentJobId = null;

function stopPolling() {
  clearTimeout(pollId);
  pollId = null;
}

function isWorking(job) {
  return job.state === 'scraping' || job.state === 'generating';
}

async function poll(jobId) {
  let resp;
  try {
    resp = await fetch('/api/scrape/' + encodeURIComponent(jobId));
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
  if (isWorking(job)) {
    pollId = setTimeout(() => poll(jobId), POLL_MS);
  } else {
    finish();
    if (job.state === 'failed' && job.error) showError(job.error);
  }
}

function finish() {
  stopPolling();
  stopTimer();
  setBusy(false);
}

function track(job) {
  currentJobId = job.id;
  render(job);
  if (isWorking(job)) {
    if (!pollId) pollId = setTimeout(() => poll(job.id), POLL_MS);
  } else {
    finish();
    if (job.state === 'failed' && job.error) showError(job.error);
  }
}

// ---- 7. start -----------------------------------------------------------
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorBox.hidden = true;

  const provider = providerSel.value;
  const apiKey = keyInput.value.trim();
  if (provider === 'gemini' && !apiKey) {
    showError('An API key is required for Gemini.');
    keyInput.focus();
    return;
  }
  const cap = Number(capInput.value);
  if (!Number.isInteger(cap) || cap < 0 || cap > 200) {
    showError('Auto-generate must be a whole number between 0 and 200.');
    capInput.focus();
    return;
  }
  const body = currentModelBody();
  body.indeed_links = links.slice();
  body.reuse_latest = reuseInput.checked;
  body.top_cap = cap;
  const limit = limitInput.value.trim();
  if (limit) {
    const n = Number(limit);
    if (!Number.isInteger(n) || n < 1) {
      showError('Match at most N jobs must be a whole number of 1 or more.');
      limitInput.focus();
      return;
    }
    body.match_limit = n;
  }

  zipLink.hidden = true;
  rowsBody.textContent = '';
  logPre.textContent = '';
  logBox.hidden = true;
  resultsBox.hidden = true;
  statusText.textContent = 'Starting…';
  setBusy(true);
  startTimer();

  let resp;
  try {
    resp = await fetch('/api/scrape', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (_networkErr) {
    showError('Could not reach the server. Is it running?');
    finish();
    return;
  }
  if (!resp.ok) {
    showError(await errorMessageFromResponse(resp));
    finish();
    return;
  }
  track(await resp.json());
});

// ---- 8. Generate CV on one row --------------------------------------------
rowsBody.addEventListener('click', async (event) => {
  const btn = event.target.closest('button[data-index]');
  if (!btn || !currentJobId) return;
  errorBox.hidden = true;

  const body = currentModelBody();
  if (body.provider === 'gemini' && !body.api_key) {
    showError('An API key is required for Gemini.');
    keyInput.focus();
    return;
  }
  btn.disabled = true;
  btn.textContent = 'Queued…';

  let resp;
  try {
    resp = await fetch('/api/scrape/' + encodeURIComponent(currentJobId) + '/rows/' + btn.dataset.index + '/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (_networkErr) {
    showError('Could not reach the server. Is it running?');
    return;
  }
  if (!resp.ok) {
    showError(await errorMessageFromResponse(resp));
    if (currentJobId) poll(currentJobId);         // redraw the real state
    return;
  }
  statusText.textContent = 'Generating…';
  setBusy(true);
  if (!timerId) startTimer();
  track(await resp.json());
});

// ---- 9. start -----------------------------------------------------------
renderLinks();
updateProviderHints();
loadDefaults();
loadLatest();
