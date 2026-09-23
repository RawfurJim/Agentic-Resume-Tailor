#!/usr/bin/env node
/**
 * indeed-rows.mjs — the hand-picked Indeed jobs, in the exporters' row shape.
 *
 * indeed_scrapper/indeed_grab.py (Python + Playwright) writes
 *   indeed_scrapper/jobs.csv      link, title, company, description, date
 * for every Indeed link Jim pastes into indeed_scrapper/links.txt. Those jobs
 * never pass through scan.mjs or the ledger, so export-jobs.mjs and
 * export-new-jobs.mjs read them from here and append them as `extraRows`:
 * they appear in uk-ai-jobs.csv/.xlsx and in the new-jobs feed with
 * Source `indeed`, and — because Jim chose them by hand — the title filter is
 * NOT applied to them (round 4, 2026-09-22).
 *
 * The URL written out is the clean job page (`https://uk.indeed.com/viewjob?jk=…`)
 * rather than the search-results link that was pasted, so the same job pasted
 * from two searches dedups to one row, and exported-urls.txt gets a stable key
 * (normalizeUrlForDedup keeps `jk`).
 *
 * No csv library is in package.json, so a small RFC 4180 reader lives here.
 */

import { existsSync, readFileSync } from 'fs';
import path from 'path';

import { normalizeDescription } from './job-descriptions.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';

export const INDEED_JOBS_PATH = process.env.CAREER_OPS_INDEED_JOBS
  || path.join(getCareerOpsRoot(), 'indeed_scrapper', 'jobs.csv');

/** Mirrors `job_key()` in indeed_grab.py: the Indeed job key is 8–32 word chars. */
const JOB_KEY_RE = /^\w{8,32}$/;

/**
 * Minimal RFC 4180 parser: quoted fields may hold commas, quotes ("" → ") and
 * line breaks; rows end at CRLF or LF; a leading BOM is dropped; a trailing
 * newline does not produce an empty row.
 * @param {string} text
 * @returns {string[][]}
 */
export function parseCsv(text) {
  const src = String(text ?? '').replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      cell += ch; i++; continue;
    }
    if (ch === '"') { quoted = true; i++; continue; }
    if (ch === ',') { row.push(cell); cell = ''; i++; continue; }
    if (ch === '\r' || ch === '\n') {
      row.push(cell); cell = '';
      rows.push(row); row = [];
      i += (ch === '\r' && src[i + 1] === '\n') ? 2 : 1;
      continue;
    }
    cell += ch; i++;
  }
  if (cell !== '' || row.length > 0) { row.push(cell); rows.push(row); }
  return rows;
}

/**
 * The clean job-page URL for any Indeed link, or null when it is not one.
 * Port of `job_key()` in indeed_grab.py: `vjk` or `jk` query param, host kept
 * (uk.indeed.com stays), bare indeed.com → www.indeed.com.
 * @param {string} link
 * @returns {string|null}
 */
export function indeedJobUrl(link) {
  let u;
  try { u = new URL(String(link)); } catch { return null; }
  let host = u.hostname.toLowerCase();
  if (!host.includes('indeed.')) return null;
  const jk = u.searchParams.get('vjk') || u.searchParams.get('jk');
  if (!jk || !JOB_KEY_RE.test(jk)) return null;
  if ((host.match(/\./g) || []).length < 2) host = 'www.indeed.com';
  return `https://${host}/viewjob?jk=${jk}`;
}

/**
 * The job's location. indeed_grab.py writes a `Location:` line into the header
 * block above the `---` separator (from Indeed's structured data, since Sep
 * 2026); older rows only have whatever `Location:` line the job text itself
 * carries after the separator. Header first, body second, else ''.
 * @param {string} description
 * @returns {string}
 */
export function indeedLocation(description) {
  const s = String(description ?? '');
  const sep = s.indexOf('\n---');
  const header = sep === -1 ? '' : s.slice(0, sep);
  const body = sep === -1 ? '' : s.slice(sep + 4);
  const fromHeader = header.match(/^Location:\s*(.+?)\s*$/m);
  if (fromHeader) return fromHeader[1];
  const fromBody = body.match(/^Location:\s*(.+?)\s*$/m);
  return fromBody ? fromBody[1] : '';
}

/**
 * Rows in exactly the shape export-jobs.mjs `buildRows` produces, so the
 * exporters can concatenate without special cases.
 * @param {string} text  contents of indeed_scrapper/jobs.csv
 * @returns {Array<Record<string, string>>}
 */
export function indeedRowsFromCsv(text) {
  const table = parseCsv(text);
  if (table.length < 2) return [];
  const header = table[0].map(h => h.trim().toLowerCase());
  const col = (name) => header.indexOf(name);
  const iLink = col('link'), iTitle = col('title'), iCompany = col('company'), iDesc = col('description'), iDate = col('date');
  if (iLink === -1) return [];
  const rows = [];
  for (const cells of table.slice(1)) {
    const link = (cells[iLink] ?? '').trim();
    if (!link) continue;
    const description = normalizeDescription(cells[iDesc] ?? '');
    const date = (cells[iDate] ?? '').trim();
    rows.push({
      company: (cells[iCompany] ?? '').trim(),
      title: (cells[iTitle] ?? '').trim(),
      location: indeedLocation(description),
      url: indeedJobUrl(link) ?? link,
      posted_at: date,
      first_seen: date,
      source: 'indeed',
      status: 'added',
      in_pipeline: 'no',
      trust_score: '',
      description,
    });
  }
  return rows;
}

/**
 * @param {string} [file]
 * @returns {Array<Record<string, string>>}  [] when the file is missing or empty
 */
export function readIndeedRows(file = INDEED_JOBS_PATH) {
  if (!existsSync(file)) return [];
  return indeedRowsFromCsv(readFileSync(file, 'utf-8'));
}
