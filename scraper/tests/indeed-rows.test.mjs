// indeed-rows.mjs: read indeed_scrapper/jobs.csv (written by indeed_grab.py) and
// turn each row into the same shape export-jobs.mjs builds from the ledger, so
// hand-picked Indeed jobs ride along in uk-ai-jobs.csv and the new-jobs feed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { parseCsv, indeedJobUrl, indeedLocation, indeedRowsFromCsv, readIndeedRows, INDEED_JOBS_PATH } =
  await import('../indeed-rows.mjs');

const BOM = '﻿';
const LINK = 'https://uk.indeed.com/jobs?q=AI+Engineer&l=United+Kingdom&fromage=1&from=searchOnDesktopSerp&vjk=28007f9f9fcf3a6c';
const DESC = 'Title: AI Engineer\nCompany: Acme\nDate: 2026-09-17\nLink: ' + LINK + '\n\n---\n\nRSW-P3-12\n\nAI Engineer\n\nLocation: Cambridge, Hybrid\n\nJob type: Permanent';
const csvCell = (s) => `"${s.replace(/"/g, '""')}"`;
const JOBS_CSV = BOM + 'link,title,company,description,date\r\n'
  + `${LINK},AI Engineer,Acme,${csvCell(DESC)},2026-09-17\r\n`;

test('parseCsv: BOM, CRLF/LF, quoted commas and newlines, doubled quotes, no trailing empty row', () => {
  const rows = parseCsv(BOM + 'a,b\r\n1,"x, y"\n2,"line1\r\nline2"\r\n3,"say ""hi"""\r\n');
  assert.deepEqual(rows, [['a', 'b'], ['1', 'x, y'], ['2', 'line1\r\nline2'], ['3', 'say "hi"']]);
  assert.deepEqual(parseCsv(''), []);
});

test('indeedJobUrl: vjk/jk → clean viewjob URL on the same host; bare indeed.com → www', () => {
  assert.equal(indeedJobUrl(LINK), 'https://uk.indeed.com/viewjob?jk=28007f9f9fcf3a6c');
  assert.equal(indeedJobUrl('https://uk.indeed.com/viewjob?jk=6a8067c9a670912c'), 'https://uk.indeed.com/viewjob?jk=6a8067c9a670912c');
  assert.equal(indeedJobUrl('https://indeed.com/viewjob?jk=6a8067c9a670912c'), 'https://www.indeed.com/viewjob?jk=6a8067c9a670912c');
  assert.equal(indeedJobUrl('https://www.linkedin.com/jobs/view/123?vjk=6a8067c9a670912c'), null);
  assert.equal(indeedJobUrl('https://uk.indeed.com/jobs?q=ai'), null);
  assert.equal(indeedJobUrl('https://uk.indeed.com/viewjob?jk=bad!key'), null);
  assert.equal(indeedJobUrl('not a url'), null);
});

test('indeedLocation: header Location: line first (scraper-written), else the body\'s, else empty', () => {
  assert.equal(indeedLocation(DESC), 'Cambridge, Hybrid');                              // old row: body only
  assert.equal(indeedLocation('Title: X\n\n---\n\nNo location here'), '');
  assert.equal(indeedLocation('Title: X\nLocation: London\nDate: 2026-09-22\n\n---\n\nbody'), 'London');
  assert.equal(indeedLocation('Title: X\nLocation: Remote\n\n---\n\nLocation: Cambridge, Hybrid'), 'Remote'); // header wins
  assert.equal(indeedLocation(''), '');
});

test('indeedRowsFromCsv: export-shaped rows, source indeed, dates from the scrape day', () => {
  const rows = indeedRowsFromCsv(JOBS_CSV);
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.company, 'Acme');
  assert.equal(r.title, 'AI Engineer');
  assert.equal(r.location, 'Cambridge, Hybrid');
  assert.equal(r.url, 'https://uk.indeed.com/viewjob?jk=28007f9f9fcf3a6c');
  assert.equal(r.source, 'indeed');
  assert.equal(r.posted_at, '2026-09-17');
  assert.equal(r.first_seen, '2026-09-17');
  assert.equal(r.status, 'added');
  assert.equal(r.in_pipeline, 'no');
  assert.equal(r.trust_score, '');
  assert.ok(r.description.startsWith('Title: AI Engineer\nCompany: Acme'), r.description);
  assert.ok(r.description.includes('Location: Cambridge, Hybrid'));
  assert.ok(!r.description.includes('\r'));
});

test('indeedRowsFromCsv: a link without a job key keeps the raw link; blank/short rows are skipped', () => {
  const csv = 'link,title,company,description,date\r\nhttps://example.com/job/1,T,C,"body",2026-09-01\r\n\r\n';
  const rows = indeedRowsFromCsv(csv);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].url, 'https://example.com/job/1');
  assert.deepEqual(indeedRowsFromCsv('link,title,company,description,date\r\n'), []);
});

test('readIndeedRows: missing or empty file → []', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'indeed-'));
  assert.deepEqual(readIndeedRows(path.join(dir, 'nope.csv')), []);
  const empty = path.join(dir, 'empty.csv');
  writeFileSync(empty, '');
  assert.deepEqual(readIndeedRows(empty), []);
  const file = path.join(dir, 'jobs.csv');
  writeFileSync(file, JOBS_CSV);
  assert.equal(readIndeedRows(file).length, 1);
});

test('readIndeedRows: the real indeed_scrapper/jobs.csv parses (2 rows as of 2026-09-22)', () => {
  assert.ok(INDEED_JOBS_PATH.endsWith(path.join('indeed_scrapper', 'jobs.csv')));
  const rows = readIndeedRows();
  assert.ok(rows.length >= 2, `expected the two saved Indeed jobs, got ${rows.length}`);
  const mundi = rows.find(r => r.company === 'Mundipharma');
  assert.ok(mundi);
  assert.equal(mundi.location, 'Cambridge, Hybrid');
  assert.equal(mundi.url, 'https://uk.indeed.com/viewjob?jk=28007f9f9fcf3a6c');
  assert.ok(mundi.description.length > 1000);
});
