#!/usr/bin/env node
/**
 * export-jobs.mjs — Excel + CSV export of every job the scanner has surfaced.
 *
 * Reads data/scan-history.tsv (the dedup ledger scan.mjs appends to),
 * data/pipeline.md (the Pending list) and data/job-descriptions.jsonl (the
 * description store, job-descriptions.mjs), and writes
 *   data/exports/uk-ai-jobs.csv    Company, Title, Location, URL, Source, Posted, First seen, Description
 * Hand-picked Indeed jobs (indeed_scrapper/jobs.csv, via indeed-rows.mjs) are
 * appended with Source `indeed`; the title filter does not apply to them.
 *   data/exports/uk-ai-jobs.xlsx   same rows: sheet "Jobs" (filterable, hyperlinks) + sheet "Summary"
 *
 * Only rows with status `added` are exported — those are the postings that
 * passed every filter (title, location, age, dedup). Expired / skipped rows
 * stay in the TSV for dedup but never reach the spreadsheet. The CURRENT
 * portals.yml title filter is applied again on the way out, so a title the
 * scanner accepted under an older, looser config is hidden once the config is
 * tightened (round 3: no more plain "Software Engineer" at the AI labs).
 *
 * Usage:
 *   node export-jobs.mjs                    # all added jobs → data/exports/
 *   node export-jobs.mjs --since 7          # only jobs first seen in the last 7 days
 *   node export-jobs.mjs --pending-only     # only jobs still in pipeline.md's Pending list
 *   node export-jobs.mjs --out ./somewhere  # different output directory
 *   node export-jobs.mjs --help
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import ExcelJS from 'exceljs';

import * as yaml from 'js-yaml';

import { SCAN_HISTORY_PATH, PIPELINE_PATH, PORTALS_PATH, parseSinceDays, normalizeUrlForDedup, resolveTitleFilter, loadBlacklist } from './scan.mjs';
import { normalizeCompany } from './tracker-utils.mjs';
import { DESCRIPTIONS_PATH, readDescriptions } from './job-descriptions.mjs';
import { readIndeedRows } from './indeed-rows.mjs';
import { flagValue, hasFlag, validateFlags } from './lib/cli-flags.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { localToday } from './lib/local-today.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';

// Column order of data/scan-history.tsv, as written by scan.mjs formatScanHistoryRow.
// Positional and append-only — never reorder.
const TSV_COLUMNS = [
  'url', 'first_seen', 'portal', 'title', 'company', 'status', 'location',
  'fingerprint', 'posted_at', 'trust_score', 'trust_flags', 'normalized_company',
];

// Round 3 (Jim, 2026-09-22): exactly the columns he asked for. Status (always
// `added`), In pipeline and Trust were internal and are no longer printed.
// Description is deliberately LAST so anything reading the earlier columns by
// position keeps working.
export const EXPORT_COLUMNS = [
  { key: 'company', header: 'Company', width: 22 },
  { key: 'title', header: 'Title', width: 48 },
  { key: 'location', header: 'Location', width: 34 },
  { key: 'url', header: 'URL', width: 70 },
  { key: 'source', header: 'Source', width: 18 },
  { key: 'posted_at', header: 'Posted', width: 12 },
  { key: 'first_seen', header: 'First seen', width: 12 },
  { key: 'description', header: 'Description', width: 80 },
];

/**
 * Parse scan-history.tsv text into row objects. Header lines and malformed
 * (too-short) rows are skipped, matching how scan.mjs's own readers behave.
 * @param {string} text
 * @returns {Array<Record<string, string>>}
 */
export function parseScanHistory(text) {
  const rows = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (line.startsWith('url\t')) continue; // header
    const cells = line.split('\t');
    if (cells.length < 6 || !/^https?:\/\//i.test(cells[0])) continue;
    const row = {};
    TSV_COLUMNS.forEach((col, i) => { row[col] = cells[i] ?? ''; });
    rows.push(row);
  }
  return rows;
}

/**
 * URLs of the unchecked `- [ ] url | …` lines under `## Pending`.
 * @param {string} text
 * @returns {Set<string>} normalized URLs
 */
export function pendingUrls(text) {
  const out = new Set();
  const src = String(text ?? '');
  const start = src.search(/^## (Pending|Pendientes)\s*$/m);
  if (start === -1) return out;
  const after = src.slice(start);
  const next = after.slice(3).search(/^## /m);
  const section = next === -1 ? after : after.slice(0, next + 3);
  for (const m of section.matchAll(/^\s*- \[ \]\s+(https?:\/\/[^\s|]+)/gm)) {
    out.add(normalizeUrlForDedup(m[1]));
  }
  return out;
}

/**
 * The title predicate from the CURRENT portals.yml, in the exact shape the scan
 * loop uses: (title, entryName, jobCompany) => boolean. The ledger only knows
 * one company string, so the exporters pass it for both slots.
 *
 * Applying it at export time (not only at scan time) means tightening
 * portals.yml — like round 3 removing the lab override — cleans the
 * spreadsheet on the next export without rewriting the append-only ledger.
 * @param {string} [portalsPath]
 */
export function loadCurrentTitleFilter(portalsPath = PORTALS_PATH) {
  if (!existsSync(portalsPath)) return () => true;
  const config = yaml.load(readFileSync(portalsPath, 'utf-8'));
  return resolveTitleFilter(config);
}

/**
 * Everything the exporters read from disk, in one place: the ledger, the
 * Pending list, the current portals.yml title filter and the description
 * store. Shared by export-jobs.mjs, export-new-jobs.mjs and run-all.mjs so
 * the three cannot drift. Throws when the ledger is missing — nothing to
 * export before the first scan.
 * `blacklist` (data/blacklist.md, 2026-09-23) is applied here too, so a company
 * Jim blocks vanishes from both exports on the next run without ledger surgery.
 * @param {{historyPath?: string, pipelinePath?: string, portalsPath?: string, descriptionsPath?: string, blacklistPath?: string}} [paths]
 * @returns {{historyText: string, pipelineText: string, titleFilter: Function, descriptions: Map<string, string>, blacklist: Map<string, any>}}
 */
export function loadExportInputs({ historyPath = SCAN_HISTORY_PATH, pipelinePath = PIPELINE_PATH, portalsPath = PORTALS_PATH, descriptionsPath = DESCRIPTIONS_PATH, blacklistPath = undefined } = {}) {
  if (!existsSync(historyPath)) {
    throw new Error(`No scan history at ${historyPath} — run node scan.mjs first.`);
  }
  return {
    historyText: readFileSync(historyPath, 'utf-8'),
    pipelineText: existsSync(pipelinePath) ? readFileSync(pipelinePath, 'utf-8') : '',
    titleFilter: loadCurrentTitleFilter(portalsPath),
    descriptions: readDescriptions(descriptionsPath, normalizeUrlForDedup),
    blacklist: blacklistPath === undefined ? loadBlacklist() : loadBlacklist(blacklistPath),
  };
}

/**
 * Build the export rows: `added` only, newest first, one row per URL,
 * annotated with whether the URL is still in the Pending list. Rows whose
 * title fails `titleFilter` (default: keep all) are dropped, as are rows whose
 * company is on `blacklist` (normalised name → row, from data/blacklist.md).
 * `descriptions`
 * (normalized URL → text, from job-descriptions.mjs) fills the Description
 * column; a URL without one gets ''.
 *
 * `extraRows` are already-shaped rows from outside the ledger — today the
 * hand-picked Indeed jobs from indeed-rows.mjs. They obey `sinceDays` and
 * `pendingOnly` like everything else but NOT `titleFilter` (Jim chose them
 * himself), and a URL the ledger already emitted wins over an extra copy.
 * @param {{historyText: string, pipelineText?: string, sinceDays?: number|null, pendingOnly?: boolean, today?: string,
 *          titleFilter?: (title: string, entryName: string, jobCompany: string) => boolean,
 *          descriptions?: Map<string, string>, extraRows?: Array<Record<string, string>>, blacklist?: Map<string, any>|null}} opts
 */
export function buildRows({ historyText, pipelineText = '', sinceDays = null, pendingOnly = false, today = localToday(), titleFilter = null, descriptions = new Map(), extraRows = [], blacklist = null }) {
  const pending = pendingUrls(pipelineText);
  const cutoff = Number.isFinite(sinceDays) && sinceDays > 0
    ? new Date(Date.parse(`${today}T00:00:00Z`) - sinceDays * 86_400_000).toISOString().slice(0, 10)
    : null;

  const byUrl = new Map();
  for (const r of parseScanHistory(historyText)) {
    if (r.status !== 'added') continue;
    const key = normalizeUrlForDedup(r.url);
    const prev = byUrl.get(key);
    if (!prev || r.first_seen > prev.first_seen) byUrl.set(key, r);
  }

  const rows = [];
  for (const [key, r] of byUrl) {
    if (cutoff && r.first_seen < cutoff) continue;
    if (typeof titleFilter === 'function' && !titleFilter(r.title, r.company, r.company)) continue;
    if (blacklist instanceof Map && blacklist.size > 0 && blacklist.has(normalizeCompany(r.company || ''))) continue;
    const inPipeline = pending.has(key);
    if (pendingOnly && !inPipeline) continue;
    rows.push({
      company: r.company,
      title: r.title,
      location: r.location,
      url: r.url,
      posted_at: r.posted_at,
      first_seen: r.first_seen,
      source: r.portal,
      status: r.status,
      in_pipeline: inPipeline ? 'yes' : 'no',
      trust_score: r.trust_score,
      description: descriptions.get(key) ?? '',
    });
  }

  const emitted = new Set(rows.map(r => normalizeUrlForDedup(r.url)));
  for (const extra of extraRows) {
    const key = normalizeUrlForDedup(extra.url);
    if (emitted.has(key)) continue;
    if (cutoff && (extra.first_seen || '') < cutoff) continue;
    const inPipeline = pending.has(key);
    if (pendingOnly && !inPipeline) continue;
    emitted.add(key);
    rows.push({ ...extra, in_pipeline: inPipeline ? 'yes' : 'no' });
  }

  rows.sort((a, b) => (b.first_seen.localeCompare(a.first_seen))
    || (b.posted_at || '').localeCompare(a.posted_at || '')
    || a.company.localeCompare(b.company)
    || a.title.localeCompare(b.title));
  return rows;
}

/** @param {unknown} v */
function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** @param {Array<Record<string, string>>} rows */
export function toCsv(rows) {
  const lines = [EXPORT_COLUMNS.map(c => csvCell(c.header)).join(',')];
  for (const r of rows) lines.push(EXPORT_COLUMNS.map(c => csvCell(r[c.key])).join(','));
  return lines.join('\r\n') + '\r\n';
}

/**
 * @param {Array<Record<string, string>>} rows
 * @returns {ExcelJS.Workbook}
 */
export function buildWorkbook(rows) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'career-ops-scraper';
  wb.created = new Date();

  const ws = wb.addWorksheet('Jobs', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = EXPORT_COLUMNS.map(c => ({ header: c.header, key: c.key, width: c.width }));
  ws.getRow(1).font = { bold: true };
  // One line per job: the description is long, so it must not wrap the row tall.
  ws.getColumn('description').alignment = { vertical: 'top', wrapText: false };
  for (const r of rows) {
    const row = ws.addRow(r);
    const cell = row.getCell('url');
    if (/^https?:\/\//i.test(r.url)) {
      cell.value = { text: r.url, hyperlink: r.url };
      cell.font = { color: { argb: 'FF0563C1' }, underline: true };
    }
  }
  if (rows.length > 0) {
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: rows.length + 1, column: EXPORT_COLUMNS.length } };
  }

  const summary = wb.addWorksheet('Summary');
  summary.columns = [{ header: 'Company', key: 'k', width: 28 }, { header: 'Jobs', key: 'n', width: 8 }];
  summary.getRow(1).font = { bold: true };
  const byCompany = new Map();
  const byDay = new Map();
  for (const r of rows) {
    byCompany.set(r.company, (byCompany.get(r.company) || 0) + 1);
    byDay.set(r.first_seen, (byDay.get(r.first_seen) || 0) + 1);
  }
  for (const [k, n] of [...byCompany].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) summary.addRow({ k, n });
  summary.addRow({});
  const hdr = summary.addRow({ k: 'First seen', n: 'Jobs' });
  hdr.font = { bold: true };
  for (const [k, n] of [...byDay].sort((a, b) => b[0].localeCompare(a[0]))) summary.addRow({ k, n });
  summary.addRow({});
  summary.addRow({ k: 'Total', n: rows.length }).font = { bold: true };
  return wb;
}

const FILE_LOCKED_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);

/**
 * Write both files. Returns their paths, or null for a file that could not be
 * written because Excel has it open (Windows: EBUSY/EPERM, or EACCES through a
 * share). That is reported and the other file is still written, instead of the
 * whole run failing — `npm run scan:uk` chains export-new-jobs.mjs after this
 * with `&&`, and the new-jobs feed must not depend on Excel being closed.
 * @param {Array<Record<string, string>>} rows
 * @param {string} outDir
 * @param {string} [baseName]
 * @param {{writeCsv?: (file: string, text: string) => void,
 *          writeXlsx?: (wb: ExcelJS.Workbook, file: string) => Promise<void>,
 *          warn?: (msg: string) => void}} [opts]
 */
export async function writeExports(rows, outDir, baseName = 'uk-ai-jobs', {
  writeCsv = (file, text) => writeFileSync(file, text, 'utf-8'),
  writeXlsx = (wb, file) => wb.xlsx.writeFile(file),
  warn = (m) => console.error(m),
} = {}) {
  mkdirSync(outDir, { recursive: true });
  let csvPath = path.join(outDir, `${baseName}.csv`);
  let xlsxPath = path.join(outDir, `${baseName}.xlsx`);
  const locked = (file) => warn(`Excel: skipped — ${path.basename(file)} is open in Excel; close it and rerun npm run export`);
  try {
    writeCsv(csvPath, toCsv(rows));
  } catch (err) {
    if (!FILE_LOCKED_CODES.has(err?.code)) throw err;
    locked(csvPath);
    csvPath = null;
  }
  try {
    await writeXlsx(buildWorkbook(rows), xlsxPath);
  } catch (err) {
    if (!FILE_LOCKED_CODES.has(err?.code)) throw err;
    locked(xlsxPath);
    xlsxPath = null;
  }
  return { csvPath, xlsxPath };
}

const KNOWN_FLAGS = ['--since', '--pending-only', '--out', '--help', '-h'];
const USAGE = `Usage:
  node export-jobs.mjs [--since <days>] [--pending-only] [--out <dir>]
  node export-jobs.mjs --help`;

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) { console.log(USAGE); return; }
  validateFlags(args, KNOWN_FLAGS, USAGE, { valueFlags: ['--since', '--out'] });
  const since = parseSinceDays(args);
  if (since.error) { console.error(`Error: ${since.error}`); process.exit(1); }
  const outDir = flagValue(args, '--out') || path.join(getCareerOpsRoot(), 'data', 'exports');
  if (hasFlag(args, '--out') && !flagValue(args, '--out')) { console.error('Error: --out requires a directory'); process.exit(1); }

  let inputs;
  try { inputs = loadExportInputs(); } catch (err) { console.error(err.message); process.exit(1); }

  const rows = buildRows({
    ...inputs, sinceDays: since.days, pendingOnly: args.includes('--pending-only'),
    extraRows: readIndeedRows(),
  });
  const { csvPath, xlsxPath } = await writeExports(rows, outDir);
  reportExport(rows, { csvPath, xlsxPath });
}

/**
 * The console summary of a full export — shared with run-all.mjs.
 * @param {Array<Record<string, string>>} rows
 * @param {{csvPath: string|null, xlsxPath: string|null}} paths
 * @param {(msg: string) => void} [log]
 */
export function reportExport(rows, { csvPath, xlsxPath }, log = console.log) {
  const companies = new Set(rows.map(r => r.company)).size;
  const withDescription = rows.filter(r => r.description).length;
  const indeed = rows.filter(r => r.source === 'indeed').length;
  const indeedNote = indeed > 0 ? `, ${indeed} from Indeed` : '';
  log(`Exported ${rows.length} job(s) from ${companies} compan${companies === 1 ? 'y' : 'ies'} (${withDescription} with a description${indeedNote})`);
  if (xlsxPath) log(`  Excel: ${xlsxPath}`);
  if (csvPath) log(`  CSV:   ${csvPath}`);
  if (!csvPath && !xlsxPath) log('  Nothing written — both files are open in Excel. Close them and run: npm run export');
}

if (isMainModule(import.meta.url)) {
  main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
}
