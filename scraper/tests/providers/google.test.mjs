// Tests for providers/google.mjs — written BEFORE the provider (plan Phase 0).
// Run: npm test  (node --test tests/)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = readFileSync(path.join(here, '..', 'fixtures', 'google-careers-page.html'), 'utf8');
const RESULTS_BASE = 'https://www.google.com/about/careers/applications/jobs/results/';
const USER_URL = `${RESULTS_BASE}?q=AI%20Engineer&hl=en&location=London%2C%20UK&location=Dublin%2C%20Ireland&location=United%20Kingdom`;

const mod = await import('../../providers/google.mjs');
const provider = mod.default;
const {
  assertGoogleCareersUrl,
  buildPageUrl,
  extractInitData,
  rowToJob,
  parseGoogleCareersPage,
  DEFAULT_MAX_PAGES,
  MAX_PAGES_CAP,
  PAGE_SIZE,
} = mod;

// A fake ctx that records every request and serves canned pages by page number.
function fakeCtx(pages, { maxPages } = {}) {
  const calls = [];
  const ctx = {
    calls,
    sleep: async () => {},
    async fetchText(url, opts) {
      calls.push({ url, opts });
      const page = Number(new URL(url).searchParams.get('page') || 1);
      const body = pages[page - 1];
      if (body instanceof Error) throw body;
      if (body === undefined) return pageWithRows([]);
      return body;
    },
  };
  if (maxPages) ctx.maxPages = maxPages;
  return ctx;
}

// Build a synthetic results page with N rows (ids 1..N offset) in the ds:1 shape.
function pageWithRows(rows, { total = 72 } = {}) {
  const cards = rows.map(r => `<a class="WpHeLc" href="jobs/results/${r[0]}-x"><h3 class="QJPWVe">${r[1]}</h3></a>`).join('\n');
  const data = [rows, null, total, PAGE_SIZE];
  return `<html><body>${cards}<script>AF_initDataCallback({key: 'ds:1', hash: '2', data:${JSON.stringify(data)}, sideChannel: {}});</script></body></html>`;
}
function fakeRow(id, title = `Job ${id}`, { company = 'Google', locs = ['London, UK'], ts = 1788527311 } = {}) {
  const r = new Array(21).fill(null);
  r[0] = String(id); r[1] = title; r[2] = 'https://www.google.com/about/careers/applications/signin?jobId=x';
  r[3] = [null, '<ul><li>Do things</li></ul>']; r[4] = [null, '<h3>Minimum qualifications:</h3><ul><li>Bachelor degree</li></ul>'];
  r[7] = company; r[9] = locs.map(l => [l, [l], l.split(',')[0], '', '', 'GB']);
  r[12] = [ts, 0]; r[19] = [null, '<ul><li>Preferred: LLMs</li></ul>'];
  return r;
}

// 1
test('id is google', () => { assert.equal(provider.id, 'google'); });

// 2-4 detect
test('detect() accepts the Google careers results URL', () => {
  assert.deepEqual(provider.detect({ careers_url: USER_URL }), { url: USER_URL });
});
test('detect() honours provider: google explicitly', () => {
  assert.deepEqual(provider.detect({ provider: 'google', careers_url: USER_URL }), { url: USER_URL });
});
test('detect() rejects http, other hosts, other paths, malformed, missing', () => {
  assert.equal(provider.detect({ careers_url: USER_URL.replace('https://', 'http://') }), null);
  assert.equal(provider.detect({ careers_url: 'https://careers.google.com/jobs/results/?q=AI' }), null);
  assert.equal(provider.detect({ careers_url: 'https://www.google.com/search?q=AI+Engineer' }), null);
  assert.equal(provider.detect({ careers_url: 'not a url' }), null);
  assert.equal(provider.detect({}), null);
  assert.equal(provider.detect({ provider: 'greenhouse', careers_url: USER_URL }), null);
});
test('assertGoogleCareersUrl throws on untrusted input', () => {
  assert.throws(() => assertGoogleCareersUrl('https://evil.example/about/careers/applications/jobs/results/'));
  assert.throws(() => assertGoogleCareersUrl('https://www.google.com/about/careers/jobs/results/?q=AI'));
  assert.throws(() => assertGoogleCareersUrl('http://www.google.com/about/careers/applications/jobs/results/'));
  assert.equal(assertGoogleCareersUrl(USER_URL), USER_URL);
});

// 5 extractInitData
test('extractInitData returns rows/total/pageSize from the fixture', () => {
  const init = extractInitData(FIXTURE);
  assert.ok(init);
  assert.equal(init.rows.length, 3);
  assert.equal(init.total, 3);
  assert.equal(init.pageSize, 20);
  assert.equal(init.rows[0][0], '72888471085032134');
});
test('extractInitData returns null when there is no ds:1 blob', () => {
  assert.equal(extractInitData('<html><body>nothing</body></html>'), null);
});

// 6-10 rowToJob
test('rowToJob: plain Google row → canonical results URL, company Google, plain title', () => {
  const { rows } = extractInitData(FIXTURE);
  const job = rowToJob(rows[0], new Map([['72888471085032134', 'firmware-engineer-modemtelephony-protocol-and-ai-automation']]), 'Google');
  assert.equal(job.url, `${RESULTS_BASE}72888471085032134-firmware-engineer-modemtelephony-protocol-and-ai-automation`);
  assert.ok(!job.url.includes('signin'));
  assert.equal(job.company, 'Google');
  assert.equal(job.title, 'Firmware Engineer, Modem/Telephony Protocol and AI Automation');
  assert.equal(job.location, 'London, UK');
});
test('rowToJob: DeepMind row → company DeepMind from row[7]', () => {
  const { rows } = extractInitData(FIXTURE);
  const job = rowToJob(rows[1], new Map(), 'Google');
  assert.equal(job.company, 'DeepMind');
  assert.equal(job.title, 'Research Engineer, World Models, DeepMind');
});
test('rowToJob: multi-location row joins with " · "', () => {
  const { rows } = extractInitData(FIXTURE);
  const job = rowToJob(rows[2], new Map(), 'Google');
  assert.equal(job.location, 'London, UK · Madrid, Spain');
});
test('rowToJob: slug falls back to a slugified title when no anchor is known', () => {
  const { rows } = extractInitData(FIXTURE);
  const job = rowToJob(rows[2], new Map(), 'Google');
  assert.equal(job.url, `${RESULTS_BASE}133517804614623942-applied-ai-engineer`);
});
test('rowToJob: description is plain text containing the minimum qualifications', () => {
  const { rows } = extractInitData(FIXTURE);
  const job = rowToJob(rows[2], new Map(), 'Google');
  assert.equal(typeof job.description, 'string');
  assert.ok(job.description.length > 50);
  assert.ok(!/<li>|<ul>|<h3>/.test(job.description), 'no HTML tags left');
  assert.match(job.description, /Minimum qualifications/i);
});
test('rowToJob: postedAt from row[12] seconds; garbage → undefined', () => {
  const { rows } = extractInitData(FIXTURE);
  const job = rowToJob(rows[1], new Map(), 'Google');
  assert.equal(job.postedAt, 1788527311 * 1000);
  const bad = fakeRow('5'); bad[12] = ['nope'];
  assert.equal(rowToJob(bad, new Map(), 'Google').postedAt, undefined);
  const missing = fakeRow('6'); missing[12] = undefined;
  assert.equal(rowToJob(missing, new Map(), 'Google').postedAt, undefined);
});

// 11-14 parseGoogleCareersPage
test('parseGoogleCareersPage: fixture → 3 jobs', () => {
  const jobs = parseGoogleCareersPage(FIXTURE);
  assert.equal(jobs.length, 3);
  assert.deepEqual(jobs.map(j => j.company), ['Google', 'DeepMind', 'Google']);
});
test('parseGoogleCareersPage: cards present but blob rows unparseable → throws', () => {
  const html = `<html><body><h3 class="QJPWVe">Some job</h3><h3 class="QJPWVe">Other</h3>
<script>AF_initDataCallback({key: 'ds:1', hash: '2', data:[[[null,null],[42]],null,2,20], sideChannel: {}});</script></body></html>`;
  assert.throws(() => parseGoogleCareersPage(html), /layout|parsed to none|job cards/i);
});
test('parseGoogleCareersPage: blob missing, anchors present → fallback jobs', () => {
  const html = `<html><body><a class="WpHeLc" href="jobs/results/123-ai-engineer?q=x"><h3 class="QJPWVe">AI Engineer</h3></a></body></html>`;
  const jobs = parseGoogleCareersPage(html);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].title, 'AI Engineer');
  assert.equal(jobs[0].url, `${RESULTS_BASE}123-ai-engineer`);
  assert.equal(jobs[0].company, 'Google');
  assert.equal(jobs[0].location, '');
});
test('parseGoogleCareersPage: no blob, no cards, no marker → throws (challenge/redesign)', () => {
  assert.throws(() => parseGoogleCareersPage('<html><body><h1>Before you continue</h1></body></html>'));
});
test('parseGoogleCareersPage: blob with zero rows → []', () => {
  assert.deepEqual(parseGoogleCareersPage(pageWithRows([], { total: 0 })), []);
});

// 15 buildPageUrl
test('buildPageUrl keeps query params; page 1 has no page=; page 3 sets page=3', () => {
  const p1 = new URL(buildPageUrl(USER_URL, 1));
  assert.equal(p1.searchParams.get('page'), null);
  assert.equal(p1.searchParams.get('q'), 'AI Engineer');
  assert.deepEqual(p1.searchParams.getAll('location'), ['London, UK', 'Dublin, Ireland', 'United Kingdom']);
  const p3 = new URL(buildPageUrl(USER_URL, 3));
  assert.equal(p3.searchParams.get('page'), '3');
  assert.equal(p3.searchParams.get('hl'), 'en');
});

// 16-22 fetch()
test('fetch: every request uses redirect:error and a browser-like user-agent', async () => {
  const ctx = fakeCtx([pageWithRows([fakeRow(1)], { total: 1 })]);
  await provider.fetch({ name: 'Google', careers_url: USER_URL }, ctx);
  assert.ok(ctx.calls.length >= 1);
  for (const c of ctx.calls) {
    assert.equal(c.opts.redirect, 'error');
    const ua = c.opts.headers?.['user-agent'] ?? c.opts.headers?.['User-Agent'];
    assert.match(ua, /Mozilla\/5\.0/);
  }
});
test('fetch: non-Google careers_url throws before any request', async () => {
  const ctx = fakeCtx([pageWithRows([fakeRow(1)])]);
  await assert.rejects(provider.fetch({ name: 'X', careers_url: 'https://jobs.lever.co/acme' }, ctx));
  assert.equal(ctx.calls.length, 0);
});
test('fetch: ctx.maxPages=1 (health probe) makes exactly one request', async () => {
  const full = Array.from({ length: PAGE_SIZE }, (_, i) => fakeRow(100 + i));
  const ctx = fakeCtx([pageWithRows(full, { total: 500 }), pageWithRows(full.map(r => fakeRow(Number(r[0]) + 50)), { total: 500 })], { maxPages: 1 });
  const jobs = await provider.fetch({ name: 'Google', careers_url: USER_URL }, ctx);
  assert.equal(ctx.calls.length, 1);
  assert.equal(jobs.length, PAGE_SIZE);
});
test('fetch: max_pages clamps to the cap; 0/garbage falls back to the default', async () => {
  assert.equal(DEFAULT_MAX_PAGES, 5);
  assert.equal(MAX_PAGES_CAP, 20);
  const pages = Array.from({ length: 30 }, (_, p) => pageWithRows(Array.from({ length: PAGE_SIZE }, (_, i) => fakeRow(p * 1000 + i)), { total: 100000 }));
  const ctx = fakeCtx(pages);
  await provider.fetch({ name: 'Google', careers_url: USER_URL, max_pages: 99 }, ctx);
  assert.equal(ctx.calls.length, MAX_PAGES_CAP);
  const ctx2 = fakeCtx(pages);
  await provider.fetch({ name: 'Google', careers_url: USER_URL, max_pages: 0 }, ctx2);
  assert.equal(ctx2.calls.length, DEFAULT_MAX_PAGES);
});
test('fetch: a short page (< PAGE_SIZE rows) ends pagination', async () => {
  const full = Array.from({ length: PAGE_SIZE }, (_, i) => fakeRow(i));
  const ctx = fakeCtx([pageWithRows(full, { total: 25 }), pageWithRows([fakeRow(900), fakeRow(901)], { total: 25 }), pageWithRows(full)]);
  const jobs = await provider.fetch({ name: 'Google', careers_url: USER_URL }, ctx);
  assert.equal(ctx.calls.length, 2);
  assert.equal(jobs.length, PAGE_SIZE + 2);
});
test('fetch: stops once page*PAGE_SIZE >= total', async () => {
  const full = Array.from({ length: PAGE_SIZE }, (_, i) => fakeRow(i));
  const ctx = fakeCtx([pageWithRows(full, { total: 20 }), pageWithRows(full.map(r => fakeRow(Number(r[0]) + 100)), { total: 20 })]);
  await provider.fetch({ name: 'Google', careers_url: USER_URL }, ctx);
  assert.equal(ctx.calls.length, 1);
});
test('fetch: page 2 failure keeps page 1 (no probe) but rethrows under a probe', async () => {
  const full = Array.from({ length: PAGE_SIZE }, (_, i) => fakeRow(i));
  const boom = new Error('HTTP 429');
  const ctx = fakeCtx([pageWithRows(full, { total: 60 }), boom]);
  const jobs = await provider.fetch({ name: 'Google', careers_url: USER_URL }, ctx);
  assert.equal(jobs.length, PAGE_SIZE);
  const probe = fakeCtx([boom], { maxPages: 1 });
  await assert.rejects(provider.fetch({ name: 'Google', careers_url: USER_URL }, probe), /429/);
});
test('fetch: duplicate ids across pages are returned once', async () => {
  const full = Array.from({ length: PAGE_SIZE }, (_, i) => fakeRow(i));
  const ctx = fakeCtx([pageWithRows(full, { total: 40 }), pageWithRows(full, { total: 40 }), pageWithRows(full, { total: 40 })]);
  const jobs = await provider.fetch({ name: 'Google', careers_url: USER_URL }, ctx);
  assert.equal(new Set(jobs.map(j => j.url)).size, jobs.length);
  assert.equal(jobs.length, PAGE_SIZE);
  assert.ok(ctx.calls.length <= 2, 'an all-seen page stops pagination');
});

// ── 2026-09-23: one posting's page (ds:0 block) → job, for full-description.mjs ──
test('extractJobDetail: live posting page → job with title + description; removed posting (ErrorDetails) → null; junk → null', async () => {
  const { readFileSync } = await import('node:fs');
  const { extractJobDetail } = await import('../../providers/google.mjs');
  const fx = (n) => readFileSync(new URL(`../fixtures/${n}`, import.meta.url), 'utf8');
  const job = extractJobDetail(fx('google-job-detail.html'));
  assert.ok(job);
  assert.equal(job.title, 'Research Engineer, Responsible Frontier AI Research, DeepMind');
  assert.match(job.url, /jobs\/results\/116637011183313606/);
  assert.match(job.description, /Minimum qualifications/);
  assert.ok(job.description.length > 1000);
  assert.equal(extractJobDetail(fx('google-job-removed.html')), null);
  assert.equal(extractJobDetail('<html></html>'), null);
  assert.equal(extractJobDetail(null), null);
});
