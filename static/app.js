/* ------------------------------------------------------------------
   CV Optimiser - frontend logic

   Flow:  page loads -> fetch /api/defaults (for placeholders)
          user clicks Generate -> client-side checks
          -> POST /api/generate (1-3 minutes)
          -> 200: download the docx     non-200: show the error
   The API key is only ever read from the input box when the request is
   sent. It is never saved (no localStorage, no cookies).
   ------------------------------------------------------------------ */

'use strict';

// ---- 1. grab the elements we work with -------------------------------
const form         = document.getElementById('cv-form');
const jobInput     = document.getElementById('job_description');
const providerSel  = document.getElementById('provider');
const modelInput   = document.getElementById('model');
const modelHelp    = document.getElementById('model_help');
const keyInput     = document.getElementById('api_key');
const keyHelp      = document.getElementById('api_key_help');
const toggleKeyBtn = document.getElementById('toggle_key');
const generateBtn  = document.getElementById('generate');

const statusBox    = document.getElementById('status');
const elapsedEl    = document.getElementById('elapsed');
const errorBox     = document.getElementById('error');
const successBox   = document.getElementById('success');
const successText  = document.getElementById('success_text');
const downloadAgain = document.getElementById('download_again');

const FALLBACK_FILENAME = 'Md_Rawfur_Monzur_Jim_CV_new.docx';

// ---- 2. defaults (overwritten by /api/defaults if the call works) -----
// Same shape as the JSON the server returns, so one code path handles both.
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
    // Only accept the response if it has the parts we need.
    if (data && data.deepseek && data.gemini) defaults = data;
  } catch (_err) {
    // Offline or old server: silently keep the hard-coded defaults above.
  }
  updateProviderHints();
}

// ---- 3. placeholder / helper text that depends on the provider -------
function updateProviderHints() {
  const provider = providerSel.value;
  if (provider === 'gemini') {
    const g = defaults.gemini;
    modelInput.placeholder = g.extract_model;
    modelHelp.textContent  = 'Used for both steps. Leave blank for ' + g.extract_model + '.';
    keyHelp.textContent    = 'Required for Gemini.';
    keyInput.required      = true;
  } else {
    const d = defaults.deepseek;
    modelInput.placeholder = d.extract_model + ' (extract) + ' + d.rewrite_model + ' (rewrite)';
    modelHelp.textContent  = 'Leave blank to use the defaults. If you type a model it is used for both steps.';
    keyHelp.textContent    = "Optional. Leave blank to use the server's key from .env.";
    keyInput.required      = false;
  }
}

providerSel.addEventListener('change', updateProviderHints);

// ---- 4. show / hide the API key --------------------------------------
toggleKeyBtn.addEventListener('click', () => {
  const showing = keyInput.type === 'text';
  keyInput.type = showing ? 'password' : 'text';
  toggleKeyBtn.textContent = showing ? 'Show' : 'Hide';
  toggleKeyBtn.setAttribute('aria-pressed', String(!showing));
});

// ---- 5. small UI helpers ---------------------------------------------
function showError(message) {
  errorBox.textContent = message;
  errorBox.hidden = false;
}

function hideMessages() {
  errorBox.hidden = true;
  successBox.hidden = true;
}

// Disable everything while a request runs, so the user cannot double-submit.
function setBusy(busy) {
  generateBtn.disabled = busy;
  generateBtn.textContent = busy ? 'Generating…' : 'Generate CV';
  for (const el of [jobInput, providerSel, modelInput, keyInput, toggleKeyBtn]) {
    el.disabled = busy;
  }
  form.classList.toggle('busy', busy);
  statusBox.hidden = !busy;
}

// Elapsed-seconds counter shown next to the spinner.
let timerId = null;
let startedAt = 0;

function startTimer() {
  startedAt = Date.now();
  elapsedEl.textContent = '0 s';
  timerId = setInterval(() => {
    elapsedEl.textContent = secondsSince(startedAt) + ' s';
  }, 1000);
}

function stopTimer() {
  clearInterval(timerId);
  timerId = null;
  return secondsSince(startedAt);
}

function secondsSince(t) {
  return Math.round((Date.now() - t) / 1000);
}

// ---- 6. turning the API's error JSON into one readable line -----------
// 422 -> detail is a list of {loc, msg, ...}; every other error -> a string.
function messageFromDetail(detail, status) {
  if (Array.isArray(detail)) {
    const msgs = detail.map((d) => (d && d.msg) ? String(d.msg).replace(/^Value error, /, '') : '')
                       .filter(Boolean);
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

// ---- 7. the download -------------------------------------------------
// The blob from the last successful run is kept here so "Download again"
// works without another request. Replaced (and its URL revoked) on the next run.
let lastBlob = null;
let lastFilename = FALLBACK_FILENAME;

function filenameFromHeader(resp) {
  const cd = resp.headers.get('Content-Disposition') || '';
  const m = cd.match(/filename="([^"]+)"/);
  return m ? m[1] : FALLBACK_FILENAME;
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Give the browser a moment to start the download before freeing the URL.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

downloadAgain.addEventListener('click', (event) => {
  event.preventDefault();
  if (lastBlob) triggerDownload(lastBlob, lastFilename);
});

// ---- 8. submit -------------------------------------------------------
form.addEventListener('submit', async (event) => {
  event.preventDefault();      // stay on the page; we send the request ourselves
  hideMessages();

  const jobDescription = jobInput.value.trim();
  const provider = providerSel.value;
  const model = modelInput.value.trim();
  const apiKey = keyInput.value.trim();

  // Client-side checks: same wording as the server, but no round trip.
  if (!jobDescription) {
    showError('Job description is required');
    jobInput.focus();
    return;
  }
  if (provider === 'gemini' && !apiKey) {
    showError('An API key is required for Gemini.');
    keyInput.focus();
    return;
  }

  const payload = {
    job_description: jobDescription,
    provider: provider,
    model: model || null,       // blank -> null -> server uses its defaults
    api_key: apiKey || null,
  };

  setBusy(true);
  startTimer();

  try {
    let resp;
    try {
      resp = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch (_networkErr) {
      showError('Could not reach the server. Is it running?');
      return;
    }

    if (!resp.ok) {
      showError(await errorMessageFromResponse(resp));
      return;
    }

    // 200: the body is the .docx file itself.
    const filename = filenameFromHeader(resp);
    const blob = await resp.blob();
    lastBlob = blob;
    lastFilename = filename;
    triggerDownload(blob, filename);

    const title = (resp.headers.get('X-Job-Title') || '').trim() || titleFromFilename(filename);
    const seconds = secondsSince(startedAt);
    successText.textContent = 'Done in ' + seconds + ' s — ' + title;
    successBox.hidden = false;
  } finally {
    stopTimer();
    setBusy(false);
  }
});

// 'Md_Rawfur_Monzur_Jim_CV_Senior_AI_Engineer.docx' -> 'Senior AI Engineer'
function titleFromFilename(filename) {
  return filename
    .replace(/^Md_Rawfur_Monzur_Jim_CV_/, '')
    .replace(/\.docx$/i, '')
    .replace(/_/g, ' ')
    .trim() || 'CV';
}

// ---- 9. start ---------------------------------------------------------
updateProviderHints();   // sensible text immediately, even before the fetch returns
loadDefaults();
