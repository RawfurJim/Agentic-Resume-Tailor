// export-new-jobs.mjs: after each scan, write ONE csv holding only the jobs that
// have never been handed out before, into data/new-data/, and remember their
// URLs so the next run's file holds only the next batch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { selectNewRows, newFileName, readExportedUrls, runNewExport, reportNewExport, isRecent, jobKey, dedupeByJobKey, EXPORTED_URLS_FILE, DEFAULT_MAX_AGE_DAYS } =
  await import('../export-new-jobs.mjs');

const HEADER = 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\tlocation\tfingerprint\tposted_at\ttrust_score\ttrust_flags\tnormalized_company\n';
const ROW1 = 'https://job-boards.greenhouse.io/anthropic/jobs/1\t2026-09-18\tgreenhouse-api\tForward Deployed Engineer\tAnthropic\tadded\tLondon, UK\t\t2026-09-16\t\t\tanthropic\n';
const ROW2 = 'https://jobs.ashbyhq.com/openai/3\t2026-09-21\tashby-api\tML Engineer, "Agents"\tOpenAI\tadded\tDublin, Ireland\t\t2026-09-20\t\t\topenai\n';
const ROW3 = 'https://jobs.ashbyhq.com/openai/4\t2026-09-21\tashby-api\tOld role\tOpenAI\tskipped_expired\tLondon\t\t\t\t\topenai\n';
const NOW = new Date('2026-09-21T19:04:05');

test('selectNewRows: only added rows whose URL was never exported', () => {
  // `today` pinned to the fixture date: ROW1 was posted 2026-09-16, exactly 5 days before (the boundary day is in).
  const rows = selectNewRows(HEADER + ROW1 + ROW2 + ROW3, new Set([]), '', { today: '2026-09-21' });
  assert.deepEqual(rows.map(r => r.company), ['OpenAI', 'Anthropic']); // newest first, like the main export
  const again = selectNewRows(HEADER + ROW1 + ROW2 + ROW3, new Set(['https://job-boards.greenhouse.io/anthropic/jobs/1']), '', { today: '2026-09-21' });
  assert.deepEqual(again.map(r => r.company), ['OpenAI']);
});

test('selectNewRows: exported list matches on the normalized URL (tracking params, trailing slash)', () => {
  const rows = selectNewRows(HEADER + ROW1, new Set(['https://job-boards.greenhouse.io/anthropic/jobs/1/?utm_source=x']), '', { today: '2026-09-21' });
  assert.equal(rows.length, 0);
});

test('newFileName: sortable timestamp, one file per run', () => {
  assert.equal(newFileName(NOW), 'new-jobs-2026-09-21-190405.csv');
});

test('readExportedUrls: missing file → empty set; blank lines ignored', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'newjobs-'));
  assert.equal(readExportedUrls(dir).size, 0);
  writeFileSync(path.join(dir, EXPORTED_URLS_FILE), 'https://a/1\n\nhttps://a/2\n');
  assert.equal(readExportedUrls(dir).size, 2);
});

test('runNewExport: first run writes the csv + url list; second run with nothing new writes no file', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'newjobs-'));
  const r1 = runNewExport({ historyText: HEADER + ROW1 + ROW2 + ROW3, newDir: dir, now: NOW });
  assert.equal(r1.rows.length, 2);
  assert.equal(path.basename(r1.csvPath), 'new-jobs-2026-09-21-190405.csv');
  const csv = readFileSync(r1.csvPath, 'utf8');
  assert.ok(csv.startsWith('Company,Title,Location,URL,Source,Posted,First seen,Description\r\n'));
  assert.equal(csv.trim().split('\r\n').length, 3); // header + 2
  assert.ok(csv.includes('"ML Engineer, ""Agents"""'));
  const listed = readFileSync(path.join(dir, EXPORTED_URLS_FILE), 'utf8').trim().split('\n');
  assert.equal(listed.length, 2);

  const r2 = runNewExport({ historyText: HEADER + ROW1 + ROW2 + ROW3, newDir: dir, now: new Date('2026-09-22T08:00:00') });
  assert.equal(r2.rows.length, 0);
  assert.equal(r2.csvPath, null);
  assert.deepEqual(readdirSync(dir).filter(f => f.endsWith('.csv')), ['new-jobs-2026-09-21-190405.csv']);
});

test('runNewExport: a later run picks up only the newly added row and appends to the url list', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'newjobs-'));
  runNewExport({ historyText: HEADER + ROW1, newDir: dir, now: NOW });
  const r2 = runNewExport({ historyText: HEADER + ROW1 + ROW2, newDir: dir, now: new Date('2026-09-22T08:00:00') });
  assert.deepEqual(r2.rows.map(r => r.company), ['OpenAI']);
  assert.equal(path.basename(r2.csvPath), 'new-jobs-2026-09-22-080000.csv');
  assert.equal(readExportedUrls(dir).size, 2);
  assert.equal(readdirSync(dir).filter(f => f.endsWith('.csv')).length, 2);
});

test('runNewExport --dry-run: reports rows but writes nothing', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'newjobs-'));
  const r = runNewExport({ historyText: HEADER + ROW1 + ROW2, newDir: dir, now: NOW, dryRun: true });
  assert.equal(r.rows.length, 2);
  assert.equal(r.csvPath, null);
  assert.ok(!existsSync(path.join(dir, EXPORTED_URLS_FILE)));
  assert.deepEqual(readdirSync(dir), []);
});

// ── Round 3: only recent jobs reach the new-jobs feed (7 days; Jim cut it to 5 in round 6, 2026-09-22) ──
const TODAY = '2026-09-21';
const row = (url, posted, firstSeen = TODAY, title = 'AI Engineer') =>
  `${url}\t${firstSeen}\tashby-api\t${title}\tAcme\tadded\tLondon\t\t${posted}\t\t\tacme\n`;

// Round 5 (Jim, 2026-09-22): "put the Microsoft jobs on new-jobs.csv". Age is
// the YOUNGER of posted-date age and first-seen age: a job the scraper first
// saw this week is new to Jim even if Microsoft/Amazon posted it a month ago.
test('isRecent: posted date within the window passes, boundary day is in; default window is 5 days (Jim, 2026-09-22)', () => {
  assert.equal(DEFAULT_MAX_AGE_DAYS, 5);
  assert.equal(isRecent({ posted_at: '2026-09-18', first_seen: '2026-09-01' }, DEFAULT_MAX_AGE_DAYS, TODAY), true);   // 3 days
  assert.equal(isRecent({ posted_at: '2026-09-16', first_seen: '2026-09-01' }, DEFAULT_MAX_AGE_DAYS, TODAY), true);   // exactly 5 → in
  assert.equal(isRecent({ posted_at: '2026-09-15', first_seen: '2026-09-01' }, DEFAULT_MAX_AGE_DAYS, TODAY), false);  // 6 days → out
  assert.equal(isRecent({ posted_at: TODAY, first_seen: '2026-09-01' }, DEFAULT_MAX_AGE_DAYS, TODAY), true);          // today
  assert.equal(isRecent({ posted_at: '2026-09-14', first_seen: '2026-09-01' }, 7, TODAY), true);   // --max-age-days 7 still widens it
});

test('isRecent: the posting date rules — a month-old ad first seen today is NOT new (Jim, 2026-09-22)', () => {
  // Round 5 used the younger of posted/first_seen so a freshly added board's old postings surfaced;
  // with Adzuna + Reed that put 60-day-old ads in the feed, so the posting date is the only clock again.
  assert.equal(isRecent({ posted_at: '2026-08-13', first_seen: TODAY }, 7, TODAY), false);
  assert.equal(isRecent({ posted_at: '2026-09-07', first_seen: '2026-09-20' }, 7, TODAY), false);  // 14 days → out
  assert.equal(isRecent({ posted_at: '2026-09-13', first_seen: '2026-09-13' }, 7, TODAY), false);  // 8 days → out
  assert.equal(isRecent({ posted_at: '2026-09-20', first_seen: '2026-09-01' }, 7, TODAY), true);   // posted 1 day ago
});

test('isRecent: no posted date → age counts from the day we first saw it', () => {
  assert.equal(isRecent({ posted_at: '', first_seen: TODAY }, 7, TODAY), true);
  assert.equal(isRecent({ posted_at: '', first_seen: '2026-09-01' }, 7, TODAY), false);
  assert.equal(isRecent({ posted_at: 'garbage', first_seen: TODAY }, 7, TODAY), true);      // unparsable → fall back
});

test('isRecent: maxAgeDays 0 or null disables the window', () => {
  assert.equal(isRecent({ posted_at: '2020-01-01', first_seen: '2020-01-01' }, 0, TODAY), true);
  assert.equal(isRecent({ posted_at: '2020-01-01', first_seen: '2020-01-01' }, null, TODAY), true);
});

test('selectNewRows: drops jobs older than the window, keeps the rest', () => {
  const tsv = HEADER
    + row('https://jobs.ashbyhq.com/acme/fresh', '2026-09-19')
    + row('https://jobs.ashbyhq.com/acme/stale', '2026-09-01', '2026-09-01', 'Data Scientist')   // old posting, seen long ago
    + row('https://jobs.ashbyhq.com/acme/undated-new', '', TODAY, 'ML Engineer')                  // no posting date → first seen counts
    + row('https://jobs.ashbyhq.com/acme/undated-old', '', '2026-08-30', 'LLM Engineer');
  const rows = selectNewRows(tsv, new Set(), '', { today: TODAY });
  assert.deepEqual(rows.map(r => r.url.split('/').pop()).sort(), ['fresh', 'undated-new']);
  const all = selectNewRows(tsv, new Set(), '', { today: TODAY, maxAgeDays: 0 });
  assert.equal(all.length, 4);
});

// ── 2026-09-22: one row per company + title (any UK location) ──
const dupRow = (slug, title, location, posted, extra = {}) => ({
  company: 'Hackajob Ltd', title, location, url: `https://www.adzuna.co.uk/jobs/details/${slug}`,
  posted_at: posted, first_seen: TODAY, source: 'adzuna-api', status: 'added', in_pipeline: 'no', trust_score: '',
  description: '', ...extra,
});

test('jobKey: company + title, case/punctuation/spacing-insensitive, location ignored', () => {
  assert.equal(jobKey({ company: 'Hackajob Ltd', title: 'Senior  AI Engineer' }), jobKey({ company: 'HACKAJOB LTD.', title: 'Senior AI-Engineer' }));
  assert.equal(jobKey({ company: 'A', title: 'X', location: 'London' }), jobKey({ company: 'A', title: 'X', location: 'Leeds' }));
  assert.notEqual(jobKey({ company: 'A', title: 'AI Engineer' }), jobKey({ company: 'A', title: 'Senior AI Engineer' }));
  assert.notEqual(jobKey({ company: 'A', title: 'AI Engineer' }), jobKey({ company: 'B', title: 'AI Engineer' }));
});

test('dedupeByJobKey: keeps one per key — the copy with a description, then the newest posted, then the first', () => {
  const rows = [
    dupRow('1', 'Machine Learning Engineer', 'London', '2026-09-21'),
    dupRow('2', 'Machine Learning Engineer', 'Manchester', '2026-09-20', { description: 'Full JD' }),
    dupRow('3', 'Machine Learning Engineer', 'Leeds', '2026-09-21'),
    dupRow('4', 'Data Scientist', 'Bristol', '2026-09-19'),
    dupRow('5', 'Data Scientist', 'Glasgow', '2026-09-21'),
    dupRow('6', 'Lead AI Engineer', 'London', '2026-09-21'),
    dupRow('7', 'Lead AI Engineer', 'Remote', '2026-09-21'),
  ];
  const { kept, duplicates } = dedupeByJobKey(rows);
  assert.deepEqual(kept.map(r => r.url.split('/').pop()), ['2', '5', '6']);
  assert.deepEqual(duplicates.map(r => r.url.split('/').pop()), ['1', '3', '4', '7']);
  assert.deepEqual(dedupeByJobKey([]), { kept: [], duplicates: [] });
});

test('runNewExport: duplicates are not written but their URLs ARE remembered, and reported', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'newjobs-'));
  const extraRows = [
    dupRow('a', 'Forward Deployed Engineer', 'London', '2026-09-21'),
    dupRow('b', 'Forward Deployed Engineer', 'Edinburgh', '2026-09-21'),
    dupRow('c', 'Forward Deployed Engineer', 'Cardiff', '2026-09-21'),
  ];
  const r = runNewExport({ historyText: HEADER, newDir: dir, now: NOW, extraRows });
  assert.equal(r.rows.length, 1);
  assert.equal(r.skippedDuplicates.length, 2);
  assert.equal(readFileSync(r.csvPath, 'utf8').trim().split('\r\n').length, 2);
  assert.equal(readExportedUrls(dir).size, 3, 'duplicate URLs remembered so they are not re-issued next run');
  const r2 = runNewExport({ historyText: HEADER, newDir: dir, now: new Date('2026-09-22T08:00:00'), extraRows });
  assert.equal(r2.rows.length, 0);
  assert.equal(r2.skippedDuplicates.length, 0);
  assert.equal(r2.csvPath, null);
  const lines = [];
  reportNewExport(r, { log: (m) => lines.push(m) });
  assert.match(lines[0], /2 skipped as the same company \+ title in another location/);
});

test('runNewExport: only duplicates of an already-exported job are still judged per run, not against history', () => {
  // Cross-run: a second location of a job handed out LAST run is a new URL and is written again.
  // Known limit — dedupe is per file. Guard so a future change here is deliberate.
  const dir = mkdtempSync(path.join(os.tmpdir(), 'newjobs-'));
  runNewExport({ historyText: HEADER, newDir: dir, now: NOW, extraRows: [dupRow('a', 'AI Engineer', 'London', '2026-09-21')] });
  const r2 = runNewExport({ historyText: HEADER, newDir: dir, now: new Date('2026-09-22T08:00:00'), extraRows: [dupRow('a', 'AI Engineer', 'London', '2026-09-21'), dupRow('b', 'AI Engineer', 'Leeds', '2026-09-21')] });
  assert.equal(r2.rows.length, 1);
});

test('runNewExport: too-old jobs are not written but ARE remembered, and reported', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'newjobs-'));
  const tsv = HEADER
    + row('https://jobs.ashbyhq.com/acme/fresh', '2026-09-19')
    + row('https://jobs.ashbyhq.com/acme/stale', '2026-09-01', '2026-09-01');
  const r = runNewExport({ historyText: tsv, newDir: dir, now: new Date('2026-09-21T19:04:05') });
  assert.deepEqual(r.rows.map(x => x.url.split('/').pop()), ['fresh']);
  assert.equal(r.skippedOld.length, 1);
  assert.equal(r.skippedOld[0].url, 'https://jobs.ashbyhq.com/acme/stale');
  assert.equal(readFileSync(r.csvPath, 'utf8').trim().split('\r\n').length, 2);
  assert.equal(readExportedUrls(dir).size, 2, 'stale URL remembered so it is never re-evaluated');
  // next run: nothing new, nothing old
  const r2 = runNewExport({ historyText: tsv, newDir: dir, now: new Date('2026-09-22T08:00:00') });
  assert.equal(r2.rows.length, 0);
  assert.equal(r2.skippedOld.length, 0);
});

test('runNewExport: only stale jobs → no csv, but the URLs are still remembered', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'newjobs-'));
  const r = runNewExport({ historyText: HEADER + row('https://jobs.ashbyhq.com/acme/stale', '2026-09-01', '2026-09-01'), newDir: dir, now: new Date('2026-09-21T19:04:05') });
  assert.equal(r.csvPath, null);
  assert.equal(r.skippedOld.length, 1);
  assert.equal(readExportedUrls(dir).size, 1);
  assert.deepEqual(readdirSync(dir).filter(f => f.endsWith('.csv')), []);
});

test('runNewExport: carries the job description from the store into the csv', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'newjobs-'));
  const descriptions = new Map([['https://jobs.ashbyhq.com/openai/3', 'Build agents.\nShip weekly.']]);
  const r = runNewExport({ historyText: HEADER + ROW2, newDir: dir, now: NOW, descriptions });
  const csv = readFileSync(r.csvPath, 'utf8');
  assert.ok(csv.includes(',"Build agents.\nShip weekly."\r\n'), csv);
});

// ── Round 4 (2026-09-22): Indeed jobs (indeed-rows.mjs) join the feed as extraRows ──
const indeedRow = (jk, date) => ({
  company: 'Acme', title: 'Warehouse Operative', location: 'Leeds', url: `https://uk.indeed.com/viewjob?jk=${jk}`,
  posted_at: date, first_seen: date, source: 'indeed', status: 'added', in_pipeline: 'no', trust_score: '',
  description: 'Title: X\n\n---\n\nbody',
});

test('runNewExport extraRows: Indeed row written with Source indeed, remembered, and not re-issued', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'newjobs-'));
  const extraRows = [indeedRow('aaaaaaaa11111111', '2026-09-21')];
  const r1 = runNewExport({ historyText: HEADER + ROW2, newDir: dir, now: NOW, extraRows, titleFilter: (t) => /ML/.test(t) });
  assert.deepEqual(r1.rows.map(r => r.source).sort(), ['ashby-api', 'indeed']);
  const csv = readFileSync(r1.csvPath, 'utf8');
  assert.ok(csv.includes('Acme,Warehouse Operative,Leeds,https://uk.indeed.com/viewjob?jk=aaaaaaaa11111111,indeed,2026-09-21,2026-09-21,'), csv);
  assert.ok(readExportedUrls(dir).has('https://uk.indeed.com/viewjob?jk=aaaaaaaa11111111'));
  const r2 = runNewExport({ historyText: HEADER + ROW2, newDir: dir, now: new Date('2026-09-22T08:00:00'), extraRows });
  assert.equal(r2.rows.length, 0);
  assert.equal(r2.csvPath, null);
});

test('runNewExport extraRows: an Indeed row older than the window is remembered but not written', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'newjobs-'));
  const r = runNewExport({ historyText: HEADER, newDir: dir, now: NOW, extraRows: [indeedRow('bbbbbbbb22222222', '2026-09-01')] });
  assert.equal(r.csvPath, null);
  assert.equal(r.skippedOld.length, 1);
  assert.equal(readExportedUrls(dir).size, 1);
});

test('runNewExport extraRows + dry-run: nothing written', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'newjobs-'));
  const r = runNewExport({ historyText: HEADER, newDir: dir, now: NOW, dryRun: true, extraRows: [indeedRow('aaaaaaaa11111111', '2026-09-21')] });
  assert.equal(r.rows.length, 1);
  assert.deepEqual(readdirSync(dir), []);
});

test('selectNewRows: extraRows option reaches the split', () => {
  const rows = selectNewRows(HEADER, new Set(), '', { today: '2026-09-21', extraRows: [indeedRow('aaaaaaaa11111111', '2026-09-21')] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, 'indeed');
});

// ── 2026-09-23 (Jim): blacklisted companies never reach the new-jobs feed either ──
test('splitNewRows: a blacklisted company (eFinancialCareers) is dropped before the feed is built', async () => {
  const { splitNewRows } = await import('../export-new-jobs.mjs');
  const { normalizeCompany } = await import('../tracker-utils.mjs');
  const header = 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\tlocation\tfingerprint\tposted_at\ttrust_score\ttrust_flags\tnormalized_company\n';
  const tsv = header
    + 'https://www.reed.co.uk/jobs/machine-learning-engineer/57375181\t2026-09-21\treed-api\tMachine Learning Engineer\teFinancialCareers\tadded\tLondon\t\t2026-09-21\t\t\tefinancialcareers\n'
    + 'https://jobs.ashbyhq.com/openai/3\t2026-09-21\tashby-api\tML Engineer\tOpenAI\tadded\tDublin\t\t2026-09-21\t\t\topenai\n';
  const blacklist = new Map([[normalizeCompany('eFinancialCareers'), { company: 'eFinancialCareers', scope: 'company', reason: 'sector: finance' }]]);
  const r = splitNewRows(tsv, new Set(), '', { today: '2026-09-22', blacklist });
  assert.deepEqual(r.rows.map(x => x.company), ['OpenAI']);
  assert.equal(splitNewRows(tsv, new Set(), '', { today: '2026-09-22' }).rows.length, 2, 'no blacklist → both');
});
