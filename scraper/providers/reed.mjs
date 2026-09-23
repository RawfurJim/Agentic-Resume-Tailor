// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Reed.co.uk provider — the UK's largest job site. Official Jobseeker API
// (https://www.reed.co.uk/developers/jobseeker) with a FREE key, sent as HTTP
// Basic auth: the key is the username, the password is empty. Round 5 (Jim,
// 2026-09-22).
//
// The site is UK-wide, so a `queries` list is REQUIRED — one search per query,
// deduped across queries by URL. No detect() by URL: reach it with an explicit
// `provider: reed` in a `job_boards:` entry.
//
//   - name: Reed.co.uk
//     provider: reed
//     aggregator: true
//     reed:
//       queries: ["AI Engineer", "Data Scientist"]
//       locationName: London              # optional
//       max_pages: 2                      # 100 results per page per query (default 2, cap 10)
//
// Only permanent, full-time rows are returned (Jim's brief); the API flags
// part-time / contract / temp on every row, so the filter is exact.

import { htmlToText } from './_html-to-text.mjs';

export const ENV_KEY = 'REED_API_KEY';
export const PAGE_SIZE = 100; // API cap on resultsToTake
const API_HOST = 'www.reed.co.uk';
const API_PATH = '/api/1.0/search';
const DEFAULT_MAX_PAGES = 2;
const MAX_PAGES_CAP = 10;

/**
 * @param {{keywords: string, skip: number, locationName?: string}} p
 * @returns {string}
 */
export function buildSearchUrl(p) {
  const u = new URL(`https://${API_HOST}${API_PATH}`);
  u.searchParams.set('keywords', p.keywords);
  u.searchParams.set('resultsToTake', String(PAGE_SIZE));
  u.searchParams.set('resultsToSkip', String(Math.max(0, Math.trunc(p.skip) || 0)));
  if (p.locationName) u.searchParams.set('locationName', p.locationName);
  return u.href;
}

/** Reed dates read "dd/MM/yyyy". */
function parseReedDate(value) {
  const m = typeof value === 'string' ? value.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/) : null;
  if (!m) return undefined;
  const ms = Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
  return Number.isNaN(ms) ? undefined : ms;
}

/**
 * One API row → Job. Null when: no title, off-host link, or not a permanent
 * full-time position.
 * @param {any} r
 * @param {string} fallbackCompany
 */
export function normalizeReedJob(r, fallbackCompany) {
  if (!r || typeof r !== 'object') return null;
  const title = typeof r.jobTitle === 'string' ? htmlToText(r.jobTitle).trim() : '';
  if (!title) return null;
  if (r.fullTime === false) return null;
  const contract = typeof r.contractType === 'string' ? r.contractType.trim().toLowerCase() : '';
  if (contract && contract !== 'permanent') return null;
  let url = '';
  try {
    const parsed = new URL(String(r.jobUrl || ''));
    if (parsed.protocol === 'https:' && (parsed.hostname === API_HOST || parsed.hostname === 'reed.co.uk')) url = parsed.href;
  } catch { /* dropped below */ }
  if (!url) return null;
  const company = typeof r.employerName === 'string' && r.employerName.trim() ? r.employerName.trim() : fallbackCompany;
  const location = typeof r.locationName === 'string' ? r.locationName.trim() : '';
  const description = typeof r.jobDescription === 'string' ? htmlToText(r.jobDescription).trim() : '';
  /** @type {import('./_types.js').Job} */
  const job = { title, url, company, location };
  const postedAt = parseReedDate(r.date);
  if (postedAt !== undefined) job.postedAt = postedAt;
  // The search API only ever sends a ~450-char teaser; the per-job endpoint
  // (/api/1.0/jobs/<id>) has the whole posting — full-description.mjs fetches
  // it for flagged jobs (round 6, 2026-09-22).
  if (description) { job.description = description; job.descriptionTruncated = true; }
  return job;
}

/** @param {any} entry */
function readConfig(entry) {
  const cfg = entry?.reed && typeof entry.reed === 'object' ? entry.reed : {};
  const queries = Array.isArray(cfg.queries) ? cfg.queries.filter((q) => typeof q === 'string' && q.trim()).map((q) => q.trim()) : [];
  if (queries.length === 0) throw new Error(`reed: "${entry?.name ?? 'Reed'}" needs reed.queries — the site is UK-wide, a search is required`);
  const rawPages = Number(cfg.max_pages);
  const maxPages = Number.isInteger(rawPages) && rawPages > 0 ? Math.min(rawPages, MAX_PAGES_CAP) : DEFAULT_MAX_PAGES;
  return { queries, maxPages, locationName: typeof cfg.locationName === 'string' ? cfg.locationName.trim() : '' };
}

function readKey() {
  const key = (process.env[ENV_KEY] || '').trim();
  if (!key) throw new Error(`reed: set ${ENV_KEY} in .env (free key: https://www.reed.co.uk/developers/jobseeker) — skipped`);
  return key;
}

/** @type {Provider} */
export default {
  id: 'reed',

  detect(entry) {
    return entry?.provider === 'reed' ? { url: `https://${API_HOST}${API_PATH}` } : null;
  },

  async fetch(entry, ctx) {
    const cfg = readConfig(entry);
    const key = readKey();
    const headers = { authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}`, accept: 'application/json' };
    const fallbackCompany = entry?.name || 'Reed';
    const seen = new Set();
    /** @type {import('./_types.js').Job[]} */
    const out = [];
    for (const keywords of cfg.queries) {
      for (let page = 0; page < cfg.maxPages; page++) {
        const url = buildSearchUrl({ keywords, skip: page * PAGE_SIZE, locationName: cfg.locationName });
        const json = /** @type {any} */ (await ctx.fetchJson(url, { redirect: 'error', headers }));
        const results = Array.isArray(json?.results) ? json.results : null;
        if (!results) throw new Error(`reed: unexpected response for "${keywords}" page ${page + 1} — expected { results: [...] }`);
        for (const r of results) {
          const job = normalizeReedJob(r, fallbackCompany);
          if (!job || seen.has(job.url)) continue;
          seen.add(job.url);
          out.push(job);
        }
        if (results.length < PAGE_SIZE) break;
      }
    }
    return out;
  },
};
