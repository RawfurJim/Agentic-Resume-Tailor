#!/usr/bin/env node
/**
 * job-descriptions.mjs — keep each job's description text so the exports can
 * show it (round 3, Jim, 2026-09-22).
 *
 * The scanner already receives the description for free from most providers
 * (Ashby, Greenhouse, Lever, Workable, Google, Recruitee) but only kept its
 * fingerprint; Workday gives none in its list payload and Microsoft's is a
 * synthetic "department · hybrid". This module:
 *
 *   - stores descriptions in data/job-descriptions.jsonl — one JSON object per
 *     line {url, text, source, fetched_at}, append-only, last line per URL wins,
 *     unreadable lines skipped (same conventions as scan-history.tsv). JSONL
 *     rather than the TSV ledger because a description is multi-line text.
 *   - fetches the missing ones — and the FULL text behind the teasers Adzuna
 *     and Reed send (`descriptionTruncated`, round 6) — through
 *     full-description.mjs fetchFullDescription(): Reed's per-job API or page,
 *     Adzuna's details page or the employer's page, and the ATS public APIs
 *     (Greenhouse, Lever, Ashby, Workday) for everything else. Round 7: an
 *     Adzuna land link whose details page only has the snippet may go through
 *     headless Chromium (browser-description.mjs), at most DEFAULT_BROWSER_CAP
 *     times per run (~20 s each); the rest wait for `backfill-descriptions --browser`.
 *
 * Deliberately does NOT import scan.mjs (scan.mjs imports this file); callers
 * pass the URL normaliser in.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import path from 'path';

import { fetchFullDescription } from './full-description.mjs';
import { withPipelineLock } from './pipeline-lock.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { localToday } from './lib/local-today.mjs';

export const DESCRIPTIONS_PATH = process.env.CAREER_OPS_DESCRIPTIONS
  || path.join(getCareerOpsRoot(), 'data', 'job-descriptions.jsonl');

/** Excel caps a cell at 32 767 chars; fetch-jd.mjs also reads up to 20 000. */
export const MAX_DESCRIPTION_CHARS = 20_000;
/** Below this it is not a job description (empty, or Microsoft's "AI · hybrid"). Same floor as browser-extract MIN_JD_TEXT_CHARS. */
export const MIN_DESCRIPTION_CHARS = 200;
/** Browser fetches per enrichDescriptions() run — ~20 s each, so 40 bounds a scan to ~13 extra minutes. */
export const DEFAULT_BROWSER_CAP = 40;

const ADZUNA_LAND_RE = /^https:\/\/([^/]+\.)?adzuna\.[a-z.]+\/jobs\/land\/ad\//i;

/** Default `closeBrowser`: only loads browser-description.mjs (and never Playwright) when called. */
async function lazyCloseBrowser() {
  const { closeBrowser } = await import('./browser-description.mjs');
  return closeBrowser();
}

// fetchJdViaKnownApi() prefixes the body with a metadata block of these
// labelled lines followed by a blank line (browser-extract.mjs normalize*Job).
// The ledger already has location/date, so the block is stripped here.
const META_LINE_RE = /^(Location|Job type|Posted|Req ID|Work model|Applications closed|Not currently listed)\b[:\s(]/;

/**
 * Plain, compact description text: metadata header removed, whitespace tidied,
 * length capped. Never throws; non-strings become ''.
 * @param {unknown} text
 * @returns {string}
 */
export function normalizeDescription(text) {
  let s = typeof text === 'string' ? text.replace(/\r\n?/g, '\n') : '';
  s = s.trim();
  // Strip the API metadata header: only when EVERY line before the first blank
  // line is a labelled metadata line, so prose that merely starts with
  // "Location" is left alone.
  const blank = s.indexOf('\n\n');
  if (blank > 0) {
    const head = s.slice(0, blank).split('\n');
    if (head.every(l => META_LINE_RE.test(l))) s = s.slice(blank + 2);
  }
  s = s
    .split('\n')
    .map(l => l.replace(/[ \t ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return s.length > MAX_DESCRIPTION_CHARS ? s.slice(0, MAX_DESCRIPTION_CHARS) : s;
}

/** @param {unknown} text */
export function isRealDescription(text) {
  return typeof text === 'string' && text.trim().length >= MIN_DESCRIPTION_CHARS;
}

/**
 * Should this text be (re)stored for a URL whose stored text has
 * `storedLength` chars (undefined = nothing stored)? Yes when it is a real
 * description and either nothing is stored or the new text is clearly longer
 * — a provider that used to cap at 4000 chars now sends the full posting, and
 * the store must pick that up without re-writing every unchanged job.
 * @param {number|undefined} storedLength
 * @param {unknown} text  raw provider text (normalised here)
 */
export function shouldStoreDescription(storedLength, text) {
  const t = normalizeDescription(text);
  if (!isRealDescription(t)) return false;
  if (storedLength == null) return true;
  return t.length > storedLength * 1.1;
}

/**
 * key → stored text length, for the scanner's "is this worth storing" check.
 * @param {string} file
 * @param {(url: string) => string} normalizeKey
 */
export function readDescriptionLengths(file = DESCRIPTIONS_PATH, normalizeKey = (u) => u) {
  const out = new Map();
  for (const [k, text] of readDescriptions(file, normalizeKey)) out.set(k, text.length);
  return out;
}

/**
 * Read the store. `normalizeKey` maps a URL to the lookup key (callers pass
 * scan.mjs's normalizeUrlForDedup so the join matches the ledger's dedup).
 * @param {string} file
 * @param {(url: string) => string} [normalizeKey]
 * @returns {Map<string, string>} key → description text
 */
export function readDescriptions(file = DESCRIPTIONS_PATH, normalizeKey = (u) => u) {
  const out = new Map();
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, 'utf-8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!entry || typeof entry !== 'object' || typeof entry.url !== 'string' || typeof entry.text !== 'string') continue;
    out.set(normalizeKey(entry.url), entry.text);
  }
  return out;
}

/**
 * Append the offers that carry a real description. Takes the same advisory
 * lock the ledger writers use, on this file's own path. Returns how many
 * lines were written.
 * @param {string} file
 * @param {Array<{url: string, description?: string, descriptionSource?: string, source?: string}>} offers
 * @param {{today?: string}} [opts]
 */
export async function appendDescriptions(file, offers, { today = localToday() } = {}) {
  const lines = [];
  for (const o of offers || []) {
    if (!o || typeof o.url !== 'string' || !o.url) continue;
    const text = normalizeDescription(o.description);
    if (!isRealDescription(text)) continue;
    lines.push(JSON.stringify({
      url: o.url,
      text,
      source: o.descriptionSource || o.source || 'provider',
      fetched_at: today,
    }));
  }
  if (lines.length === 0) return 0;
  await withPipelineLock(file, () => {
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, lines.join('\n') + '\n', 'utf-8');
  });
  return lines.length;
}

/**
 * For offers without a real description — or with a teaser the source cut
 * short (`descriptionTruncated`, Adzuna/Reed) — fetch the full text. Sequential
 * with a small pause — the caller only has this run's NEW offers. A miss (null
 * / throw / not clearly longer than the teaser) leaves the offer as it was: the
 * title, link and teaser are never lost over a body (Jim, round 5/6).
 *
 * `fetchJd(url, textCap, timeoutMs, { current, detailsPage, browser })` — the default is
 * fetchFullDescription; the old fetchJdViaKnownApi shape (3 args) still works.
 * `browser` (default true) lets Adzuna land links fall back to headless Chromium
 * until `browserCap` browser fills have been made this run; `closeBrowser` is
 * called once at the end so the shared Chromium never outlives the run.
 * @param {Array<{url: string, description?: string, descriptionTruncated?: boolean, descriptionSource?: string}>} offers
 * @param {{fetchJd?: Function, textCap?: number, timeoutMs?: number, pauseMs?: number, detailsPage?: boolean,
 *          browser?: boolean, browserCap?: number, closeBrowser?: Function}} [opts]
 * @returns {Promise<{filled: number, missing: number, stillTruncated: number, byVia: Record<string, number>,
 *                    browserUsed: number, browserCapHit: number}>}
 *   missing = still no real description; stillTruncated = teaser kept because nothing better came back;
 *   browserUsed = fills that came through Chromium; browserCapHit = Adzuna land links left as teasers
 *   because the browser budget was already spent (→ `npm run backfill:descriptions -- --browser`)
 */
export async function enrichDescriptions(offers, {
  fetchJd = fetchFullDescription, textCap = MAX_DESCRIPTION_CHARS, timeoutMs = 15_000, pauseMs = 500, detailsPage = true,
  browser = true, browserCap = DEFAULT_BROWSER_CAP, closeBrowser = lazyCloseBrowser,
} = {}) {
  let filled = 0;
  let missing = 0;
  let stillTruncated = 0;
  let browserUsed = 0;
  let browserCapHit = 0;
  /** @type {Record<string, number>} */
  const byVia = {};
  try {
    for (const offer of offers || []) {
      if (!offer || typeof offer.url !== 'string') continue;
      const hasReal = isRealDescription(offer.description);
      const truncated = offer.descriptionTruncated === true;
      if (hasReal && !truncated) continue;
      const current = hasReal ? normalizeDescription(offer.description) : '';
      const browserAllowed = browser === true && browserUsed < browserCap;
      let result = null;
      try { result = await fetchJd(offer.url, textCap, timeoutMs, { current, detailsPage, browser: browserAllowed }); } catch { result = null; }
      const text = normalizeDescription(result?.text);
      if (shouldStoreDescription(current ? current.length : undefined, text)) {
        offer.description = text;
        offer.descriptionSource = typeof result?.via === 'string' && result.via ? result.via : 'api';
        delete offer.descriptionTruncated;
        byVia[offer.descriptionSource] = (byVia[offer.descriptionSource] || 0) + 1;
        filled++;
        if (offer.descriptionSource.startsWith('browser')) browserUsed++;
      } else if (truncated && hasReal) {
        stillTruncated++;
        if (browser === true && !browserAllowed && ADZUNA_LAND_RE.test(offer.url)) browserCapHit++;
      } else {
        missing++;
      }
      if (pauseMs > 0) await new Promise(r => setTimeout(r, pauseMs));
    }
  } finally {
    try { await closeBrowser(); } catch { /* nothing was launched, or it is already gone */ }
  }
  return { filled, missing, stillTruncated, byVia, browserUsed, browserCapHit };
}
