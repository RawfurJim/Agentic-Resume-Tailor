// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */
// Microsoft Careers provider — reads the public JSON search API behind
// https://apply.careers.microsoft.com/careers (an Eightfold "PCS" tenant on a
// Microsoft-owned host).
//
// Why not providers/eightfold.mjs: that provider is host-pinned to
// *.eightfold.ai and calls /api/apply/v2/jobs, which this tenant answers with
// 403. The PCS tenant exposes a different endpoint that works without cookies:
//
//   GET https://apply.careers.microsoft.com/api/pcsx/search
//       ?domain=microsoft.com&query=<q>&location=<country>&start=<n>&num=10
//   → { status: 200, data: { positions: [...], count: <total> } }
//   Per position: id (number), displayJobId, name, locations[]
//   ("United Kingdom, London, London"), standardizedLocations[]
//   ("London, England, GB"), postedTs / creationTs (epoch SECONDS), department,
//   workLocationOption ("onsite" | "hybrid" | …), positionUrl ("/careers/job/<id>").
//
// robots.txt on the host ALLOWS /careers, /api/apply and /api/pcsx (checked
// 2026-09-21). Page size is server-capped at 10, so a search costs count/10
// requests; `max_pages` bounds that (default 10, hard cap 50). The host does
// rate-limit bursts (HTTP 429 "Please try again later" seen on a cold first
// request), so pages are fetched sequentially with a short pause.
//
// A tracked_companies entry narrows the global board by the search it points at:
//
//   - name: Microsoft
//     provider: microsoft               # optional — the host is auto-detected
//     careers_url: https://apply.careers.microsoft.com/careers?query=AI%20Engineer&location=United%20Kingdom
//     microsoft:                        # optional overrides for the lifted params
//       query: "Machine Learning"
//       location: "United Kingdom"
//     max_pages: 10                     # 10 jobs/page (default 10, hard cap 50)

import { fetchJsonWithRetry, sleep, BROWSER_LIKE_USER_AGENT } from './_http.mjs';
import { htmlToText } from './_html-to-text.mjs';
import { intInRange } from './_config-utils.mjs';

export const TRUSTED_HOST = 'apply.careers.microsoft.com';
export const API_PATH = '/api/pcsx/search';
export const CAREERS_PATH = '/careers';
export const DOMAIN = 'microsoft.com';
export const PAGE_SIZE = 10; // server-capped
export const DEFAULT_MAX_PAGES = 10;
export const MAX_PAGES_CAP = 50;
// Round 5 (2026-09-22): Jim's first real run lost page 2 of "Microsoft" to a
// 429 after the default two retries — three Microsoft entries page back-to-back
// and the host limits bursts. Pages are now 1.5 s apart and a page gets four
// retries from a 2 s base (Retry-After is honoured by withRetry when sent).
export const INTER_PAGE_DELAY_MS = 1500;
export const RETRY_POLICY = Object.freeze({ retries: 4, baseDelayMs: 2000, maxDelayMs: 20_000 });
// Eightfold's job-detail endpoint: full posting as `job_description` HTML.
// robots.txt on the host allows /api/apply (checked 2026-09-22). Opt-in per
// entry via `microsoft: { fetchDetails: true }` — one extra request per job.
export const DETAIL_PATH = '/api/apply/v2/jobs/';

const ORIGIN = `https://${TRUSTED_HOST}`;
const JOB_BASE = `${ORIGIN}${CAREERS_PATH}/job/`;

// Sanity window for timestamps: 2000-01-01 .. one year from now.
const MIN_TS_SECONDS = 946_684_800;

/**
 * SSRF guard: only the Microsoft careers host, over HTTPS, and only the
 * careers UI or the PCS search API paths. Every fetch goes through it.
 * @param {unknown} url
 * @returns {string}
 */
export function assertMicrosoftUrl(url) {
  if (typeof url !== 'string' || !url.trim()) throw new Error('microsoft: careers_url is required');
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`microsoft: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`microsoft: URL must use HTTPS: ${url}`);
  if (parsed.hostname.toLowerCase() !== TRUSTED_HOST) {
    throw new Error(`microsoft: untrusted hostname "${parsed.hostname}" — must be ${TRUSTED_HOST}`);
  }
  if (!parsed.pathname.startsWith(CAREERS_PATH) && !parsed.pathname.startsWith('/api/pcsx')
    && !parsed.pathname.startsWith(DETAIL_PATH)) {
    throw new Error(`microsoft: URL must point at ${CAREERS_PATH}, /api/pcsx or ${DETAIL_PATH}: ${url}`);
  }
  return url;
}

/**
 * @param {{provider?: unknown, careers_url?: unknown}|null|undefined} entry
 * @returns {{url: string}|null}
 */
export function detectMicrosoftEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (entry.provider !== undefined && entry.provider !== 'microsoft') return null;
  if (entry.provider === 'microsoft') {
    return typeof entry.careers_url === 'string' ? { url: entry.careers_url } : null;
  }
  try {
    return { url: assertMicrosoftUrl(entry.careers_url) };
  } catch {
    return null;
  }
}

/** @param {unknown} v */
function cleanParam(v) {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * The PCS search URL for one page. `query` and `location` come from
 * `entry.microsoft` when set, else are lifted from the careers_url the user
 * copied out of the browser. The UI writes location as "London, England, GB"
 * while the API wants a plain country/city, so only the text before the first
 * comma is kept.
 * @param {{careers_url?: unknown, microsoft?: {query?: unknown, location?: unknown}}} entry
 * @param {number} start
 * @returns {string}
 */
export function buildSearchUrl(entry, start) {
  const source = new URL(assertMicrosoftUrl(entry?.careers_url));
  const override = entry?.microsoft && typeof entry.microsoft === 'object' ? entry.microsoft : {};
  const query = cleanParam(override.query) || cleanParam(source.searchParams.get('query'));
  const rawLocation = cleanParam(override.location) || cleanParam(source.searchParams.get('location'));
  const location = rawLocation.split(',')[0].trim();

  const u = new URL(`${ORIGIN}${API_PATH}`);
  u.searchParams.set('domain', DOMAIN);
  if (query) u.searchParams.set('query', query);
  if (location) u.searchParams.set('location', location);
  u.searchParams.set('start', String(Math.max(0, Math.trunc(Number(start) || 0))));
  u.searchParams.set('num', String(PAGE_SIZE));
  return assertMicrosoftUrl(u.href);
}

/**
 * @param {unknown} sec epoch seconds
 * @returns {number|undefined} epoch ms
 */
function secondsToMs(sec) {
  const n = typeof sec === 'string' ? Number(sec) : sec;
  if (!Number.isInteger(n)) return undefined;
  const maxSec = Date.now() / 1000 + 365 * 86_400;
  if (n < MIN_TS_SECONDS || n > maxSec) return undefined;
  return n * 1000;
}

/** @param {unknown} v */
function stringList(v) {
  return Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x.trim() : '')).filter(Boolean) : [];
}

/**
 * One `data.positions[]` row → Job. Returns null when the row cannot yield a
 * safe URL (id must be all digits) or has no title. The job URL is rebuilt
 * from the id on the trusted host — `positionUrl` is never followed as-is.
 * @param {any} p
 * @returns {import('./_types.js').Job|null}
 */
export function positionToJob(p) {
  if (!p || typeof p !== 'object') return null;
  const rawId = p.id;
  const id = typeof rawId === 'number' && Number.isSafeInteger(rawId) && rawId >= 0
    ? String(rawId)
    : (typeof rawId === 'string' ? rawId.trim() : '');
  if (!/^\d+$/.test(id)) return null;
  const title = htmlToText(typeof p.name === 'string' ? p.name : '');
  if (!title) return null;

  const locations = stringList(p.locations);
  const location = (locations.length ? locations : stringList(p.standardizedLocations)).join(' · ');
  const description = [p.department, p.workLocationOption]
    .map((v) => (typeof v === 'string' ? htmlToText(v) : ''))
    .filter(Boolean)
    .join(' · ');

  return {
    title,
    url: `${JOB_BASE}${id}`,
    company: 'Microsoft',
    location,
    description,
    postedAt: secondsToMs(p.postedTs) ?? secondsToMs(p.creationTs),
  };
}

/**
 * Validate one API page. Throws when the payload is not the expected shape so
 * a WAF page or a redesign surfaces as a broken board instead of an empty one.
 * @param {unknown} body
 * @returns {{positions: any[], count: number|null}}
 */
export function parseSearchPage(body) {
  const data = body && typeof body === 'object' ? /** @type {any} */ (body).data : null;
  const positions = data && typeof data === 'object' ? data.positions : undefined;
  if (!Array.isArray(positions)) {
    throw new Error('microsoft: response carried no data.positions array — API changed or request was blocked');
  }
  const count = Number.isFinite(Number(data.count)) ? Number(data.count) : null;
  return { positions, count };
}

/** @type {Provider} */
export default {
  id: 'microsoft',

  detect(entry) {
    return detectMicrosoftEntry(entry);
  },

  async fetch(entry, ctx) {
    assertMicrosoftUrl(entry.careers_url);
    const entryName = typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : 'Microsoft';
    // `max_pages` is the user's setting (clamped to the cap); `ctx.maxPages` is
    // a caller-side bound — verify-portals' health probe passes 1.
    const probeCap = Number.isInteger(ctx?.maxPages) && ctx.maxPages > 0 ? ctx.maxPages : Infinity;
    // 0, negative or non-numeric means "not set" → default, not "1 page".
    const rawMax = Number(entry.max_pages);
    const entryCap = Number.isFinite(rawMax) && rawMax > 0
      ? intInRange(rawMax, DEFAULT_MAX_PAGES, 1, MAX_PAGES_CAP)
      : DEFAULT_MAX_PAGES;
    const maxPages = Math.min(entryCap, probeCap);
    const isProbe = probeCap !== Infinity;

    /** @type {import('./_types.js').Job[]} */
    const jobs = [];
    const seen = new Set();
    let count = null;
    let truncated = false;

    for (let page = 0; page < maxPages; page++) {
      const start = page * PAGE_SIZE;
      if (page > 0) await sleep(INTER_PAGE_DELAY_MS, ctx);
      const url = buildSearchUrl(entry, start);

      let body;
      try {
        body = await fetchJsonWithRetry(ctx, url, requestOptions(), RETRY_POLICY);
      } catch (err) {
        // Under a health probe the caller wants the raw failure. In a scan, a
        // later page failing must not throw away the pages already fetched.
        if (isProbe || page === 0) throw err;
        console.error(`⚠️  microsoft: page ${page + 1} of "${entryName}" failed (${/** @type {Error} */ (err).message}) — keeping ${jobs.length} job(s) from earlier pages`);
        return jobs;
      }

      const parsed = parseSearchPage(body);
      if (parsed.count != null) count = parsed.count;
      if (parsed.positions.length === 0) break;

      const before = seen.size;
      for (const p of parsed.positions) {
        const job = positionToJob(p);
        if (!job || seen.has(job.url)) continue;
        seen.add(job.url);
        jobs.push(job);
      }
      if (seen.size === before) break; // every row already seen → past the end
      const nextStart = start + PAGE_SIZE;
      if (count != null && nextStart >= count) break;
      if (parsed.positions.length < PAGE_SIZE) break; // short page → last page
      if (page === maxPages - 1) truncated = count == null || nextStart < count;
    }

    if (truncated && !isProbe) {
      console.error(`⚠️  microsoft: "${entryName}" stopped at max_pages=${entryCap} with more results available${count != null ? ` (${count} total)` : ''} — narrow the search or raise max_pages (cap ${MAX_PAGES_CAP})`);
    }
    if (!isProbe && wantsDetails(entry)) await enrichDescriptions(jobs, ctx, entryName);
    return jobs;
  },
};

/** Headers every request to the host sends; kept in one place so the search and detail calls cannot drift. */
function requestOptions() {
  return {
    headers: {
      'user-agent': BROWSER_LIKE_USER_AGENT,
      accept: 'application/json, text/plain, */*',
      'accept-language': 'en-GB,en;q=0.9',
      referer: `${ORIGIN}${CAREERS_PATH}`,
    },
    redirect: 'error',
    timeoutMs: 20_000,
  };
}

/** @param {any} entry */
function wantsDetails(entry) {
  const cfg = entry?.microsoft;
  return !!(cfg && typeof cfg === 'object' && cfg.fetchDetails === true);
}

/**
 * Replace each job's one-line summary ("Data Science · onsite") with the full
 * posting text from the detail endpoint. A failed detail call keeps the job as
 * it was — the title and link are never lost over a description (Jim,
 * 2026-09-22). Sequential, with the same pause as the search pages.
 * @param {import('./_types.js').Job[]} jobs
 * @param {any} ctx
 * @param {string} entryName
 */
async function enrichDescriptions(jobs, ctx, entryName) {
  let failed = 0;
  for (const job of jobs) {
    const id = job.url.slice(JOB_BASE.length);
    if (!/^\d+$/.test(id)) continue;
    await sleep(INTER_PAGE_DELAY_MS, ctx);
    const url = assertMicrosoftUrl(`${ORIGIN}${DETAIL_PATH}${id}?domain=${encodeURIComponent(DOMAIN)}`);
    try {
      const body = /** @type {any} */ (await fetchJsonWithRetry(ctx, url, requestOptions(), RETRY_POLICY));
      const html = body && typeof body === 'object' ? body.job_description : undefined;
      const text = typeof html === 'string' ? htmlToText(html).trim() : '';
      if (text) job.description = text;
    } catch {
      failed++;
    }
  }
  if (failed > 0) console.error(`⚠️  microsoft: ${failed} of ${jobs.length} job description(s) for "${entryName}" could not be fetched — titles and links kept`);
}
