#!/usr/bin/env node
/**
 * backfill-descriptions.mjs — fill data/job-descriptions.jsonl for jobs that
 * are already in the ledger (round 3, Jim, 2026-09-22; round 6 same day).
 *
 * The scanner stores a description for every NEW job, and re-stores the ones
 * providers hand it for free on later scans. Jobs this script is for:
 *   - no description stored at all (Workday postings, boards that no longer
 *     list the job) → the ATS's public JSON API (Greenhouse, Lever, Ashby,
 *     Workday), as fetch-jd.mjs does;
 *   - a TEASER stored — Adzuna (≤ 500 chars) and Reed (≤ 450 chars) search
 *     payloads — → the whole posting via full-description.mjs (Reed's per-job
 *     API or page; Adzuna's details page or the employer's page).
 * Other hosts (Google Careers, Microsoft) have no such source and are reported
 * as uncovered.
 *
 * Usage:
 *   node backfill-descriptions.mjs                 # everything missing or teaser-only
 *   node backfill-descriptions.mjs --limit 20      # at most 20 requests
 *   node backfill-descriptions.mjs --source reed,adzuna   # only these kinds (reed, adzuna, greenhouse, lever, ashby, workday)
 *   node backfill-descriptions.mjs --dry-run       # list what would be fetched
 *   node backfill-descriptions.mjs --throttle 1500 # ms between requests to one source (default 1000)
 */

import { existsSync, readFileSync } from 'fs';

import { SCAN_HISTORY_PATH, normalizeUrlForDedup } from './scan.mjs';
import { parseScanHistory, loadCurrentTitleFilter } from './export-jobs.mjs';
import {
  DESCRIPTIONS_PATH, readDescriptions, appendDescriptions, normalizeDescription, shouldStoreDescription, MAX_DESCRIPTION_CHARS,
} from './job-descriptions.mjs';
import { fetchFullDescription, sourceKind } from './full-description.mjs';
import { resolveAtsApi, JD_TEXT_API_ATS, throttleProviderRequest } from './liveness-api.mjs';
import { flagValue, hasFlag, validateFlags, safeIntFlag } from './lib/cli-flags.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import path from 'path';
import dotenv from 'dotenv';
import { getCareerOpsRoot } from './path-resolver.mjs';

// Standalone entry point: REED_API_KEY etc. live in .env (run-all.mjs loads it the same way).
dotenv.config({ path: path.join(getCareerOpsRoot(), '.env'), quiet: true });

export const DEFAULT_THROTTLE_MS = 1000;
/** Ledger `portal` → source kind whose search payload is only a teaser (round 6). */
export const TEASER_PORTALS = { 'adzuna-api': 'adzuna', 'reed-api': 'reed' };
/** A stored text this short from a TEASER_PORTALS job is the teaser, not the posting. */
export const TEASER_MAX_CHARS = 600;

/** Which ATS the public API can answer for, or null. */
export function apiAtsFor(url) {
  const resolved = resolveAtsApi(url);
  return resolved && JD_TEXT_API_ATS.has(resolved.ats) ? resolved.ats : null;
}

/**
 * The `added` ledger rows passing the current title filter, one per
 * normalized URL, that need a fetch: nothing stored yet (API-covered ATS, or an
 * Adzuna/Reed job), or only a teaser stored (Adzuna/Reed, ≤ TEASER_MAX_CHARS).
 * Split into `todo` (newest first, optionally capped; each row carries `ats`
 * = source kind and `current` = the stored teaser or '') and `uncovered`.
 * `sources` restricts `todo` to those kinds.
 * @param {string} historyText
 * @param {Map<string,string>} store  normalized URL → text
 * @param {{titleFilter?: Function|null, limit?: number|null, sources?: string[]|null}} [opts]
 */
export function selectMissing(historyText, store, { titleFilter = null, limit = null, sources = null } = {}) {
  const byUrl = new Map();
  for (const r of parseScanHistory(historyText)) {
    if (r.status !== 'added') continue;
    if (typeof titleFilter === 'function' && !titleFilter(r.title, r.company, r.company)) continue;
    const key = normalizeUrlForDedup(r.url);
    const stored = store.get(key);
    const teaserKind = TEASER_PORTALS[r.portal];
    if (stored != null && !(teaserKind && stored.length <= TEASER_MAX_CHARS)) continue; // full text already there
    const prev = byUrl.get(key);
    if (!prev || r.first_seen > prev.first_seen) byUrl.set(key, { ...r, current: stored ?? '' });
  }
  const rows = [...byUrl.values()].sort((a, b) => b.first_seen.localeCompare(a.first_seen) || a.company.localeCompare(b.company));
  const todo = [];
  const uncovered = [];
  for (const r of rows) {
    const ats = apiAtsFor(r.url) || TEASER_PORTALS[r.portal] || (sourceKind(r.url) === 'google' ? 'google' : null);
    if (!ats) { uncovered.push(r); continue; }
    if (Array.isArray(sources) && sources.length > 0 && !sources.includes(ats)) continue;
    todo.push({ ...r, ats });
  }
  return { todo: Number.isFinite(limit) && limit > 0 ? todo.slice(0, limit) : todo, uncovered };
}

/**
 * One backfill run. Appends each success to `file` as it arrives (a killed run
 * keeps what it fetched). Misses are reported, not stored, so a later run
 * retries them. A teaser row counts as filled only when the new text is
 * clearly longer than the teaser (shouldStoreDescription's 10% rule).
 * @param {{historyText: string, file?: string, fetchJd?: Function, titleFilter?: Function|null, sources?: string[]|null,
 *          limit?: number|null, dryRun?: boolean, throttleMs?: number, log?: Function}} opts
 */
export async function runBackfill({
  historyText, file = DESCRIPTIONS_PATH, fetchJd = fetchFullDescription, titleFilter = null, sources = null,
  limit = null, dryRun = false, throttleMs = DEFAULT_THROTTLE_MS, log = () => {},
  browser = false, closeBrowser = lazyCloseBrowser,
}) {
  const store = readDescriptions(file, normalizeUrlForDedup);
  const { todo, uncovered } = selectMissing(historyText, store, { titleFilter, limit, sources });
  const result = { todo: todo.length, filled: 0, missed: [], uncovered, byAts: {} };
  if (dryRun) {
    for (const r of todo) log(`  would fetch [${r.ats}] ${r.company} | ${r.title} | ${r.url}${r.current ? ` (teaser ${r.current.length} chars)` : ''}`);
    return result;
  }
  try {
    for (const r of todo) {
      await throttleProviderRequest(r.ats, throttleMs);
      let text = '';
      let via = 'api';
      try {
        const got = await fetchJd(r.url, MAX_DESCRIPTION_CHARS, 15_000, { current: r.current, browser: browser === true });
        text = normalizeDescription(got?.text);
        if (typeof got?.via === 'string' && got.via) via = got.via;
      } catch { text = ''; }
      const stat = result.byAts[r.ats] ||= { filled: 0, missed: 0 };
      if (shouldStoreDescription(r.current ? r.current.length : undefined, text)) {
        await appendDescriptions(file, [{ url: r.url, description: text, descriptionSource: via }]);
        result.filled++;
        stat.filled++;
        log(`  + [${r.ats}] ${r.company} | ${r.title} (${text.length} chars via ${via})`);
      } else {
        result.missed.push(r);
        stat.missed++;
        log(`  - [${r.ats}] ${r.company} | ${r.title} — ${r.current ? 'nothing longer than the teaser found' : 'no description from the source'}`);
      }
    }
  } finally {
    try { await closeBrowser(); } catch { /* nothing launched */ }
  }
  return result;
}

/** Default `closeBrowser`: loads browser-description.mjs (never Playwright itself) only when called. */
async function lazyCloseBrowser() {
  const { closeBrowser } = await import('./browser-description.mjs');
  return closeBrowser();
}

const KNOWN_FLAGS = ['--limit', '--dry-run', '--throttle', '--source', '--browser', '--help', '-h'];
const KNOWN_SOURCES = ['reed', 'adzuna', 'google', ...JD_TEXT_API_ATS];
const USAGE = `Usage:
  node backfill-descriptions.mjs [--limit <n>] [--source <kinds>] [--browser] [--dry-run] [--throttle <ms>]
  node backfill-descriptions.mjs --help

  --source <kinds>   comma list of ${KNOWN_SOURCES.join(', ')} (default: all)
  --browser          also open Adzuna land links in headless Chromium when the details page only
                     has the snippet (~10–25 s per job; try --browser --source adzuna --limit 10 first)`;

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) { console.log(USAGE); return; }
  validateFlags(args, KNOWN_FLAGS, USAGE, { valueFlags: ['--limit', '--throttle', '--source'] });
  let sources = null;
  if (hasFlag(args, '--source')) {
    sources = String(flagValue(args, '--source') || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
    const bad = sources.filter(x => !KNOWN_SOURCES.includes(x));
    if (sources.length === 0 || bad.length > 0) { console.error(`Error: --source expects a comma list of ${KNOWN_SOURCES.join(', ')}`); process.exit(1); }
  }
  for (const f of ['--limit', '--throttle']) {
    if (hasFlag(args, f) && safeIntFlag(flagValue(args, f), null) == null) { console.error(`Error: ${f} expects a whole number`); process.exit(1); }
  }
  const limit = safeIntFlag(flagValue(args, '--limit'), null);
  const throttleMs = safeIntFlag(flagValue(args, '--throttle'), DEFAULT_THROTTLE_MS);
  const dryRun = args.includes('--dry-run');
  const browser = args.includes('--browser');

  if (!existsSync(SCAN_HISTORY_PATH)) {
    console.error(`No scan history at ${SCAN_HISTORY_PATH} — run node scan.mjs first.`);
    process.exit(1);
  }
  const historyText = readFileSync(SCAN_HISTORY_PATH, 'utf-8');
  console.log(dryRun ? 'Backfill (dry run):' : 'Backfilling job descriptions (ATS APIs, Reed, Adzuna):');
  const r = await runBackfill({ historyText, titleFilter: loadCurrentTitleFilter(), sources, limit, dryRun, throttleMs, browser, log: console.log });
  if (dryRun) { console.log(`Would fetch ${r.todo} job(s); ${r.uncovered.length} have no source (Microsoft, ...)`); return; }
  console.log(`\nFilled ${r.filled} of ${r.todo}; ${r.missed.length} miss(es); ${r.uncovered.length} uncovered (no source)`);
  for (const [ats, s] of Object.entries(r.byAts)) console.log(`  ${ats.padEnd(11)} filled ${s.filled}, missed ${s.missed}`);
  if (r.uncovered.length > 0) {
    const byPortal = {};
    for (const u of r.uncovered) byPortal[u.portal] = (byPortal[u.portal] || 0) + 1;
    console.log(`  uncovered: ${Object.entries(byPortal).map(([k, n]) => `${k} ${n}`).join(', ')} — these fill in on the next scan if the provider lists them`);
  }
}

if (isMainModule(import.meta.url)) {
  main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
}
