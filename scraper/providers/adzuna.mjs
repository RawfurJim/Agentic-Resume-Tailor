// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Adzuna provider — the UK's broadest job aggregator (it indexes Reed, TotalJobs,
// CV-Library, LinkedIn and most company boards). Official JSON API with a FREE
// app id + key: https://developer.adzuna.com. Round 5 (Jim, 2026-09-22).
//
// The board is country-wide, so a `queries` list is REQUIRED — each query is
// one search; results are deduped across queries by URL. Has no detect() by
// URL: reach it with an explicit `provider: adzuna` in a `job_boards:` entry.
//
//   - name: Adzuna (UK)
//     provider: adzuna
//     aggregator: true
//     adzuna:
//       country: gb                       # ISO-ish country slug in the API path (default gb)
//       queries: ["AI Engineer", "Data Scientist"]
//       where: London                     # optional free-text location
//       max_days_old: 60                  # optional server-side freshness filter
//       max_pages: 2                      # 50 results per page per query (default 2, cap 10)
//
// Keys come from .env: ADZUNA_APP_ID and ADZUNA_APP_KEY. Without them fetch()
// throws one clear message; scan.mjs lists it under errors and carries on.

import { htmlToText } from './_html-to-text.mjs';

export const ENV_APP_ID = 'ADZUNA_APP_ID';
export const ENV_APP_KEY = 'ADZUNA_APP_KEY';
const API_HOST = 'api.adzuna.com';
const PAGE_SIZE = 50; // the API's per-page maximum
const DEFAULT_MAX_PAGES = 2;
const MAX_PAGES_CAP = 10;
const DEFAULT_COUNTRY = 'gb';

/**
 * @param {{country: string, what: string, page: number, appId: string, appKey: string, where?: string, maxDaysOld?: number}} p
 * @returns {string}
 */
export function buildSearchUrl(p) {
  if (!/^[a-z]{2}$/.test(p.country)) throw new Error(`adzuna: country must be a two-letter code, got "${p.country}"`);
  const u = new URL(`https://${API_HOST}/v1/api/jobs/${p.country}/search/${Math.max(1, Math.trunc(p.page) || 1)}`);
  u.searchParams.set('app_id', p.appId);
  u.searchParams.set('app_key', p.appKey);
  u.searchParams.set('results_per_page', String(PAGE_SIZE));
  u.searchParams.set('what', p.what);
  if (p.where) u.searchParams.set('where', p.where);
  if (Number.isFinite(p.maxDaysOld) && /** @type {number} */ (p.maxDaysOld) > 0) u.searchParams.set('max_days_old', String(Math.trunc(/** @type {number} */ (p.maxDaysOld))));
  u.searchParams.set('content-type', 'application/json');
  return u.href;
}

/**
 * One API result → Job, or null when it has no title or its link is not an
 * https adzuna.* URL (the redirect_url is what the export shows and dedups on).
 * @param {any} r
 * @param {string} fallbackCompany
 */
export function normalizeAdzunaJob(r, fallbackCompany) {
  if (!r || typeof r !== 'object') return null;
  const title = typeof r.title === 'string' ? htmlToText(r.title).trim() : '';
  if (!title) return null;
  let url = '';
  try {
    const parsed = new URL(String(r.redirect_url || ''));
    if (parsed.protocol === 'https:' && /(^|\.)adzuna\.[a-z.]+$/.test(parsed.hostname)) url = parsed.href;
  } catch { /* dropped below */ }
  if (!url) return null;
  const company = typeof r.company?.display_name === 'string' && r.company.display_name.trim() ? r.company.display_name.trim() : fallbackCompany;
  const location = typeof r.location?.display_name === 'string' ? r.location.display_name.trim() : '';
  const posted = typeof r.created === 'string' ? Date.parse(r.created) : NaN;
  const description = typeof r.description === 'string' ? htmlToText(r.description).trim() : '';
  /** @type {import('./_types.js').Job} */
  const job = { title, url, company, location };
  if (!Number.isNaN(posted)) job.postedAt = posted;
  // The search API only ever sends a ~500-char teaser; full-description.mjs
  // fetches the whole posting for flagged jobs (round 6, 2026-09-22).
  if (description) { job.description = description; job.descriptionTruncated = true; }
  return job;
}

/** @param {any} entry */
function readConfig(entry) {
  const cfg = entry?.adzuna && typeof entry.adzuna === 'object' ? entry.adzuna : {};
  const queries = Array.isArray(cfg.queries) ? cfg.queries.filter((q) => typeof q === 'string' && q.trim()).map((q) => q.trim()) : [];
  if (queries.length === 0) throw new Error(`adzuna: "${entry?.name ?? 'Adzuna'}" needs adzuna.queries — the board is country-wide, a search is required`);
  const rawPages = Number(cfg.max_pages);
  const maxPages = Number.isInteger(rawPages) && rawPages > 0 ? Math.min(rawPages, MAX_PAGES_CAP) : DEFAULT_MAX_PAGES;
  return {
    queries,
    maxPages,
    country: typeof cfg.country === 'string' && cfg.country.trim() ? cfg.country.trim().toLowerCase() : DEFAULT_COUNTRY,
    where: typeof cfg.where === 'string' ? cfg.where.trim() : '',
    maxDaysOld: Number(cfg.max_days_old),
  };
}

function readKeys() {
  const appId = (process.env[ENV_APP_ID] || '').trim();
  const appKey = (process.env[ENV_APP_KEY] || '').trim();
  if (!appId || !appKey) {
    throw new Error(`adzuna: set ${ENV_APP_ID} and ${ENV_APP_KEY} in .env (free key: https://developer.adzuna.com) — skipped`);
  }
  return { appId, appKey };
}

/** @type {Provider} */
export default {
  id: 'adzuna',

  detect(entry) {
    return entry?.provider === 'adzuna' ? { url: `https://${API_HOST}/v1/api/jobs/${DEFAULT_COUNTRY}/search/1` } : null;
  },

  async fetch(entry, ctx) {
    const cfg = readConfig(entry);
    const { appId, appKey } = readKeys();
    const fallbackCompany = entry?.name || 'Adzuna';
    const seen = new Set();
    /** @type {import('./_types.js').Job[]} */
    const out = [];
    for (const what of cfg.queries) {
      for (let page = 1; page <= cfg.maxPages; page++) {
        const url = buildSearchUrl({ country: cfg.country, what, page, appId, appKey, where: cfg.where, maxDaysOld: cfg.maxDaysOld });
        const json = /** @type {any} */ (await ctx.fetchJson(url, { redirect: 'error' }));
        const results = Array.isArray(json?.results) ? json.results : null;
        if (!results) throw new Error(`adzuna: unexpected response for "${what}" page ${page} — expected { results: [...] }`);
        for (const r of results) {
          const job = normalizeAdzunaJob(r, fallbackCompany);
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
