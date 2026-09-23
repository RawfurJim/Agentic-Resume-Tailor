// job-descriptions.mjs: the append-only store that keeps each job's description
// text (data/job-descriptions.jsonl) so the exports can carry a Description
// column. Round 3 (Jim, 2026-09-22).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const {
  normalizeDescription, isRealDescription, readDescriptions, appendDescriptions, enrichDescriptions, shouldStoreDescription,
  MAX_DESCRIPTION_CHARS, MIN_DESCRIPTION_CHARS,
} = await import('../job-descriptions.mjs');

const LONG = 'We are hiring an AI Engineer to build LLM agents. '.repeat(10); // ~500 chars
const key = (u) => u.replace(/\/+$/, '').toLowerCase();

test('normalizeDescription: trims, collapses blank runs and spaces, caps length', () => {
  assert.equal(normalizeDescription('  a   b \n\n\n\n c  '), 'a b\n\nc');
  assert.equal(normalizeDescription(null), '');
  assert.equal(normalizeDescription('x'.repeat(MAX_DESCRIPTION_CHARS + 500)).length, MAX_DESCRIPTION_CHARS);
});

test('normalizeDescription: strips the ATS-API metadata header (Location/Job type/Posted/Req ID)', () => {
  const api = 'Location: London | Dublin\nJob type: Full time\nPosted: Posted 3 Days Ago\nReq ID: R123\n\nAbout the role\nYou will build models.';
  assert.equal(normalizeDescription(api), 'About the role\nYou will build models.');
  const gh = 'Location: London\nReq ID: 42\n\nBody text';
  assert.equal(normalizeDescription(gh), 'Body text');
  // a body that happens to start with "Location" in prose is left alone
  assert.equal(normalizeDescription('Location matters to us.\nWe hire in London.'), 'Location matters to us.\nWe hire in London.');
});

test('isRealDescription: rejects empties and short synthetic strings', () => {
  assert.equal(isRealDescription(''), false);
  assert.equal(isRealDescription(undefined), false);
  assert.equal(isRealDescription('Engineering · hybrid'), false);     // Microsoft's synthetic description
  assert.equal(isRealDescription('x'.repeat(MIN_DESCRIPTION_CHARS - 1)), false);
  assert.equal(isRealDescription(LONG), true);
});

test('readDescriptions: missing file → empty Map; bad lines skipped; last entry per key wins', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'jd-'));
  const file = path.join(dir, 'job-descriptions.jsonl');
  assert.equal(readDescriptions(file, key).size, 0);
  writeFileSync(file, [
    JSON.stringify({ url: 'https://a/1', text: 'first', source: 'ashby-api', fetched_at: '2026-09-21' }),
    'not json at all',
    JSON.stringify({ url: 'https://a/1/', text: 'second', source: 'api', fetched_at: '2026-09-22' }),
    JSON.stringify({ url: 'https://a/2', text: 'other' }),
    JSON.stringify({ nope: true }),
    '',
  ].join('\n'));
  const m = readDescriptions(file, key);
  assert.equal(m.size, 2);
  assert.equal(m.get('https://a/1'), 'second');
  assert.equal(m.get('https://a/2'), 'other');
});

test('appendDescriptions + readDescriptions round-trip; skips entries without a real description', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'jd-'));
  const file = path.join(dir, 'nested', 'job-descriptions.jsonl');
  const n = await appendDescriptions(file, [
    { url: 'https://a/1', description: LONG, source: 'ashby-api' },
    { url: 'https://a/2', description: 'too short', source: 'ashby-api' },
    { url: '', description: LONG },
  ], { today: '2026-09-22' });
  assert.equal(n, 1);
  assert.ok(existsSync(file));
  const lines = readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]);
  assert.deepEqual(Object.keys(entry).sort(), ['fetched_at', 'source', 'text', 'url']);
  assert.equal(entry.fetched_at, '2026-09-22');
  assert.equal(readDescriptions(file, key).get('https://a/1'), normalizeDescription(LONG));
  assert.equal(await appendDescriptions(file, []), 0);
});

test('enrichDescriptions: fills only the offers lacking a real description, via the injected fetcher', async () => {
  const calls = [];
  const fetchJd = async (url) => {
    calls.push(url);
    if (url.includes('workday')) return { url, title: 'ML Engineer', text: 'Location: London\n\n' + LONG, ats: 'workday' };
    return null;
  };
  const offers = [
    { url: 'https://x.wd3.myworkdayjobs.com/en-US/x/job/ML-Engineer_R1', description: '' },
    { url: 'https://apply.careers.microsoft.com/careers/job/1', description: 'AI · hybrid' },
    { url: 'https://jobs.ashbyhq.com/acme/3', description: LONG },
  ];
  const result = await enrichDescriptions(offers, { fetchJd, pauseMs: 0 });
  assert.deepEqual(calls, [offers[0].url, offers[1].url]); // the real one is never re-fetched
  assert.equal(result.filled, 1);
  assert.equal(result.missing, 1);
  assert.equal(result.stillTruncated, 0);
  assert.deepEqual(result.byVia, { api: 1 }, 'a fetcher result without `via` counts as the ATS API');
  assert.equal(offers[0].description, normalizeDescription(LONG));
  assert.equal(offers[0].descriptionSource, 'api');
  assert.equal(offers[1].description, 'AI · hybrid'); // untouched when the API has nothing
  assert.equal(offers[2].descriptionSource, undefined);
});

test('enrichDescriptions: a teaser (descriptionTruncated) is fetched even though it is ≥ 200 chars; replaced only by clearly longer text', async () => {
  const TEASER = 'We have an exciting opportunity for a Senior AI Engineer to join our IT team based in Belfast. '.repeat(5); // ~480 chars, like Adzuna
  const FULL = TEASER + ' What you will have: ' + 'machine learning, Python, PyTorch, Azure. '.repeat(40);
  const calls = [];
  const fetchJd = async (url, cap, ms, opts) => {
    calls.push({ url, current: opts?.current });
    if (url.includes('adzuna')) return { url, text: FULL, via: 'adzuna-details' };
    if (url.includes('reed')) return { url, text: TEASER + ' extra', via: 'reed-page' }; // not 10% longer → not an upgrade
    return null;
  };
  const offers = [
    { url: 'https://www.adzuna.co.uk/jobs/land/ad/1?se=x', description: TEASER, descriptionTruncated: true },
    { url: 'https://www.reed.co.uk/jobs/ai-engineer/2', description: TEASER, descriptionTruncated: true },
    { url: 'https://www.reed.co.uk/jobs/ml-engineer/3', description: TEASER, descriptionTruncated: true },
    { url: 'https://jobs.ashbyhq.com/acme/4', description: LONG },
  ];
  const r = await enrichDescriptions(offers, { fetchJd, pauseMs: 0 });
  assert.deepEqual(calls.map(c => c.url.split('/').pop().split('?')[0]), ['1', '2', '3']);
  assert.equal(calls[0].current, normalizeDescription(TEASER), 'the teaser is passed so the fetcher can judge "better"');
  assert.equal(r.filled, 1);
  assert.equal(r.stillTruncated, 2);
  assert.equal(r.missing, 0);
  assert.deepEqual(r.byVia, { 'adzuna-details': 1 });
  assert.equal(offers[0].description, normalizeDescription(FULL));
  assert.equal(offers[0].descriptionSource, 'adzuna-details');
  assert.equal(offers[0].descriptionTruncated, undefined, 'flag cleared once the full text is in');
  assert.equal(offers[1].description, TEASER, 'teaser kept when nothing clearly longer came back');
  assert.equal(offers[1].descriptionTruncated, true);
  assert.equal(offers[2].description, TEASER);
});

test('enrichDescriptions: a throwing fetcher is treated as a miss, not a crash', async () => {
  const offers = [{ url: 'https://jobs.lever.co/acme/1', description: '' }];
  const result = await enrichDescriptions(offers, { fetchJd: async () => { throw new Error('boom'); }, pauseMs: 0 });
  assert.equal(result.filled, 0);
  assert.equal(result.missing, 1);
  assert.equal(offers[0].description, '');
});

test('shouldStoreDescription: store when nothing stored, or when the new text is clearly longer (cap raised)', () => {
  assert.equal(shouldStoreDescription(undefined, LONG), true);
  assert.equal(shouldStoreDescription(undefined, 'short'), false);
  assert.equal(shouldStoreDescription(LONG.length, LONG), false);            // same text again → no rewrite
  assert.equal(shouldStoreDescription(4000, 'x'.repeat(4400)), false);       // within 10% → noise, skip
  assert.equal(shouldStoreDescription(4000, 'x'.repeat(9000)), true);        // the full posting arrived → refresh
});

// ── Round 7 (Jim, 2026-09-23): the browser tier is budgeted per run ──
test('enrichDescriptions: passes browser:true to the fetcher until browserCap is spent, counts browser fills and cap hits, closes the browser once', async () => {
  const TEASER = 'hackajob is partnering directly with JPMorganChase to hire for this role. Help shape how AI systems run reliably. '.repeat(4);
  const FULL = TEASER + ' What you will do: ' + 'Build, observe and harden LLM serving platforms on Kubernetes. '.repeat(30);
  const calls = [];
  const fetchJd = async (url, cap, ms, opts) => {
    calls.push({ url, browser: opts.browser });
    if (url.includes('/land/ad/') && opts.browser) return { url, text: FULL, via: 'browser' };
    return null; // details page only had the snippet
  };
  const land = (id) => ({ url: `https://www.adzuna.co.uk/jobs/land/ad/${id}?se=x`, description: TEASER, descriptionTruncated: true });
  const offers = [land(1), land(2), land(3), { url: 'https://www.reed.co.uk/jobs/ai-engineer/9', description: TEASER, descriptionTruncated: true }];
  let closed = 0;
  const r = await enrichDescriptions(offers, { fetchJd, pauseMs: 0, browserCap: 1, closeBrowser: async () => { closed++; } });
  assert.deepEqual(calls.map(c => c.browser), [true, false, false, false], 'one browser budget, then plain routes only');
  assert.equal(r.filled, 1);
  assert.equal(r.byVia.browser, 1);
  assert.equal(r.browserUsed, 1);
  assert.equal(r.browserCapHit, 2, 'two Adzuna land links stayed teasers because the cap was spent (the Reed one is not counted)');
  assert.equal(r.stillTruncated, 3);
  assert.equal(offers[0].descriptionSource, 'browser');
  assert.equal(offers[1].description, TEASER);
  assert.equal(closed, 1, 'closeBrowser called once at the end of the run');
});

test('enrichDescriptions: browser:false never asks for the browser and reports no cap hits; default cap is 40', async () => {
  const { DEFAULT_BROWSER_CAP } = await import('../job-descriptions.mjs');
  assert.equal(DEFAULT_BROWSER_CAP, 40);
  const seen = [];
  const offers = [{ url: 'https://www.adzuna.co.uk/jobs/land/ad/1?se=x', description: 'x'.repeat(400), descriptionTruncated: true }];
  const r = await enrichDescriptions(offers, { fetchJd: async (u, c, m, o) => { seen.push(o.browser); return null; }, pauseMs: 0, browser: false, closeBrowser: async () => {} });
  assert.deepEqual(seen, [false]);
  assert.equal(r.browserCapHit, 0);
  assert.equal(r.browserUsed, 0);
});
