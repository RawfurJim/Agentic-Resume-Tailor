#!/usr/bin/env node
/**
 * browser-description.mjs — the LAST resort for an Adzuna ad whose own details
 * page only holds the ~400-char snippet (round 7, Jim, 2026-09-23).
 *
 * For agency ads (Hackajob, Sirius, CBSbutler, FDM, …) Adzuna's details page has
 * the same teaser the search API sent. The full text sits on the employer's page
 * behind the API's `redirect_url` (`/jobs/land/ad/<id>`). That page is HTTP 200
 * with a 5 s `<meta http-equiv=refresh>` to a click tracker (click.jobroute.io,
 * click.appcast.io), and the trackers answer plain HTTP with a Cloudflare "Just a
 * moment / enable JavaScript" 403. Only a real browser gets through, so this
 * module opens the land link in headless Chromium, waits until the page has left
 * Adzuna and the trackers and no longer shows a challenge, then reads the text —
 * or, when the employer runs a known ATS, asks its public API instead.
 *
 * Jim's decisions: follow the link although Adzuna's robots.txt disallows
 * /jobs/land/ad/ (same trade-off as Google Careers); accept ~10–25 s per job;
 * one shared browser per process; never let this tier throw — null keeps the teaser.
 *
 * Playwright is imported lazily (`defaultLauncher`) so the scanner's unit tests and
 * every non-browser run never load it. Tests inject `launcher`, `sleep` and `now`.
 */

import { fetchJdViaKnownApi, compactText, readDom } from './browser-extract.mjs';
import { LIVENESS_CONTEXT_OPTIONS, rejectPrivateOrInvalid } from './liveness-browser.mjs';
import { isBetterText } from './full-description.mjs';

export const DEFAULT_BROWSER_TIMEOUT_MS = 30_000;
export const DEFAULT_TEXT_CAP = 20_000;

/** Text a bot wall shows instead of the page (Cloudflare, appcast, generic JS gates). */
export const CHALLENGE_MARKERS = [
  /Just a moment/i,
  /Enable JavaScript and cookies/i,
  /enable JS and disable/i,
  /Checking your browser/i,
  /Verify you are human/i,
  /Attention Required!?\s*\|\s*Cloudflare/i,
];

/** Hosts a land link passes through before the employer's page: Adzuna itself and any click.* tracker. */
export function isTrackerHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  return /(^|\.)adzuna\.[a-z.]+$/.test(h) || /^click\./.test(h);
}

/** @param {unknown} text */
export function looksLikeChallenge(text) {
  const s = typeof text === 'string' ? text : '';
  if (!s.trim()) return false;
  return CHALLENGE_MARKERS.some((re) => re.test(s));
}

const ABORT_RESOURCE_TYPES = new Set(['image', 'font', 'media']);

/**
 * Per-request route guard: 'abort' for private/loopback/invalid targets (SSRF),
 * non-http(s) schemes and images/fonts/media (bytes the text never needs);
 * 'continue' otherwise (documents, scripts, xhr — the trackers need JS to pass).
 * @param {string} url @param {string} resourceType
 * @returns {'abort'|'continue'}
 */
export function routeDecision(url, resourceType) {
  if (rejectPrivateOrInvalid(url)) return 'abort';
  if (!/^https?:/i.test(String(url))) return 'abort';
  if (ABORT_RESOURCE_TYPES.has(String(resourceType || '').toLowerCase())) return 'abort';
  return 'continue';
}

export const defaultLauncher = async () => (await import('playwright')).chromium.launch({ headless: true });
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── one shared browser per process ────────────────────────────────────────
let sharedBrowser = null;
let launching = null;

/** @param {Function} launcher */
async function getBrowser(launcher) {
  if (sharedBrowser) return sharedBrowser;
  if (!launching) {
    launching = (async () => {
      try { sharedBrowser = await launcher(); } catch { sharedBrowser = null; }
      launching = null;
      return sharedBrowser;
    })();
  }
  return launching;
}

/** Close the shared browser, if any. Idempotent, never throws. */
export async function closeBrowser() {
  const b = sharedBrowser;
  sharedBrowser = null;
  if (!b) return;
  try { await b.close(); } catch { /* already gone */ }
}

/** @param {string} s @param {number} n */
const cap = (s, n) => (s.length > n ? s.slice(0, n) : s);

/**
 * Open an Adzuna land link in the shared headless browser and return the
 * employer page's description, or null.
 * @param {string} landUrl
 * @param {{textCap?: number, timeoutMs?: number, current?: string, fetchKnownApi?: Function, launcher?: Function,
 *          sleep?: Function, now?: Function, pollMs?: number, hydrationMs?: number}} [opts]
 * @returns {Promise<{url: string, finalUrl: string, title?: string, text: string, via: 'browser'|'browser-api'}|null>}
 */
export async function fetchViaBrowser(landUrl, {
  textCap = DEFAULT_TEXT_CAP, timeoutMs = DEFAULT_BROWSER_TIMEOUT_MS, current = '',
  fetchKnownApi = fetchJdViaKnownApi, launcher = defaultLauncher, sleep = realSleep, now = Date.now,
  pollMs = 500, hydrationMs = 2_000,
} = {}) {
  if (rejectPrivateOrInvalid(landUrl)) return null;
  const browser = await getBrowser(launcher);
  if (!browser) return null;
  let context = null;
  try {
    context = await browser.newContext(LIVENESS_CONTEXT_OPTIONS);
    await context.route('**/*', async (route) => {
      const req = route.request();
      const decision = routeDecision(req.url(), req.resourceType());
      try {
        if (decision === 'abort') await route.abort('blockedbyclient');
        else await route.continue();
      } catch { /* the page may already be gone */ }
    });
    const page = await context.newPage();
    const start = now();
    await page.goto(landUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });

    // Settle: leave Adzuna and the click trackers, and no bot-wall text.
    let dom = await readDom(page);
    for (;;) {
      let host = '';
      try { host = new URL(page.url()).hostname; } catch { host = ''; }
      if (host && !isTrackerHost(host) && !looksLikeChallenge(dom.text)) break;
      if (now() - start >= timeoutMs) return null;
      await sleep(pollMs);
      dom = await readDom(page);
    }
    if (hydrationMs > 0) { await sleep(hydrationMs); dom = await readDom(page); }
    const finalUrl = page.url();
    if (rejectPrivateOrInvalid(finalUrl)) return null;

    // The employer runs a known ATS → its public API has the clean body.
    let known = null;
    try { known = await fetchKnownApi(finalUrl, textCap, timeoutMs); } catch { known = null; }
    if (known && isBetterText(known.text, current)) {
      return { url: landUrl, finalUrl, title: known.title, text: cap(known.text, textCap), via: 'browser-api' };
    }
    const text = cap(compactText(dom.text, textCap), textCap);
    if (isBetterText(text, current)) {
      const title = typeof dom.title === 'string' && dom.title ? dom.title : undefined;
      return { url: landUrl, finalUrl, title, text, via: 'browser' };
    }
    return null;
  } catch {
    return null;
  } finally {
    if (context) { try { await context.close(); } catch { /* ignore */ } }
  }
}
