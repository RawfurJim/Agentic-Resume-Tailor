// backfill-descriptions.mjs: one-off fill of data/job-descriptions.jsonl for
// jobs already in the ledger, via the ATS public APIs (Greenhouse, Lever,
// Ashby, Workday). Round 3 (Jim, 2026-09-22).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { selectMissing, runBackfill, TEASER_PORTALS, TEASER_MAX_CHARS } = await import('../backfill-descriptions.mjs');
const { readDescriptions, normalizeDescription } = await import('../job-descriptions.mjs');
const { normalizeUrlForDedup } = await import('../scan.mjs');

const HEADER = 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\tlocation\tfingerprint\tposted_at\ttrust_score\ttrust_flags\tnormalized_company\n';
const TSV = HEADER
  + 'https://job-boards.greenhouse.io/anthropic/jobs/1\t2026-09-18\tgreenhouse-api\tAI Engineer\tAnthropic\tadded\tLondon\t\t2026-09-14\t\t\tanthropic\n'
  + 'https://jobs.ashbyhq.com/openai/3\t2026-09-21\tashby-api\tML Engineer\tOpenAI\tadded\tDublin\t\t\t\t\topenai\n'
  + 'https://darktrace.wd3.myworkdayjobs.com/en-US/darktrace/job/London/ML-Engineer_R42\t2026-09-21\tworkday-api\tML Engineer\tDarktrace\tadded\tLondon\t\t\t\t\tdarktrace\n'
  + 'https://apply.careers.microsoft.com/careers/job/17\t2026-09-21\tmicrosoft-api\tAI Engineer\tMicrosoft\tadded\tLondon\t\t\t\t\tmicrosoft\n'
  + 'https://jobs.ashbyhq.com/openai/4\t2026-09-21\tashby-api\tOld ML role\tOpenAI\tskipped_expired\tLondon\t\t\t\t\topenai\n'
  + 'https://jobs.ashbyhq.com/openai/5\t2026-09-21\tashby-api\tSoftware Engineer\tOpenAI\tadded\tLondon\t\t\t\t\topenai\n';
const LONG = 'Responsibilities: build and ship machine learning systems in production. '.repeat(6);
// Round 6: Adzuna / Reed rows arrive with a ~500-char teaser stored; the backfill upgrades them.
const TEASER = 'We have an exciting opportunity for a Senior AI Engineer to join our IT team based in Belfast. '.repeat(5);
const ADZ = 'https://www.adzuna.co.uk/jobs/land/ad/5893962963?se=abc&utm_medium=api';
const ADZ_FULL = 'https://www.adzuna.co.uk/jobs/land/ad/111?se=abc';
const REED = 'https://www.reed.co.uk/jobs/ai-engineer/57364884';
const TSV_TEASERS = TSV
  + `${ADZ}\t2026-09-22\tadzuna-api\tSenior AI Engineer\tA&O Shearman\tadded\tBelfast\t\t2026-09-22\t\t\ta o shearman\n`
  + `${ADZ_FULL}\t2026-09-22\tadzuna-api\tAI Engineer\tAcme\tadded\tLeeds\t\t2026-09-22\t\t\tacme\n`
  + `${REED}\t2026-09-22\treed-api\tAI Engineer\tNorton Rose Fulbright\tadded\tLondon\t\t2026-09-22\t\t\tnorton rose fulbright\n`;
const onlyAi = (title) => /AI|ML/.test(title);

test('selectMissing: added rows, passing the title filter, on an API-covered ATS, not yet stored', () => {
  const store = new Map([['https://job-boards.greenhouse.io/anthropic/jobs/1', 'have it']]);
  const { todo, uncovered } = selectMissing(TSV, store, { titleFilter: onlyAi });
  assert.deepEqual(todo.map(r => r.url.split('/').pop()).sort(), ['3', 'ML-Engineer_R42']);
  assert.deepEqual(uncovered.map(r => r.company), ['Microsoft']);
  assert.equal(selectMissing(TSV, store, { titleFilter: onlyAi, limit: 1 }).todo.length, 1);
});

test('selectMissing: Adzuna/Reed rows with only a teaser stored are selected (teaser as `current`); a full one is not; sources filter', () => {
  assert.deepEqual(TEASER_PORTALS, { 'adzuna-api': 'adzuna', 'reed-api': 'reed' });
  // keys normalized like readDescriptions(file, normalizeUrlForDedup) does — Adzuna links carry tracking params
  const store = new Map([
    ['https://job-boards.greenhouse.io/anthropic/jobs/1', 'have it'],
    ['https://jobs.ashbyhq.com/openai/3', 'have it'],
    ['https://darktrace.wd3.myworkdayjobs.com/en-US/darktrace/job/London/ML-Engineer_R42', 'have it'],
    [ADZ, TEASER],                                // teaser → upgrade
    [ADZ_FULL, 'x'.repeat(TEASER_MAX_CHARS + 1)], // already full → leave alone
    // REED not stored at all → also selected (kind reed, current '')
  ].map(([url, text]) => [normalizeUrlForDedup(url), text]));
  const { todo, uncovered } = selectMissing(TSV_TEASERS, store, { titleFilter: onlyAi });
  assert.deepEqual(todo.map(r => [r.ats, r.company, r.current.length]), [['adzuna', 'A&O Shearman', TEASER.length], ['reed', 'Norton Rose Fulbright', 0]]);
  assert.deepEqual(uncovered.map(r => r.company), ['Microsoft']);
  assert.deepEqual(selectMissing(TSV_TEASERS, store, { titleFilter: onlyAi, sources: ['reed'] }).todo.map(r => r.ats), ['reed']);
  assert.deepEqual(selectMissing(TSV_TEASERS, store, { titleFilter: onlyAi, sources: ['greenhouse'] }).todo, []);
});

test('runBackfill: a teaser row is rewritten only when the fetched text is clearly longer; source records the route', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'backfill-'));
  const file = path.join(dir, 'job-descriptions.jsonl');
  const FULL = TEASER + ' What you will have: ' + 'machine learning, Python, PyTorch, Azure. '.repeat(40);
  const { appendDescriptions } = await import('../job-descriptions.mjs');
  await appendDescriptions(file, [
    { url: ADZ, description: TEASER, source: 'adzuna-api' },
    { url: ADZ_FULL, description: 'x'.repeat(TEASER_MAX_CHARS + 1), source: 'adzuna-api' }, // already full → never fetched
    { url: REED, description: TEASER, source: 'reed-api' },
  ]);
  const seen = [];
  const fetchJd = async (url, cap, ms, opts) => {
    seen.push(opts.current.length);
    if (url.includes('adzuna')) return { url, text: FULL, via: 'source-page' };
    return { url, text: TEASER + ' a bit more', via: 'reed-detail-api' }; // not an upgrade
  };
  const r = await runBackfill({ historyText: TSV_TEASERS, file, fetchJd, titleFilter: onlyAi, sources: ['adzuna', 'reed'], throttleMs: 0 });
  assert.deepEqual(seen, [TEASER.trim().length, TEASER.trim().length]);
  assert.equal(r.filled, 1);
  assert.equal(r.missed.length, 1);
  assert.match(r.missed[0].url, /reed\.co\.uk/);
  assert.deepEqual(r.byAts, { adzuna: { filled: 1, missed: 0 }, reed: { filled: 0, missed: 1 } });
  const store = readDescriptions(file, normalizeUrlForDedup);
  assert.equal(store.get(normalizeUrlForDedup(ADZ)), normalizeDescription(FULL));
  assert.equal(store.get(normalizeUrlForDedup(REED)), TEASER.trim(), 'the teaser stays until something longer is found');
  const last = JSON.parse(readFileSync(file, 'utf8').trim().split('\n').pop());
  assert.equal(last.source, 'source-page');
  // the upgraded row is no longer selected; the reed teaser still is
  assert.deepEqual(selectMissing(TSV_TEASERS, store, { titleFilter: onlyAi, sources: ['adzuna', 'reed'] }).todo.map(r => r.ats), ['reed']);
});

test('runBackfill: writes what the API returns, reports misses, dry-run touches nothing', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'backfill-'));
  const file = path.join(dir, 'job-descriptions.jsonl');
  // Greenhouse and Ashby answer; Workday does not (e.g. the posting closed).
  const fetchJd = async (url) => (/ashbyhq|greenhouse/.test(url) ? { url, title: 'ML Engineer', text: LONG, ats: 'x' } : null);

  const dry = await runBackfill({ historyText: TSV, file, fetchJd, titleFilter: onlyAi, dryRun: true, throttleMs: 0 });
  assert.equal(dry.todo, 3); // anthropic (greenhouse), openai/3 (ashby), darktrace (workday)
  assert.ok(!existsSync(file));

  const r = await runBackfill({ historyText: TSV, file, fetchJd, titleFilter: onlyAi, throttleMs: 0 });
  assert.equal(r.filled, 2);
  assert.equal(r.missed.length, 1);
  assert.match(r.missed[0].url, /myworkdayjobs/);
  assert.equal(r.uncovered.length, 1);
  assert.deepEqual([...readDescriptions(file).keys()].sort(), ['https://job-boards.greenhouse.io/anthropic/jobs/1', 'https://jobs.ashbyhq.com/openai/3']);
  assert.ok(readFileSync(file, 'utf8').trim().split('\n').every(l => JSON.parse(l).source === 'api'));

  // second run: nothing left for the API to do
  const again = await runBackfill({ historyText: TSV, file, fetchJd, titleFilter: onlyAi, throttleMs: 0 });
  assert.equal(again.todo, 1); // the workday miss is retried
  assert.equal(again.filled, 0);
});

// ── Round 7 (Jim, 2026-09-23): --browser hands the browser tier to the fetcher ──
test('runBackfill: browser:true is passed to the fetcher (default false); closeBrowser is called once', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'backfill-'));
  const file = path.join(dir, 'job-descriptions.jsonl');
  const seen = [];
  const fetchJd = async (url, cap, ms, opts) => { seen.push(opts.browser); return null; };
  let closed = 0;
  await runBackfill({ historyText: TSV_TEASERS, file, fetchJd, titleFilter: onlyAi, sources: ['adzuna'], throttleMs: 0, browser: true, closeBrowser: async () => { closed++; } });
  assert.deepEqual(seen, [true, true]);
  assert.equal(closed, 1);
  seen.length = 0;
  await runBackfill({ historyText: TSV_TEASERS, file, fetchJd, titleFilter: onlyAi, sources: ['adzuna'], throttleMs: 0, closeBrowser: async () => {} });
  assert.deepEqual(seen, [false, false]);
});

// ── 2026-09-23: Google postings are a backfill source too (posting page ds:0 block) ──
test('selectMissing: a google-api row with nothing stored is todo with ats "google" (not uncovered); --source google selects it', () => {
  const G = 'https://www.google.com/about/careers/applications/jobs/results/105831148344484550-ai-architect-partner-engineering';
  const tsv = TSV + `${G}\t2026-09-21\tgoogle-api\tAI Architect, Partner Engineering\tGoogle\tadded\tLondon, UK\t\t2026-09-21\t\t\tgoogle\n`;
  const { todo, uncovered } = selectMissing(tsv, new Map(), { titleFilter: onlyAi });
  assert.ok(todo.some(r => r.url === G && r.ats === 'google'), 'google row should be fetchable');
  assert.deepEqual(uncovered.map(r => r.company), ['Microsoft'], 'Microsoft stays the only uncovered source');
  const only = selectMissing(tsv, new Map(), { titleFilter: onlyAi, sources: ['google'] }).todo;
  assert.deepEqual(only.map(r => r.ats), ['google']);
});
