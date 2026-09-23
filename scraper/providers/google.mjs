// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */
// Google Careers provider — reads the public, server-rendered search results
// page at https://www.google.com/about/careers/applications/jobs/results/.
//
// The whole board is one global search UI, so a tracked_companies entry narrows
// it by pointing `careers_url` at a real search (query + location params are
// preserved verbatim and `page=N` is appended):
//
//   - name: Google
//     provider: google                  # optional — the host is auto-detected
//     careers_url: https://www.google.com/about/careers/applications/jobs/results/?q=AI%20Engineer&hl=en&location=London%2C%20UK
//     max_pages: 5                      # 20 jobs/page (default 5, hard cap 20)
//
// Each page embeds an `AF_initDataCallback({key: 'ds:1', …})` blob with the
// structured rows (id, title, company "Google"/"DeepMind", locations, HTML
// description fields, created timestamp). That blob is the primary source; the
// rendered `<a href="jobs/results/<id>-<slug>">` anchors + `<h3 class="QJPWVe">`
// cards are only a fallback if the blob ever disappears.
//
// robots.txt NOTE: www.google.com/robots.txt disallows this results path. The
// operator of this install chose to scan it anyway, at low volume: 5 pages by
// default, a hard cap of 20, and a 1.5 s pause between pages. Do not raise
// those defaults without a reason, and do not add parallelism.

import { fetchTextWithRetry, sleep, BROWSER_LIKE_USER_AGENT } from './_http.mjs';
import { htmlToText } from './_html-to-text.mjs';
import { safeEncodeURIComponent } from './_safe-url.mjs';
import { intInRange } from './_config-utils.mjs';

export const TRUSTED_HOST = 'www.google.com';
export const RESULTS_PATH = '/about/careers/applications/jobs/results';
export const PAGE_SIZE = 20; // server-fixed
export const DEFAULT_MAX_PAGES = 5;
export const MAX_PAGES_CAP = 20;
export const INTER_PAGE_DELAY_MS = 1500;

const RESULTS_BASE = `https://${TRUSTED_HOST}${RESULTS_PATH}/`;
const CARD_RE = /<h3 class="QJPWVe">/g;
const ANCHOR_RE = /jobs\/results\/(\d+)-([a-z0-9-]+)/g;
const ANCHOR_WITH_TITLE_RE = /<a[^>]*href="jobs\/results\/(\d+)-([a-z0-9-]+)[^"]*"[^>]*>[\s\S]*?<h3 class="QJPWVe">([\s\S]*?)<\/h3>/g;
const INIT_MARKER = 'AF_initDataCallback(';

// Sanity window for the created timestamp: 2000-01-01 .. one year from now.
const MIN_TS_SECONDS = 946_684_800;

/**
 * SSRF guard: only the Google Careers results page, over HTTPS. Same role as
 * assertGreenhouseUrl in greenhouse.mjs — every fetch goes through it.
 * @param {unknown} url
 * @returns {string}
 */
export function assertGoogleCareersUrl(url) {
  if (typeof url !== 'string' || !url.trim()) throw new Error('google: careers_url is required');
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`google: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`google: URL must use HTTPS: ${url}`);
  if (parsed.hostname.toLowerCase() !== TRUSTED_HOST) {
    throw new Error(`google: untrusted hostname "${parsed.hostname}" — must be ${TRUSTED_HOST}`);
  }
  if (!parsed.pathname.startsWith(RESULTS_PATH)) {
    throw new Error(`google: URL must point at ${RESULTS_PATH}: ${url}`);
  }
  return url;
}

/**
 * @param {{provider?: unknown, careers_url?: unknown}} entry
 * @returns {{url: string}|null}
 */
export function detectGoogleEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (entry.provider !== undefined && entry.provider !== 'google') return null;
  if (entry.provider === 'google') {
    return typeof entry.careers_url === 'string' ? { url: entry.careers_url } : null;
  }
  try {
    return { url: assertGoogleCareersUrl(entry.careers_url) };
  } catch {
    return null;
  }
}

/**
 * The user's search URL with `page=N` applied. Page 1 is the URL exactly as
 * written (the site itself omits `page` on the first page).
 * @param {string} careersUrl
 * @param {number} page
 * @returns {string}
 */
export function buildPageUrl(careersUrl, page) {
  const u = new URL(assertGoogleCareersUrl(careersUrl));
  if (page <= 1) u.searchParams.delete('page');
  else u.searchParams.set('page', String(page));
  return assertGoogleCareersUrl(u.href);
}

/**
 * Pull the `data:` JSON out of one AF_initDataCallback({...}) block starting at
 * `start`. Returns the parsed value or null.
 * @param {string} html
 * @param {number} start
 */
function parseInitBlockAt(html, start) {
  const dataIdx = html.indexOf('data:', start);
  if (dataIdx === -1) return null;
  const end = html.indexOf(', sideChannel:', dataIdx);
  if (end === -1) return null;
  try {
    return JSON.parse(html.slice(dataIdx + 'data:'.length, end));
  } catch {
    return null;
  }
}

/** @param {unknown} data */
function looksLikeJobRows(data) {
  return Array.isArray(data)
    && Array.isArray(data[0])
    && data[0].length > 0
    && Array.isArray(data[0][0])
    && typeof data[0][0][0] === 'string'
    && /^\d+$/.test(data[0][0][0]);
}

/**
 * One posting's OWN page (…/jobs/results/<id>-<slug>): its `ds:0` init block
 * carries that job as a single row (same shape as a ds:1 results row), or an
 * ErrorDetails payload when the posting has been taken down. Used by
 * full-description.mjs to fetch the whole text of one Google job.
 * @param {unknown} html
 * @param {string} [entryName]
 * @returns {{title: string, url: string, company: string, location: string, description: string, postedAt?: number}|null}
 */
export function extractJobDetail(html, entryName = 'Google') {
  if (typeof html !== 'string' || !html) return null;
  const keyIdx = html.indexOf("key: 'ds:0'");
  if (keyIdx === -1) return null;
  const dataIdx = html.indexOf('data:', keyIdx);
  if (dataIdx === -1) return null;
  let end = html.indexOf(', sideChannel:', dataIdx);
  if (end === -1) end = html.indexOf('});', dataIdx);
  if (end === -1) return null;
  let data;
  try { data = JSON.parse(html.slice(dataIdx + 'data:'.length, end).replace(/,\s*errorHasStatus:\s*\w+\s*,?\s*$/, '').trim()); } catch { return null; }
  const row = Array.isArray(data) ? data[0] : null;
  if (!Array.isArray(row) || typeof row[0] !== 'string' || !/^\d+$/.test(row[0])) return null; // ErrorDetails / not a job row
  return rowToJob(row, new Map(), entryName);
}

/**
 * Locate the ds:1 blob (or, failing that, any init block shaped like job rows).
 * @param {string} html
 * @returns {{rows: any[], total: number|null, pageSize: number|null}|null}
 */
export function extractInitData(html) {
  if (typeof html !== 'string' || !html) return null;
  const keyIdx = html.indexOf("key: 'ds:1'");
  let data = keyIdx === -1 ? null : parseInitBlockAt(html, keyIdx);
  if (!Array.isArray(data) || !Array.isArray(data[0])) {
    // Fallback: scan every init block for one that carries job-shaped rows.
    data = null;
    let from = 0;
    for (;;) {
      const i = html.indexOf(INIT_MARKER, from);
      if (i === -1) break;
      const candidate = parseInitBlockAt(html, i);
      if (looksLikeJobRows(candidate)) { data = candidate; break; }
      from = i + INIT_MARKER.length;
    }
    if (!data) return null;
  }
  const rows = Array.isArray(data[0]) ? data[0] : [];
  const total = typeof data[2] === 'number' ? data[2] : null;
  const pageSize = typeof data[3] === 'number' ? data[3] : null;
  return { rows, total, pageSize };
}

/** @param {string} title */
function slugify(title) {
  return String(title).toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-');
}

/** @param {unknown} v */
function htmlField(v) {
  return Array.isArray(v) && typeof v[1] === 'string' ? v[1] : '';
}

/**
 * @param {unknown} ts protobuf-style [seconds, nanos]
 * @returns {number|undefined} epoch ms
 */
function timestampToMs(ts) {
  if (!Array.isArray(ts)) return undefined;
  const sec = ts[0];
  if (!Number.isInteger(sec)) return undefined;
  const maxSec = Date.now() / 1000 + 365 * 86_400;
  if (sec < MIN_TS_SECONDS || sec > maxSec) return undefined;
  return sec * 1000;
}

/**
 * One ds:1 row → Job. Returns null when the row cannot yield a safe URL.
 * @param {any[]} row
 * @param {Map<string,string>} slugById  slugs harvested from the page's anchors
 * @param {string} [entryName]
 */
export function rowToJob(row, slugById, entryName = 'Google') {
  if (!Array.isArray(row)) return null;
  const rawId = row[0];
  if (typeof rawId !== 'string' || !/^\d+$/.test(rawId)) return null;
  const id = safeEncodeURIComponent(rawId);
  if (id === null) return null;
  const title = htmlToText(typeof row[1] === 'string' ? row[1] : '');
  if (!title) return null;
  const slug = slugById.get(rawId) || slugify(title);
  const url = `${RESULTS_BASE}${id}${slug ? `-${slug}` : ''}`;
  const company = typeof row[7] === 'string' && row[7].trim() ? row[7].trim() : (entryName || 'Google');
  const locations = Array.isArray(row[9])
    ? row[9].map((l) => (Array.isArray(l) && typeof l[0] === 'string' ? l[0].trim() : '')).filter(Boolean)
    : [];
  // Qualifications first so the description cap (DESCRIPTION_CAP) keeps the
  // part the content/visa filters care about; the "about" blurb goes last.
  const description = htmlToText(
    [htmlField(row[4]), htmlField(row[19]), htmlField(row[3]), htmlField(row[10])].filter(Boolean).join(' '),
  );
  return {
    title,
    url,
    company,
    location: locations.join(' · '),
    description,
    postedAt: timestampToMs(row[12]),
  };
}

/**
 * Parse one results page into jobs.
 *  - blob present → rows → jobs (deduped by id); cards visible but nothing parsed → throw (layout changed)
 *  - blob missing, anchors present → minimal fallback jobs
 *  - nothing recognisable at all → throw (interstitial / redesign), never a silent empty board
 * @param {string} html
 * @param {string} [entryName]
 */
export function parseGoogleCareersPage(html, entryName = 'Google') {
  if (typeof html !== 'string' || !html) return [];
  const cardCount = (html.match(CARD_RE) || []).length;

  const slugById = new Map();
  for (const m of html.matchAll(ANCHOR_RE)) {
    if (!slugById.has(m[1])) slugById.set(m[1], m[2]);
  }

  const init = extractInitData(html);
  if (init) {
    const seen = new Set();
    const jobs = [];
    for (const row of init.rows) {
      const job = rowToJob(row, slugById, entryName);
      if (!job) continue;
      if (seen.has(job.url)) continue;
      seen.add(job.url);
      jobs.push(job);
    }
    if (jobs.length === 0 && cardCount > 0) {
      throw new Error(
        `google: page still contains ${cardCount} job cards but the ds:1 rows parsed to none — layout changed, provider needs updating`,
      );
    }
    return jobs;
  }

  // Fallback: anchors + card titles only (no locations, no description).
  const jobs = [];
  const seen = new Set();
  for (const m of html.matchAll(ANCHOR_WITH_TITLE_RE)) {
    const [, rawId, slug, rawTitle] = m;
    if (seen.has(rawId)) continue;
    const title = htmlToText(rawTitle);
    if (!title) continue;
    seen.add(rawId);
    jobs.push({ title, url: `${RESULTS_BASE}${rawId}-${slug}`, company: entryName || 'Google', location: '', description: '' });
  }
  if (jobs.length > 0) return jobs;

  if (cardCount === 0 && !html.includes(INIT_MARKER)) {
    throw new Error('google: response carried no job data at all (interstitial, block page or redesign) — not treating as an empty board');
  }
  return [];
}

/** @type {Provider} */
export default {
  id: 'google',

  detect(entry) {
    return detectGoogleEntry(entry);
  },

  async fetch(entry, ctx) {
    const careersUrl = assertGoogleCareersUrl(entry.careers_url);
    const entryName = typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : 'Google';
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

    /** @type {any[]} */
    const jobs = [];
    const seen = new Set();
    let total = null;
    let truncated = false;

    for (let page = 1; page <= maxPages; page++) {
      if (page > 1) await sleep(INTER_PAGE_DELAY_MS, ctx);
      const url = buildPageUrl(careersUrl, page);

      let html;
      try {
        html = await fetchTextWithRetry(ctx, url, {
          headers: {
            'user-agent': BROWSER_LIKE_USER_AGENT,
            accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
            'accept-language': 'en-GB,en;q=0.9',
          },
          redirect: 'error',
          timeoutMs: 20_000,
        });
      } catch (err) {
        // Under a health probe the caller wants the raw failure. In a scan, a
        // later page failing must not throw away the pages already fetched.
        if (isProbe || page === 1) throw err;
        console.error(`⚠️  google: page ${page} of "${entryName}" failed (${/** @type {Error} */ (err).message}) — keeping ${jobs.length} job(s) from earlier pages`);
        return jobs;
      }

      const parsed = parseGoogleCareersPage(html, entryName);
      const init = extractInitData(html);
      if (init?.total != null) total = init.total;

      if (parsed.length === 0) break;
      const before = seen.size;
      for (const job of parsed) {
        if (seen.has(job.url)) continue;
        seen.add(job.url);
        jobs.push(job);
      }
      if (seen.size === before) break; // every row already seen → past the end
      if (parsed.length < PAGE_SIZE) break; // short page → last page
      if (total != null && page * PAGE_SIZE >= total) break;
      if (page === maxPages) truncated = total == null || page * PAGE_SIZE < total;
    }

    if (truncated && !isProbe) {
      console.error(`⚠️  google: "${entryName}" stopped at max_pages=${entryCap} with more results available${total != null ? ` (${total} total)` : ''} — narrow the search URL or raise max_pages (cap ${MAX_PAGES_CAP})`);
    }
    return jobs;
  },
};
