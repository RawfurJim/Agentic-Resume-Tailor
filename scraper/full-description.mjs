#!/usr/bin/env node
/**
 * full-description.mjs — get the WHOLE job description for one posting URL
 * (round 6, Jim, 2026-09-22).
 *
 * The CV matcher scores a job on its description, and two sources hand the
 * scanner only a teaser: Adzuna's search API cuts at ~500 chars, Reed's search
 * API at ~450. This module knows where the full text lives:
 *
 *   reed.co.uk/jobs/<slug>/<id>
 *     1. official Jobseeker API, per job: GET /api/1.0/jobs/<id> (same
 *        REED_API_KEY Basic auth as the search) → `jobDescription` HTML
 *     2. the public job page: schema.org JSON-LD JobPosting `description`
 *   adzuna.<tld>/jobs/land/ad/<id>?…   (the API's redirect_url)
 *     1. Adzuna's own copy of the ad: https://<host>/jobs/details/<id>
 *        (JSON-LD JobPosting, else the `adp-body` section). robots.txt
 *        (read 2026-09-22) ALLOWS /jobs/details/ and DISALLOWS /jobs/land/ad/,
 *        so this is the route; verified live on the A&O Shearman ad (4.2k chars).
 *        A details page that answers 404 but still carries the posting
 *        (expired ad) is read the same way (round 7).
 *     2. OPT-IN ONLY (`followRedirect: true`; off by default to respect that
 *        robots rule): follow the land redirect by hand (≤ 5 hops, https only,
 *        every hop through the SSRF guard) to the employer's page: known ATS →
 *        its public API (fetchJdViaKnownApi); anything else → the page's
 *        JSON-LD, a known description container, or the stripped body text.
 *        Useless in practice: the land page meta-refreshes to a click tracker
 *        that answers plain HTTP with a Cloudflare JavaScript challenge.
 *     3. OPT-IN (`browser: true`, round 7, Jim 2026-09-23): open the land link
 *        in headless Chromium (browser-description.mjs) and read the employer's
 *        page once it has left Adzuna/the trackers — known ATS → its API
 *        (`via: 'browser-api'`), else the page text (`via: 'browser'`). Jim
 *        accepted the robots trade-off and the ~10–25 s per job; Playwright is
 *        only imported when this tier is actually used.
 *   www.google.com/about/careers/applications/jobs/results/<id>-<slug>
 *     the posting's own page: its ds:0 init block holds the whole job
 *     (providers/google.mjs extractJobDetail). A removed posting answers with
 *     an ErrorDetails block → null (2026-09-23: the "AI Architect, Partner
 *     Engineering" ad Jim saw without a description was exactly that).
 *   any other host
 *     fetchJdViaKnownApi() — Greenhouse / Lever / Ashby / Workday, as before
 *
 * Contract: never throws; `null` means "nothing better than what you have".
 * A result is only returned when it is a real description (≥ 200 chars) and,
 * when `current` (the teaser) is given, clearly longer than it. The scanner
 * keeps the teaser on a miss — a title and link are never lost over a body.
 *
 * Deliberately does NOT import scan.mjs or job-descriptions.mjs (the latter
 * imports this file). Transport goes through providers/_http.mjs so the DNS
 * guard and timeout apply; tests inject fakes through `opts`.
 */

import { fetchJson as httpFetchJson, fetchText as httpFetchText, fetchResponse as httpFetchResponse, BROWSER_LIKE_USER_AGENT } from './providers/_http.mjs';
import { fetchJdViaKnownApi, jdHtmlToText } from './browser-extract.mjs';
import { rejectPrivateOrInvalid } from './liveness-browser.mjs';
import { jobPostingDescription } from './providers/_jsonld.mjs';
import { extractJobDetail } from './providers/google.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

/** Same floor as job-descriptions.mjs MIN_DESCRIPTION_CHARS (not imported: that file imports this one). */
export const MIN_FULL_TEXT_CHARS = 200;
/** Same cap as job-descriptions.mjs MAX_DESCRIPTION_CHARS. */
export const DEFAULT_TEXT_CAP = 20_000;
export const DEFAULT_TIMEOUT_MS = 15_000;
/** A land/ad link normally hops once or twice (Adzuna → tracker → employer). */
export const MAX_REDIRECT_HOPS = 5;
/** The browser tier waits this long for the land → tracker → employer hops to settle. */
export const DEFAULT_BROWSER_TIMEOUT_MS = 30_000;
export const REED_ENV_KEY = 'REED_API_KEY';

const REED_HOSTS = new Set(['www.reed.co.uk', 'reed.co.uk']);
const ADZUNA_HOST_RE = /(^|\.)adzuna\.[a-z.]+$/;
const GOOGLE_HOST = 'www.google.com';
const GOOGLE_POSTING_RE = /^\/about\/careers\/applications\/jobs\/results\/(\d+)(?:-[^/]*)?\/?$/;
const PAGE_HEADERS = { 'user-agent': BROWSER_LIKE_USER_AGENT, accept: 'text/html,application/xhtml+xml' };

/**
 * Which route a URL takes. Exported for tests and for backfill's reporting.
 * @param {string} url
 * @returns {'reed'|'adzuna'|'google'|'other'|null}  null = not an https URL
 */
export function sourceKind(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  if (REED_HOSTS.has(u.hostname) && reedJobId(u)) return 'reed';
  if (ADZUNA_HOST_RE.test(u.hostname) && adzunaAdId(u)) return 'adzuna';
  if (u.hostname === GOOGLE_HOST && GOOGLE_POSTING_RE.test(u.pathname)) return 'google';
  return 'other';
}

/** `/jobs/<slug>/<id>` or `/jobs/<id>` → id digits, else ''. @param {URL} u */
export function reedJobId(u) {
  const m = u.pathname.match(/^\/jobs\/(?:[^/]+\/)?(\d+)\/?$/);
  return m ? m[1] : '';
}

/** `/jobs/land/ad/<id>` or `/jobs/details/<id>` → id digits, else ''. @param {URL} u */
export function adzunaAdId(u) {
  const m = u.pathname.match(/^\/jobs\/(?:land\/ad|details)\/(\d+)\/?$/);
  return m ? m[1] : '';
}

/**
 * Is `text` a usable improvement over `current`? Real (≥ 200 chars) and, when
 * there is a current teaser, at least 10% longer than it — the same rule
 * job-descriptions.mjs shouldStoreDescription applies at the store.
 * @param {string} text
 * @param {string} [current]
 */
export function isBetterText(text, current = '') {
  if (typeof text !== 'string' || text.trim().length < MIN_FULL_TEXT_CHARS) return false;
  const cur = typeof current === 'string' ? current.trim().length : 0;
  return cur === 0 || text.trim().length > cur * 1.1;
}

/** @param {string} s @param {number} cap */
function cap(s, cap) {
  return s.length > cap ? s.slice(0, cap) : s;
}

// ── HTML → description text ───────────────────────────────────────────────

// Elements that never hold the posting body; removed before any text fallback.
const CHROME_RE = /<(script|style|noscript|svg|nav|header|footer|aside|form|iframe|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
// Attribute markers of the container sites put the description in.
const CONTAINER_MARKERS = [
  /class=["'][^"']*\badp-body\b/i,                                   // Adzuna details page
  /id=["']jobDescriptionText["']/i,                                  // Indeed-style
  /itemprop=["']description["']/i,                                   // schema.org microdata
  /class=["'][^"']*\b(?:job-?description|jobDescription|posting-description|description__content|job_description|jobdesc|job-details-description)\b/i,
  /<main\b/i,
  /<article\b/i,
];

/**
 * Inner HTML of the element whose opening tag starts at `start`, honouring
 * nesting of the same tag name. Returns '' when the close is missing.
 * @param {string} html @param {number} start
 */
export function elementInnerHtml(html, start) {
  const open = html.slice(start).match(/^<([a-zA-Z][\w-]*)\b[^>]*>/);
  if (!open) return '';
  const tag = open[1].toLowerCase();
  const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi');
  re.lastIndex = start + open[0].length;
  let depth = 1;
  let m;
  while ((m = re.exec(html))) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return html.slice(start + open[0].length, m.index);
  }
  return '';
}

/**
 * The first container matching any marker → its text, else ''.
 * A `class=`/`id=`/`itemprop=` marker sits inside an opening tag; walk back to its `<`.
 * @param {string} html
 */
export function containerText(html) {
  for (const marker of CONTAINER_MARKERS) {
    const m = html.match(marker);
    if (!m || m.index == null) continue;
    const start = m[0].startsWith('<') ? m.index : html.lastIndexOf('<', m.index);
    if (start < 0) continue;
    const text = jdHtmlToText(elementInnerHtml(html, start));
    if (text.length >= MIN_FULL_TEXT_CHARS) return text;
  }
  return '';
}

/**
 * Best-effort description text from any job page's HTML, in order of trust:
 * JSON-LD JobPosting body → a known description container → the body with
 * nav/header/footer/scripts removed. '' when nothing reaches the floor.
 * Pure — exported for tests.
 * @param {unknown} html
 * @param {number} [textCap]
 */
export function extractDescriptionFromHtml(html, textCap = DEFAULT_TEXT_CAP) {
  if (typeof html !== 'string' || !html) return '';
  const ld = jdHtmlToText(jobPostingDescription(html));
  if (ld.length >= MIN_FULL_TEXT_CHARS) return cap(ld, textCap);
  const fromContainer = containerText(html);
  if (fromContainer) return cap(fromContainer, textCap);
  const bodyMatch = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  const body = jdHtmlToText((bodyMatch ? bodyMatch[1] : html).replace(CHROME_RE, ' '));
  return body.length >= MIN_FULL_TEXT_CHARS ? cap(body, textCap) : '';
}

// ── transports ────────────────────────────────────────────────────────────

/**
 * Follow redirects by hand so every hop passes the SSRF guard and stays on
 * https. Resolves to `{ url, html }` of the first 2xx page, or null.
 * `fetchResponse` must behave like providers/_http.mjs fetchResponse under
 * redirect:'manual' — a 3xx surfaces as a thrown error carrying `status` and
 * `location`.
 * @param {string} startUrl
 * @param {{fetchResponse: Function, timeoutMs: number, maxHops?: number}} deps
 */
export async function followToPage(startUrl, { fetchResponse, timeoutMs, maxHops = MAX_REDIRECT_HOPS }) {
  let url = startUrl;
  for (let hop = 0; hop <= maxHops; hop++) {
    if (rejectPrivateOrInvalid(url) || !url.startsWith('https://')) return null;
    let res;
    try {
      res = await fetchResponse(url, { redirect: 'manual', headers: PAGE_HEADERS, timeoutMs });
    } catch (err) {
      const status = Number(err?.status);
      const location = typeof err?.location === 'string' ? err.location : '';
      if (status >= 300 && status < 400 && location) {
        try { url = new URL(location, url).href; } catch { return null; }
        continue;
      }
      return null;
    }
    if (!res || !res.ok) return null;
    const html = await res.text();
    return { url, html };
  }
  return null; // too many hops
}

/** @param {any} env */
function reedAuthHeaders(env) {
  const key = String(env?.[REED_ENV_KEY] || '').trim();
  return key ? { authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}`, accept: 'application/json' } : null;
}

/**
 * @typedef {{url: string, title?: string, text: string, via: string}} FullDescription
 */

/**
 * Full text for a Reed posting: detail API first, public page second.
 * @param {URL} u
 * @param {{fetchJson: Function, fetchText: Function, textCap: number, timeoutMs: number, env: any, current: string}} d
 * @returns {Promise<FullDescription|null>}
 */
async function fetchReed(u, d) {
  const id = reedJobId(u);
  const headers = reedAuthHeaders(d.env);
  if (headers) {
    try {
      const body = await d.fetchJson(`https://www.reed.co.uk/api/1.0/jobs/${id}`, { headers, redirect: 'error', timeoutMs: d.timeoutMs });
      const text = jdHtmlToText(body?.jobDescription);
      if (isBetterText(text, d.current)) {
        return { url: u.href, title: typeof body?.jobTitle === 'string' ? body.jobTitle : undefined, text: cap(text, d.textCap), via: 'reed-detail-api' };
      }
    } catch { /* fall through to the page */ }
  }
  try {
    const html = await d.fetchText(u.href, { headers: PAGE_HEADERS, redirect: 'error', timeoutMs: d.timeoutMs });
    const text = extractDescriptionFromHtml(html, d.textCap);
    if (isBetterText(text, d.current)) return { url: u.href, text, via: 'reed-page' };
  } catch { /* miss */ }
  return null;
}

/**
 * Full text for one Google Careers posting: its own page's ds:0 block.
 * @param {URL} u
 * @param {{fetchText: Function, textCap: number, timeoutMs: number, current: string}} d
 * @returns {Promise<FullDescription|null>}
 */
async function fetchGoogle(u, d) {
  try {
    const html = await d.fetchText(u.href, { headers: PAGE_HEADERS, redirect: 'error', timeoutMs: d.timeoutMs });
    const job = extractJobDetail(html);
    const text = typeof job?.description === 'string' ? job.description.trim() : '';
    if (isBetterText(text, d.current)) return { url: u.href, title: job.title || undefined, text: cap(text, d.textCap), via: 'google-page' };
  } catch { /* 404, interstitial, … → nothing better */ }
  return null;
}

/**
 * Full text for an Adzuna ad: Adzuna's details page first, the employer's
 * page (via the land redirect) second.
 * @param {URL} u
 * @param {{fetchText: Function, fetchResponse: Function, fetchKnownApi: Function, textCap: number, timeoutMs: number, current: string, detailsPage: boolean, followRedirect: boolean,
 *          browser: boolean, browserFetch: Function, browserTimeoutMs: number}} d
 * @returns {Promise<FullDescription|null>}
 */
async function fetchAdzuna(u, d) {
  const id = adzunaAdId(u);
  if (d.detailsPage) {
    try {
      const html = await d.fetchText(`https://${u.hostname}/jobs/details/${id}`, { headers: PAGE_HEADERS, redirect: 'error', timeoutMs: d.timeoutMs });
      const text = extractDescriptionFromHtml(html, d.textCap);
      if (isBetterText(text, d.current)) return { url: u.href, text, via: 'adzuna-details' };
    } catch (err) {
      // An expired ad answers 404 with the posting still in the body (seen 2026-09-23).
      if (typeof err?.body === 'string') {
        const text = extractDescriptionFromHtml(err.body, d.textCap);
        if (isBetterText(text, d.current)) return { url: u.href, text, via: 'adzuna-details' };
      }
      /* CloudFront 403, 404, … → try the source */
    }
  }
  const isLand = /\/jobs\/land\/ad\//.test(u.pathname);
  if (d.followRedirect && isLand) {
    const page = await followToPage(u.href, { fetchResponse: d.fetchResponse, timeoutMs: d.timeoutMs });
    if (page) {
      // The employer runs a known ATS → its public API has the clean body.
      let known = null;
      try { known = await d.fetchKnownApi(page.url, d.textCap, d.timeoutMs); } catch { known = null; }
      if (known && isBetterText(known.text, d.current)) return { url: u.href, title: known.title, text: cap(known.text, d.textCap), via: 'source-api' };
      const text = extractDescriptionFromHtml(page.html, d.textCap);
      if (isBetterText(text, d.current)) return { url: u.href, text, via: 'source-page' };
    }
  }
  if (d.browser && isLand) {
    try {
      const r = await d.browserFetch(u.href, { textCap: d.textCap, timeoutMs: d.browserTimeoutMs, current: d.current, fetchKnownApi: d.fetchKnownApi });
      if (r && isBetterText(r.text, d.current)) {
        return { ...r, url: u.href, text: cap(r.text, d.textCap), via: typeof r.via === 'string' && r.via ? r.via : 'browser' };
      }
    } catch { /* Chromium missing / crashed / blocked → keep the teaser */ }
  }
  return null;
}

/** Default browser tier: Playwright is only loaded when an Adzuna land link actually needs it. */
async function lazyBrowserFetch(url, opts) {
  const { fetchViaBrowser } = await import('./browser-description.mjs');
  return fetchViaBrowser(url, opts);
}

/**
 * The full description for one posting URL, or null. Same positional shape as
 * fetchJdViaKnownApi (url, textCap, timeoutMs) so it drops in wherever that
 * was the `fetchJd` — plus `opts`:
 *   current         the teaser we already hold; a result must beat it by 10%
 *   detailsPage     false disables Adzuna's own details page (default true — robots.txt allows it)
 *   followRedirect  true also follows Adzuna's land/ad redirect to the employer's page when the
 *                   details page has nothing better (default FALSE — robots.txt disallows /jobs/land/ad/)
 *   browser         true opens an Adzuna land/ad link in headless Chromium when the details page only
 *                   has the snippet (default FALSE; `via` becomes `browser` or `browser-api`)
 *   browserFetch    the browser tier (default: browser-description.mjs fetchViaBrowser, imported lazily)
 *   browserTimeoutMs  budget for the browser tier (default 30 000)
 *   env             where REED_API_KEY is read from (default process.env)
 *   fetchJson / fetchText / fetchResponse / fetchKnownApi   injectable transports (tests)
 * @param {string} url
 * @param {number} [textCap]
 * @param {number} [timeoutMs]
 * @param {{current?: string, detailsPage?: boolean, followRedirect?: boolean, browser?: boolean, browserFetch?: Function,
 *          browserTimeoutMs?: number, env?: any, fetchJson?: Function, fetchText?: Function,
 *          fetchResponse?: Function, fetchKnownApi?: Function}} [opts]
 * @returns {Promise<FullDescription|null>}
 */
export async function fetchFullDescription(url, textCap = DEFAULT_TEXT_CAP, timeoutMs = DEFAULT_TIMEOUT_MS, opts = {}) {
  const kind = sourceKind(url);
  if (!kind) return null;
  const d = {
    textCap, timeoutMs,
    current: typeof opts.current === 'string' ? opts.current : '',
    detailsPage: opts.detailsPage !== false,
    followRedirect: opts.followRedirect === true,
    browser: opts.browser === true,
    browserFetch: typeof opts.browserFetch === 'function' ? opts.browserFetch : lazyBrowserFetch,
    browserTimeoutMs: Number.isFinite(opts.browserTimeoutMs) ? opts.browserTimeoutMs : DEFAULT_BROWSER_TIMEOUT_MS,
    env: opts.env ?? process.env,
    fetchJson: opts.fetchJson ?? httpFetchJson,
    fetchText: opts.fetchText ?? httpFetchText,
    fetchResponse: opts.fetchResponse ?? httpFetchResponse,
    fetchKnownApi: opts.fetchKnownApi ?? fetchJdViaKnownApi,
  };
  try {
    const u = new URL(url);
    if (kind === 'reed') return await fetchReed(u, d);
    if (kind === 'adzuna') return await fetchAdzuna(u, d);
    if (kind === 'google') return await fetchGoogle(u, d);
    const known = await d.fetchKnownApi(url, textCap, timeoutMs);
    if (known && isBetterText(known.text, d.current)) return { url, title: known.title, text: cap(known.text, textCap), via: 'api' };
  } catch { /* never throw: a miss keeps the teaser */ }
  return null;
}

// Tiny CLI for checking one URL by hand: `node full-description.mjs [--browser] <url>`.
// fetch-jd.mjs is the documented front door; this exists so the module can be
// exercised without the metadata header fetch-jd adds.
if (isMainModule(import.meta.url)) {
  const argv = process.argv.slice(2);
  const browser = argv.includes('--browser');
  const url = argv.find((a) => !a.startsWith('--'));
  if (!url) { console.error('usage: node full-description.mjs [--browser] <posting url>'); process.exit(1); }
  (async () => {
    let r = await fetchFullDescription(url, DEFAULT_TEXT_CAP, DEFAULT_TIMEOUT_MS, { browser });
    // Same rule as fetch-jd.mjs: with --browser, a details-page snippet is only the bar to beat.
    if (browser && r && !String(r.via).startsWith('browser') && /\/jobs\/land\/ad\//.test(url)) {
      const better = await fetchFullDescription(url, DEFAULT_TEXT_CAP, DEFAULT_TIMEOUT_MS, { browser: true, detailsPage: false, current: r.text });
      if (better) r = better;
    }
    return r;
  })().then(async (r) => {
    if (browser) { try { await (await import('./browser-description.mjs')).closeBrowser(); } catch { /* not launched */ } }
    if (!r) { console.error('no full description found'); process.exit(1); }
    console.error(`via ${r.via}, ${r.text.length} chars`);
    process.stdout.write(r.text + '\n');
  });
}
