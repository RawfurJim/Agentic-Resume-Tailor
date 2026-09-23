#!/usr/bin/env node
/**
 * export-new-jobs.mjs — one csv per run holding ONLY the jobs never handed out before.
 *
 * `export-jobs.mjs` rebuilds the full spreadsheet every time. This script is the
 * feed for downstream processing: after a scan it writes
 *   data/new-data/new-jobs-<YYYY-MM-DD>-<HHMMSS>.csv     (same columns as uk-ai-jobs.csv)
 * containing the ledger rows whose URL is not yet listed in
 *   data/new-data/exported-urls.txt                        (one URL per line, append-only)
 * AND whose posting date is at most 5 days old (--max-age-days; undated postings
 * count from the day the scanner first saw them), keeping ONE row per
 * company + title (the same role advertised in several UK cities is one job to
 * Jim), and then appends every URL it judged — written, too old or a duplicate —
 * to that list. A run that finds nothing new writes no csv. Delete a URL from
 * the list to have its job re-issued in the next file; delete the list to
 * re-issue everything.
 *
 * Usage:
 *   node export-new-jobs.mjs              # write this run's csv (if anything is new)
 *   node export-new-jobs.mjs --dry-run    # show what would be written, touch nothing
 *   node export-new-jobs.mjs --out <dir>  # different folder (default data/new-data)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'fs';
import path from 'path';

import { normalizeUrlForDedup, parseSinceDays, daysBetweenIsoDates } from './scan.mjs';
import { buildRows, toCsv, loadExportInputs } from './export-jobs.mjs';
import { readIndeedRows } from './indeed-rows.mjs';
import { flagValue, hasFlag, validateFlags } from './lib/cli-flags.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { localToday } from './lib/local-today.mjs';

export const EXPORTED_URLS_FILE = 'exported-urls.txt';
/** Jim (round 3: 7 days; round 6, 2026-09-22: "only jobs 5 days old, no more than that"). */
export const DEFAULT_MAX_AGE_DAYS = 5;
export const DEFAULT_NEW_DIR = path.join(getCareerOpsRoot(), 'data', 'new-data');

/** `new-jobs-2026-09-21-190405.csv` — sorts chronologically in any file browser. */
export function newFileName(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `new-jobs-${stamp}.csv`;
}

/** URLs already handed out, normalized the same way the ledger dedups. */
export function readExportedUrls(newDir) {
  const file = path.join(newDir, EXPORTED_URLS_FILE);
  if (!existsSync(file)) return new Set();
  return new Set(readFileSync(file, 'utf-8').split(/\r?\n/).map(s => s.trim()).filter(Boolean).map(normalizeUrlForDedup));
}

/**
 * Is this posting at most `maxAgeDays` old? Age counts from the employer's
 * posting date; only a job WITHOUT a parsable posting date falls back to the
 * day this scraper first saw it. (Round 5 briefly used the younger of the two
 * clocks so month-old Microsoft/Amazon postings would show up the week a board
 * was added — with Adzuna/Reed that let 60-day-old ads flood the feed, and Jim
 * asked on 2026-09-22 for "no more than 7 days old from the current day".)
 * A job with neither date parsable is never hidden. `maxAgeDays` 0 / null
 * disables the window. Boundary day is IN (age 5 passes with the default).
 * @param {{posted_at?: string, first_seen?: string}} row
 * @param {number|null} maxAgeDays
 * @param {string} [today] YYYY-MM-DD
 */
export function isRecent(row, maxAgeDays, today = localToday()) {
  if (!Number.isFinite(maxAgeDays) || maxAgeDays <= 0) return true;
  const posted = daysBetweenIsoDates(row.posted_at || '', today);
  const age = typeof posted === 'number' ? posted : daysBetweenIsoDates(row.first_seen || '', today);
  if (typeof age !== 'number' || !Number.isFinite(age)) return true; // neither date parsable — never hide a job we cannot judge
  return age <= maxAgeDays;
}

/**
 * The key under which two rows count as "the same job": company + title,
 * lower-cased, punctuation and extra spaces ignored. Location is deliberately
 * NOT part of it — Jim (2026-09-22): "same company same job, I only need one,
 * any location is okay as long as it's in the UK".
 * @param {{company?: string, title?: string}} row
 */
export function jobKey(row) {
  const norm = (s) => String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return `${norm(row.company)}|${norm(row.title)}`;
}

/**
 * Collapse rows sharing a `jobKey` to one. The survivor is the copy with a
 * description if any has one, then the most recently posted, then the first in
 * input order (rows arrive newest-first from buildRows). Output keeps the input
 * order of the survivors.
 * @param {Array<Record<string,string>>} rows
 * @returns {{kept: Array<Record<string,string>>, duplicates: Array<Record<string,string>>}}
 */
export function dedupeByJobKey(rows) {
  const best = new Map();
  for (const r of rows) {
    const key = jobKey(r);
    const prev = best.get(key);
    if (!prev || beats(r, prev)) best.set(key, r);
  }
  const survivors = new Set(best.values());
  return { kept: rows.filter((r) => survivors.has(r)), duplicates: rows.filter((r) => !survivors.has(r)) };
}

function beats(a, b) {
  const hasDesc = (r) => String(r.description ?? '').trim().length > 0;
  if (hasDesc(a) !== hasDesc(b)) return hasDesc(a);
  return (a.posted_at || '') > (b.posted_at || '');
}

/**
 * Split the `added` ledger rows not yet exported into the ones for the feed
 * (`rows`, newest first, one per company + title), the ones already too old
 * (`old`) and the extra copies of a job that made it (`duplicates`).
 * @param {string} historyText  raw scan-history.tsv
 * @param {Set<string>} exportedUrls  raw or normalized URLs already handed out
 * @param {string} [pipelineText]
 * `extraRows` (the hand-picked Indeed jobs, see export-jobs.mjs buildRows)
 * join the ledger rows before the "never handed out" check.
 * @param {{titleFilter?: Function|null, maxAgeDays?: number|null, today?: string, descriptions?: Map<string,string>,
 *          extraRows?: Array<Record<string,string>>}} [opts]
 */
export function splitNewRows(historyText, exportedUrls, pipelineText = '', { titleFilter = null, maxAgeDays = DEFAULT_MAX_AGE_DAYS, today = localToday(), descriptions = new Map(), extraRows = [], blacklist = null } = {}) {
  const done = new Set([...exportedUrls].map(normalizeUrlForDedup));
  const fresh = buildRows({ historyText, pipelineText, titleFilter, today, descriptions, extraRows, blacklist }).filter(r => !done.has(normalizeUrlForDedup(r.url)));
  const recent = [];
  const old = [];
  for (const r of fresh) (isRecent(r, maxAgeDays, today) ? recent : old).push(r);
  const { kept, duplicates } = dedupeByJobKey(recent);
  return { rows: kept, old, duplicates };
}

/** The rows `splitNewRows` would put in the csv. */
export function selectNewRows(historyText, exportedUrls, pipelineText = '', opts = {}) {
  return splitNewRows(historyText, exportedUrls, pipelineText, opts).rows;
}

/**
 * Do one run: pick the new rows, write the csv, remember the URLs. Rows that
 * are new to us but already older than the window are NOT written, yet their
 * URLs are remembered too — they will never get younger, so re-judging them
 * every run would be waste. The same goes for the extra copies of a job whose
 * company + title did make the csv. (Delete them from exported-urls.txt to re-issue.)
 * @param {{historyText: string, pipelineText?: string, newDir: string, now?: Date, dryRun?: boolean,
 *          titleFilter?: Function|null, maxAgeDays?: number|null, descriptions?: Map<string,string>,
 *          extraRows?: Array<Record<string,string>>}} opts
 * @returns {{rows: Array<Record<string,string>>, skippedOld: Array<Record<string,string>>,
 *            skippedDuplicates: Array<Record<string,string>>, csvPath: string|null}}
 */
export function runNewExport({ historyText, pipelineText = '', newDir, now = new Date(), dryRun = false, titleFilter = null, maxAgeDays = DEFAULT_MAX_AGE_DAYS, descriptions = new Map(), extraRows = [], blacklist = null }) {
  const { rows, old, duplicates } = splitNewRows(historyText, readExportedUrls(newDir), pipelineText, { titleFilter, maxAgeDays, today: localToday(now), descriptions, extraRows, blacklist });
  if (dryRun || (rows.length === 0 && old.length === 0 && duplicates.length === 0)) return { rows, skippedOld: old, skippedDuplicates: duplicates, csvPath: null };
  mkdirSync(newDir, { recursive: true });
  let csvPath = null;
  if (rows.length > 0) {
    csvPath = path.join(newDir, newFileName(now));
    writeFileSync(csvPath, toCsv(rows), 'utf-8');
  }
  appendFileSync(path.join(newDir, EXPORTED_URLS_FILE), [...rows, ...old, ...duplicates].map(r => r.url).join('\n') + '\n', 'utf-8');
  return { rows, skippedOld: old, skippedDuplicates: duplicates, csvPath };
}

const KNOWN_FLAGS = ['--dry-run', '--out', '--max-age-days', '--help', '-h'];
const USAGE = `Usage:
  node export-new-jobs.mjs [--dry-run] [--out <dir>] [--max-age-days <n>]
  node export-new-jobs.mjs --help

  --max-age-days <n>   only postings at most n days old (default ${DEFAULT_MAX_AGE_DAYS}; 0 = no limit)`;

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) { console.log(USAGE); return; }
  validateFlags(args, KNOWN_FLAGS, USAGE, { valueFlags: ['--out', '--max-age-days'] });
  if (hasFlag(args, '--out') && !flagValue(args, '--out')) { console.error('Error: --out requires a directory'); process.exit(1); }
  const newDir = flagValue(args, '--out') || DEFAULT_NEW_DIR;
  const dryRun = args.includes('--dry-run');
  const maxAge = parseSinceDays(args, '--max-age-days', { allowZero: true });
  if (maxAge.error) { console.error(`Error: ${maxAge.error}`); process.exit(1); }
  const maxAgeDays = maxAge.days ?? DEFAULT_MAX_AGE_DAYS;

  let inputs;
  try { inputs = loadExportInputs(); } catch (err) { console.error(err.message); process.exit(1); }

  const result = runNewExport({ ...inputs, newDir, dryRun, maxAgeDays, extraRows: readIndeedRows() });
  reportNewExport(result, { dryRun, maxAgeDays });
}

/**
 * The console summary of a new-jobs export — shared with run-all.mjs.
 * @param {{rows: Array<Record<string,string>>, skippedOld: Array<Record<string,string>>,
 *          skippedDuplicates?: Array<Record<string,string>>, csvPath: string|null}} result
 * @param {{dryRun?: boolean, maxAgeDays?: number|null, log?: (msg: string) => void}} [opts]
 */
export function reportNewExport({ rows, skippedOld, skippedDuplicates = [], csvPath }, { dryRun = false, maxAgeDays = DEFAULT_MAX_AGE_DAYS, log = console.log } = {}) {
  const notes = [];
  if (skippedOld.length > 0) notes.push(`${skippedOld.length} skipped as older than ${maxAgeDays} days`);
  if (skippedDuplicates.length > 0) notes.push(`${skippedDuplicates.length} skipped as the same company + title in another location`);
  const oldNote = notes.length > 0 ? ` (${notes.join('; ')})` : '';
  if (rows.length === 0) { log(`New jobs: 0 — no csv written${oldNote}`); return; }
  const companies = new Set(rows.map(r => r.company)).size;
  const indeed = rows.filter(r => r.source === 'indeed').length;
  const indeedNote = indeed > 0 ? `, ${indeed} from Indeed` : '';
  if (dryRun) {
    log(`New jobs: ${rows.length} from ${companies} compan${companies === 1 ? 'y' : 'ies'}${indeedNote}${oldNote} (dry run — nothing written)`);
    for (const r of rows) log(`  + ${r.company} | ${r.title} | ${r.location || 'N/A'} | posted ${r.posted_at || '?'}`);
    return;
  }
  log(`New jobs: ${rows.length} from ${companies} compan${companies === 1 ? 'y' : 'ies'}${indeedNote}${oldNote}`);
  log(`  CSV:  ${csvPath}`);
}

if (isMainModule(import.meta.url)) {
  try { main(); } catch (err) { console.error('Fatal:', err.message); process.exit(1); }
}
