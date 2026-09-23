// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Jobicy provider — board-wide remote-jobs aggregator feed
// (https://jobicy.com/api/v2/remote-jobs?count=50). Returns { jobs: [...] }.
//
// Wire in via a `job_boards:` entry with `provider: jobicy`. The API also takes
// filters, and a board that fetches 50 worldwide postings is mostly noise for a
// UK search, so an optional `jobicy:` block narrows the feed (round 5, 2026-09-22):
//
//   - name: Jobicy (UK remote)
//     provider: jobicy
//     jobicy:
//       geo: uk                    # jobicy region slug (uk, europe, usa, …)
//       tag: machine learning      # optional keyword
//       count: 100                 # 1..100 (API cap); default 50
//
// Without the block the exact historical URL is fetched, so old configs are unchanged.

const FEED_BASE = 'https://jobicy.com/api/v2/remote-jobs';
const DEFAULT_COUNT = 50;
const MAX_COUNT = 100;
const FEED_URL = `${FEED_BASE}?count=${DEFAULT_COUNT}`;

/**
 * Feed URL for an entry: the historical URL unless a `jobicy:` block narrows it.
 * Exported for tests.
 * @param {{ jobicy?: unknown }} [entry]
 * @returns {string}
 */
export function buildFeedUrl(entry) {
  const cfg = entry?.jobicy && typeof entry.jobicy === 'object' ? /** @type {Record<string, unknown>} */ (entry.jobicy) : {};
  const u = new URL(FEED_BASE);
  const rawCount = Number(cfg.count);
  const count = Number.isInteger(rawCount) && rawCount > 0 ? Math.min(rawCount, MAX_COUNT) : DEFAULT_COUNT;
  u.searchParams.set('count', String(count));
  for (const key of ['geo', 'industry', 'tag']) {
    const v = cfg[key];
    if (typeof v === 'string' && v.trim()) u.searchParams.set(key, v.trim());
  }
  return u.href;
}

/** @type {Provider} */
export default {
  id: 'jobicy',

  detect(entry) {
    return entry?.provider === 'jobicy' ? { url: FEED_URL } : null;
  },

  /**
   * Fetches and normalizes postings from the Jobicy public feed.
   * @param {{ name?: string }} entry - The job_boards entry being processed.
   * @param {{ fetchJson: (url: string, opts?: { redirect?: 'error'|'follow'|'manual' }) => Promise<any> }} ctx - HTTP context.
   * @returns {Promise<Array<{title: string, url: string, company: string, location: string, postedAt?: number}>>}
   */
  async fetch(entry, ctx) {
    // redirect:'error' prevents SSRF via server-side redirects
    const json = await ctx.fetchJson(buildFeedUrl(entry), { redirect: 'error' });
    if (!json || !Array.isArray(json.jobs)) {
      throw new Error(`jobicy: unexpected API response — expected { jobs: [...] }, got keys: [${json ? Object.keys(json).join(', ') : 'null'}]`);
    }

    return parseJobicyResponse(json, entry.name || 'Jobicy');
  },
};

/**
 * Parse a Jobicy API response. Exported for unit tests.
 *
 * @param {any} json - Raw response payload.
 * @param {string} defaultCompany - Fallback company name.
 * @returns {Array<{title: string, url: string, company: string, location: string}>}
 */
export function parseJobicyResponse(json, defaultCompany = 'Jobicy') {
  if (!json || !Array.isArray(json.jobs)) return [];

  const toEpochMs = (value) => {
    if (!value) return undefined;
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  };

  return json.jobs
    .map(j => {
      if (!j || typeof j !== 'object') return null;

      const title = typeof j.jobTitle === 'string' ? j.jobTitle.trim() : '';
      if (!title) return null;

      const rawUrl = typeof j.url === 'string' ? j.url.trim() : '';
      let url = null;
      try {
        const parsed = new URL(rawUrl);
        if (parsed.protocol === 'https:' && (parsed.hostname === 'jobicy.com' || parsed.hostname === 'www.jobicy.com')) {
          url = parsed.href;
        }
      } catch {
        // Invalid or malformed URL
      }
      if (!url) return null;

      const company = typeof j.companyName === 'string' && j.companyName.trim() ? j.companyName.trim() : defaultCompany;
      const location = typeof j.jobGeo === 'string' ? j.jobGeo.trim() : '';
      const postedAt = toEpochMs(j.pubDate);

      return {
        title,
        url,
        company,
        location,
        postedAt,
      };
    })
    .filter(j => j !== null);
}