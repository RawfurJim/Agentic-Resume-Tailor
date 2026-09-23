// Tests for providers/microsoft.mjs — written BEFORE the provider (plan Phase A3).
// Microsoft Careers = Eightfold "PCS" tenant at apply.careers.microsoft.com;
// its /api/pcsx/search endpoint answers JSON without cookies, 10 rows per page.
// Run: npm test  (node --test tests/)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(readFileSync(path.join(here, '..', 'fixtures', 'microsoft-pcsx-page.json'), 'utf8'));
const HOST = 'https://apply.careers.microsoft.com';
const USER_URL = `${HOST}/careers?query=AI%20Engineer&location=United%20Kingdom&pid=1970393556998409&domain=microsoft.com&sort_by=relevance`;

const mod = await import('../../providers/microsoft.mjs');
const provider = mod.default;
const {
  assertMicrosoftUrl,
  buildSearchUrl,
  positionToJob,
  TRUSTED_HOST,
  API_PATH,
  PAGE_SIZE,
  DEFAULT_MAX_PAGES,
  MAX_PAGES_CAP,
} = mod;

// A fake ctx that records every request and serves canned pages keyed by `start`.
function fakeCtx(pagesByStart, { maxPages } = {}) {
  const calls = [];
  const ctx = {
    calls,
    sleep: async () => {},
    async fetchJson(url, opts) {
      calls.push({ url, opts });
      const start = Number(new URL(url).searchParams.get('start') || 0);
      const body = pagesByStart[start];
      if (body instanceof Error) throw body;
      if (body === undefined) return pageWith([], { count: 0 });
      return body;
    },
  };
  if (maxPages) ctx.maxPages = maxPages;
  return ctx;
}

function fakePosition(id, name = `Job ${id}`, extra = {}) {
  return {
    id,
    displayJobId: `2000${id}`,
    name,
    locations: ['United Kingdom, London, London'],
    standardizedLocations: ['London, England, GB'],
    postedTs: 1789471817,
    creationTs: 1787582169,
    department: 'Software Engineering',
    workLocationOption: 'hybrid',
    positionUrl: `/careers/job/${id}`,
    ...extra,
  };
}
function pageWith(positions, { count = positions.length } = {}) {
  return { status: 200, error: { message: '', body: '' }, data: { positions, count } };
}
function fullPage(offset, count) {
  return pageWith(Array.from({ length: PAGE_SIZE }, (_, i) => fakePosition(offset + i)), { count });
}

// 1
test('id is microsoft', () => { assert.equal(provider.id, 'microsoft'); });
test('constants: page size 10 (server cap), defaults 10 / cap 50', () => {
  assert.equal(TRUSTED_HOST, 'apply.careers.microsoft.com');
  assert.equal(API_PATH, '/api/pcsx/search');
  assert.equal(PAGE_SIZE, 10);
  assert.equal(DEFAULT_MAX_PAGES, 10);
  assert.equal(MAX_PAGES_CAP, 50);
});

// 2 detect
test('detect() accepts the Microsoft careers search URL', () => {
  assert.deepEqual(provider.detect({ careers_url: USER_URL }), { url: USER_URL });
});
test('detect() honours provider: microsoft explicitly', () => {
  assert.deepEqual(provider.detect({ provider: 'microsoft', careers_url: USER_URL }), { url: USER_URL });
});
test('detect() rejects http, other hosts, other paths, malformed, missing, other provider', () => {
  assert.equal(provider.detect({ careers_url: USER_URL.replace('https://', 'http://') }), null);
  assert.equal(provider.detect({ careers_url: 'https://careers.microsoft.com/v2/global/en/search?q=AI' }), null);
  assert.equal(provider.detect({ careers_url: 'https://microsoft.eightfold.ai/careers?query=AI' }), null);
  assert.equal(provider.detect({ careers_url: `${HOST}/about-us` }), null);
  assert.equal(provider.detect({ careers_url: 'not a url' }), null);
  assert.equal(provider.detect({}), null);
  assert.equal(provider.detect(null), null);
  assert.equal(provider.detect({ provider: 'eightfold', careers_url: USER_URL }), null);
});
test('assertMicrosoftUrl throws on untrusted input, returns trusted input', () => {
  assert.throws(() => assertMicrosoftUrl('https://evil.example/careers?query=AI'));
  assert.throws(() => assertMicrosoftUrl('https://apply.careers.microsoft.com.evil.example/careers'));
  assert.throws(() => assertMicrosoftUrl(`http://${TRUSTED_HOST}/careers`));
  assert.throws(() => assertMicrosoftUrl(`${HOST}/`));
  assert.throws(() => assertMicrosoftUrl(''));
  assert.throws(() => assertMicrosoftUrl(undefined));
  assert.equal(assertMicrosoftUrl(USER_URL), USER_URL);
  assert.equal(assertMicrosoftUrl(`${HOST}${API_PATH}?domain=microsoft.com`), `${HOST}${API_PATH}?domain=microsoft.com`);
});

// 3 buildSearchUrl
test('buildSearchUrl lifts query + location from careers_url; pins domain/num/start', () => {
  const u = new URL(buildSearchUrl({ careers_url: USER_URL }, 0));
  assert.equal(u.origin, HOST);
  assert.equal(u.pathname, API_PATH);
  assert.equal(u.searchParams.get('domain'), 'microsoft.com');
  assert.equal(u.searchParams.get('query'), 'AI Engineer');
  assert.equal(u.searchParams.get('location'), 'United Kingdom');
  assert.equal(u.searchParams.get('num'), String(PAGE_SIZE));
  assert.equal(u.searchParams.get('start'), '0');
  assert.equal(u.searchParams.get('pid'), null, 'unrelated page params are not forwarded');
  assert.equal(new URL(buildSearchUrl({ careers_url: USER_URL }, 20)).searchParams.get('start'), '20');
});
test('buildSearchUrl keeps only the text before the first comma of location=', () => {
  const url = `${HOST}/careers?query=Data%20Scientist&location=London%2C%20England%2C%20GB`;
  const u = new URL(buildSearchUrl({ careers_url: url }, 0));
  assert.equal(u.searchParams.get('location'), 'London');
  assert.equal(u.searchParams.get('query'), 'Data Scientist');
});
test('buildSearchUrl: entry.microsoft.{query,location} override the URL params', () => {
  const u = new URL(buildSearchUrl({ careers_url: USER_URL, microsoft: { query: 'Machine Learning', location: 'Ireland' } }, 10));
  assert.equal(u.searchParams.get('query'), 'Machine Learning');
  assert.equal(u.searchParams.get('location'), 'Ireland');
  assert.equal(u.searchParams.get('domain'), 'microsoft.com');
  assert.equal(u.searchParams.get('start'), '10');
});
test('buildSearchUrl: no query/location anywhere → params omitted, still a valid trusted URL', () => {
  const u = new URL(buildSearchUrl({ careers_url: `${HOST}/careers` }, 0));
  assert.equal(u.searchParams.get('query'), null);
  assert.equal(u.searchParams.get('location'), null);
  assert.equal(u.searchParams.get('domain'), 'microsoft.com');
  assert.equal(assertMicrosoftUrl(u.href), u.href);
});
test('buildSearchUrl rejects a non-Microsoft careers_url', () => {
  assert.throws(() => buildSearchUrl({ careers_url: 'https://jobs.lever.co/acme' }, 0));
});

// 4 positionToJob
test('positionToJob: London onsite row → host-pinned job URL, company Microsoft, plain title', () => {
  const p = FIXTURE.data.positions[0];
  const job = positionToJob(p);
  assert.equal(job.url, `${HOST}/careers/job/1970393556928855`);
  assert.equal(job.company, 'Microsoft');
  assert.equal(job.title, 'Sr Data Scientist - FDE - Security Check (SC) Clearance');
  assert.equal(job.location, 'United Kingdom, London, London');
  assert.equal(job.description, 'Data Science · onsite');
  assert.equal(job.postedAt, 1783694993 * 1000);
});
test('positionToJob: Cambridge row', () => {
  const job = positionToJob(FIXTURE.data.positions[1]);
  assert.equal(job.location, 'United Kingdom, Cambridgeshire, Cambridge');
  assert.equal(job.url, `${HOST}/careers/job/1970393556998409`);
});
test('positionToJob: two locations join with " · "', () => {
  const job = positionToJob(FIXTURE.data.positions[2]);
  assert.equal(job.location, 'Ireland, Dublin, Dublin · United Kingdom, London, London');
});
test('positionToJob: location falls back to standardizedLocations when locations is empty', () => {
  const job = positionToJob(fakePosition(1, 'X', { locations: [], standardizedLocations: ['Reading, England, GB'] }));
  assert.equal(job.location, 'Reading, England, GB');
  const none = positionToJob(fakePosition(2, 'Y', { locations: undefined, standardizedLocations: undefined }));
  assert.equal(none.location, '');
});
test('positionToJob: URL is built from the id even when positionUrl points elsewhere', () => {
  const job = positionToJob(fakePosition(77, 'Z', { positionUrl: 'https://evil.example/careers/job/77' }));
  assert.equal(job.url, `${HOST}/careers/job/77`);
  const rel = positionToJob(fakePosition(78, 'Z', { positionUrl: undefined }));
  assert.equal(rel.url, `${HOST}/careers/job/78`);
});
test('positionToJob: postedAt from postedTs; falls back to creationTs; garbage → undefined', () => {
  assert.equal(positionToJob(fakePosition(1, 'A', { postedTs: undefined, creationTs: 1787582169 })).postedAt, 1787582169 * 1000);
  assert.equal(positionToJob(fakePosition(2, 'B', { postedTs: 'nope', creationTs: null })).postedAt, undefined);
  assert.equal(positionToJob(fakePosition(3, 'C', { postedTs: 12, creationTs: undefined })).postedAt, undefined, 'year-1970 timestamp is garbage');
  assert.equal(positionToJob(fakePosition(4, 'D', { postedTs: 1789471817000, creationTs: undefined })).postedAt, undefined, 'ms passed as s is out of window');
});
test('positionToJob: title is plain text (entities/tags decoded)', () => {
  const job = positionToJob(fakePosition(5, 'Senior <b>AI</b> Engineer &amp; Architect'));
  assert.equal(job.title, 'Senior AI Engineer & Architect');
});
test('positionToJob: description degrades gracefully when department/workLocationOption missing', () => {
  assert.equal(positionToJob(fakePosition(6, 'E', { department: undefined, workLocationOption: 'onsite' })).description, 'onsite');
  assert.equal(positionToJob(fakePosition(7, 'F', { department: 'X', workLocationOption: null })).description, 'X');
  assert.equal(positionToJob(fakePosition(8, 'G', { department: undefined, workLocationOption: undefined })).description, '');
});
test('positionToJob: drops rows with a non-numeric id or an empty name', () => {
  assert.equal(positionToJob(fakePosition('abc')), null);
  assert.equal(positionToJob(fakePosition('12/../x')), null);
  assert.equal(positionToJob(fakePosition(undefined)), null);
  assert.equal(positionToJob(fakePosition(9, '')), null);
  assert.equal(positionToJob(fakePosition(10, '   ')), null);
  assert.equal(positionToJob(null), null);
  assert.equal(positionToJob('x'), null);
  assert.ok(positionToJob(fakePosition('1970393556928855', 'string id ok')));
});

// 5 fetch()
test('fetch: every request uses redirect:error, JSON accept and a browser-like user-agent', async () => {
  const ctx = fakeCtx({ 0: FIXTURE });
  const jobs = await provider.fetch({ name: 'Microsoft', careers_url: USER_URL }, ctx);
  assert.equal(jobs.length, 3);
  assert.ok(ctx.calls.length >= 1);
  for (const c of ctx.calls) {
    assert.equal(c.opts.redirect, 'error');
    const headers = new Headers(c.opts.headers);
    assert.match(headers.get('accept'), /application\/json/);
    assert.match(headers.get('user-agent'), /Mozilla\/5\.0/);
    assert.equal(new URL(c.url).hostname, TRUSTED_HOST);
  }
});
test('fetch: non-Microsoft careers_url throws before any request', async () => {
  const ctx = fakeCtx({ 0: FIXTURE });
  await assert.rejects(provider.fetch({ name: 'X', careers_url: 'https://jobs.lever.co/acme' }, ctx));
  await assert.rejects(provider.fetch({ name: 'X', careers_url: 'https://microsoft.eightfold.ai/careers' }, ctx));
  assert.equal(ctx.calls.length, 0);
});
test('fetch: ctx.maxPages=1 (health probe) makes exactly one request', async () => {
  const ctx = fakeCtx({ 0: fullPage(0, 500), 10: fullPage(10, 500) }, { maxPages: 1 });
  const jobs = await provider.fetch({ name: 'Microsoft', careers_url: USER_URL }, ctx);
  assert.equal(ctx.calls.length, 1);
  assert.equal(jobs.length, PAGE_SIZE);
});
test('fetch: pages start=0,10,… until start >= count (count 15 → 2 requests)', async () => {
  const ctx = fakeCtx({
    0: fullPage(0, 15),
    10: pageWith(Array.from({ length: 5 }, (_, i) => fakePosition(10 + i)), { count: 15 }),
    20: fullPage(20, 15),
  });
  const jobs = await provider.fetch({ name: 'Microsoft', careers_url: USER_URL }, ctx);
  assert.equal(ctx.calls.length, 2);
  assert.deepEqual(ctx.calls.map(c => new URL(c.url).searchParams.get('start')), ['0', '10']);
  assert.equal(jobs.length, 15);
});
test('fetch: the fixture (3 rows, count 15) → 3 jobs then stops on the empty follow-up page', async () => {
  const ctx = fakeCtx({ 0: FIXTURE, 10: pageWith([], { count: 15 }) });
  const jobs = await provider.fetch({ name: 'Microsoft', careers_url: USER_URL }, ctx);
  assert.equal(jobs.length, 3);
  assert.ok(ctx.calls.length <= 2);
});
test('fetch: empty positions on the first page → [] with one request', async () => {
  const ctx = fakeCtx({ 0: pageWith([], { count: 0 }) });
  assert.deepEqual(await provider.fetch({ name: 'Microsoft', careers_url: USER_URL }, ctx), []);
  assert.equal(ctx.calls.length, 1);
});
test('fetch: duplicate ids across pages collapse and an all-seen page stops pagination', async () => {
  const ctx = fakeCtx({ 0: fullPage(0, 40), 10: fullPage(0, 40), 20: fullPage(0, 40), 30: fullPage(0, 40) });
  const jobs = await provider.fetch({ name: 'Microsoft', careers_url: USER_URL }, ctx);
  assert.equal(jobs.length, PAGE_SIZE);
  assert.equal(new Set(jobs.map(j => j.url)).size, jobs.length);
  assert.ok(ctx.calls.length <= 2);
});
test('fetch: max_pages default 10, clamps to the cap 50, 0/garbage → default', async () => {
  const many = {};
  for (let s = 0; s < 70 * PAGE_SIZE; s += PAGE_SIZE) many[s] = fullPage(s, 100000);
  const ctx = fakeCtx(many);
  await provider.fetch({ name: 'Microsoft', careers_url: USER_URL }, ctx);
  assert.equal(ctx.calls.length, DEFAULT_MAX_PAGES);
  const ctx2 = fakeCtx(many);
  await provider.fetch({ name: 'Microsoft', careers_url: USER_URL, max_pages: 999 }, ctx2);
  assert.equal(ctx2.calls.length, MAX_PAGES_CAP);
  const ctx3 = fakeCtx(many);
  await provider.fetch({ name: 'Microsoft', careers_url: USER_URL, max_pages: 0 }, ctx3);
  assert.equal(ctx3.calls.length, DEFAULT_MAX_PAGES);
  const ctx4 = fakeCtx(many);
  await provider.fetch({ name: 'Microsoft', careers_url: USER_URL, max_pages: 'lots' }, ctx4);
  assert.equal(ctx4.calls.length, DEFAULT_MAX_PAGES);
  const ctx5 = fakeCtx(many);
  await provider.fetch({ name: 'Microsoft', careers_url: USER_URL, max_pages: 3 }, ctx5);
  assert.equal(ctx5.calls.length, 3);
});
test('fetch: page 2 failure keeps page 1 (no probe) but rethrows under a probe', async () => {
  const boom = new Error('HTTP 429 Too Many Requests');
  const ctx = fakeCtx({ 0: fullPage(0, 60), 10: boom });
  const jobs = await provider.fetch({ name: 'Microsoft', careers_url: USER_URL }, ctx);
  assert.equal(jobs.length, PAGE_SIZE);
  const probe = fakeCtx({ 0: boom }, { maxPages: 1 });
  await assert.rejects(provider.fetch({ name: 'Microsoft', careers_url: USER_URL }, probe), /429/);
  const firstPageFails = fakeCtx({ 0: boom });
  await assert.rejects(provider.fetch({ name: 'Microsoft', careers_url: USER_URL }, firstPageFails), /429/);
});
test('fetch: data.positions not an array → throws (never a silent empty board)', async () => {
  await assert.rejects(provider.fetch({ name: 'Microsoft', careers_url: USER_URL }, fakeCtx({ 0: { status: 200, data: { positions: 'nope', count: 3 } } })), /positions/i);
  await assert.rejects(provider.fetch({ name: 'Microsoft', careers_url: USER_URL }, fakeCtx({ 0: { status: 200, data: {} } })), /positions/i);
  await assert.rejects(provider.fetch({ name: 'Microsoft', careers_url: USER_URL }, fakeCtx({ 0: 'Please try again later' })), /positions/i);
});
test('fetch: entry.microsoft.query is what the request carries', async () => {
  const ctx = fakeCtx({ 0: FIXTURE, 10: pageWith([], { count: 15 }) });
  await provider.fetch({ name: 'Microsoft (ML)', careers_url: USER_URL, microsoft: { query: 'Machine Learning' } }, ctx);
  assert.equal(new URL(ctx.calls[0].url).searchParams.get('query'), 'Machine Learning');
  assert.equal(new URL(ctx.calls[0].url).searchParams.get('location'), 'United Kingdom');
});

// ── Round 5 (2026-09-22) ─────────────────────────────────────────────────────
// (a) 429 on a later page: Jim's first real run lost page 2 of "Microsoft" with
//     "HTTP 429 Too Many Requests — keeping 10 job(s)". The host rate-limits
//     bursts; the provider must retry harder (and pause longer) before giving up.
// (b) Descriptions: /api/apply/v2/jobs/<id>?domain=microsoft.com returns the
//     full posting as `job_description` HTML (robots.txt allows /api/apply).
//     Opt-in via `microsoft: { fetchDetails: true }`, like smartrecruiters.
const { INTER_PAGE_DELAY_MS, DETAIL_PATH, RETRY_POLICY } = mod;

function http429() {
  const e = new Error('HTTP 429 Too Many Requests');
  e.status = 429;
  return e;
}

// fetchJson that serves search pages by `start` and detail pages by id, and can
// fail a given start N times before succeeding.
function fakeCtx2({ pages, details = {}, failStart = {}, maxPages } = {}) {
  const calls = [];
  const sleeps = [];
  const failuresLeft = { ...failStart };
  const ctx = {
    calls,
    sleeps,
    sleep: async (ms) => { sleeps.push(ms); },
    async fetchJson(url, opts) {
      calls.push({ url, opts });
      const u = new URL(url);
      if (u.pathname.startsWith(DETAIL_PATH)) {
        const id = u.pathname.slice(DETAIL_PATH.length);
        const d = details[id];
        if (d instanceof Error) throw d;
        if (d === undefined) throw Object.assign(new Error('HTTP 404'), { status: 404 });
        return d;
      }
      const start = Number(u.searchParams.get('start') || 0);
      if ((failuresLeft[start] || 0) > 0) { failuresLeft[start]--; throw http429(); }
      return pages[start] ?? pageWith([], { count: 0 });
    },
  };
  if (maxPages) ctx.maxPages = maxPages;
  return ctx;
}

test('round 5: pages are 1.5 s apart and the retry policy is 4 tries from 2 s', () => {
  assert.equal(INTER_PAGE_DELAY_MS, 1500);
  assert.deepEqual(RETRY_POLICY, { retries: 4, baseDelayMs: 2000, maxDelayMs: 20_000 });
  assert.equal(DETAIL_PATH, '/api/apply/v2/jobs/');
});

test('round 5: a page that answers 429 three times is retried and still delivered', async () => {
  const ctx = fakeCtx2({ pages: { 0: fullPage(0, 15), 10: pageWith([fakePosition(10), fakePosition(11), fakePosition(12), fakePosition(13), fakePosition(14)], { count: 15 }) }, failStart: { 10: 3 } });
  const jobs = await provider.fetch({ name: 'Microsoft', careers_url: USER_URL }, ctx);
  assert.equal(jobs.length, 15, 'page 2 arrives after the retries');
  const page2Calls = ctx.calls.filter(c => new URL(c.url).searchParams.get('start') === '10');
  assert.equal(page2Calls.length, 4, '3 failures + 1 success');
  assert.ok(ctx.sleeps.some(ms => ms >= 2000), 'backoff waits at least the 2 s base');
});

test('round 5: a page that keeps failing after 4 retries still keeps the earlier pages', async () => {
  const ctx = fakeCtx2({ pages: { 0: fullPage(0, 15) }, failStart: { 10: 99 } });
  const jobs = await provider.fetch({ name: 'Microsoft', careers_url: USER_URL }, ctx);
  assert.equal(jobs.length, 10);
  assert.equal(ctx.calls.filter(c => new URL(c.url).searchParams.get('start') === '10').length, 5, '1 try + 4 retries');
});

test('round 5: fetchDetails → one detail call per job, job_description becomes the plain-text description', async () => {
  const ctx = fakeCtx2({
    pages: { 0: pageWith([fakePosition(1, 'AI Engineer'), fakePosition(2, 'Data Scientist')], { count: 2 }) },
    details: {
      '1': { id: 1, job_description: '<b>Overview</b><br><p>Build AI &amp; ML systems.</p><ul><li>Python</li></ul>' },
      '2': { id: 2, job_description: '<p>Model the data.</p>' },
    },
  });
  const jobs = await provider.fetch({ name: 'Microsoft', careers_url: USER_URL, microsoft: { fetchDetails: true } }, ctx);
  assert.equal(jobs.length, 2);
  assert.match(jobs[0].description, /Overview[\s\S]*Build AI & ML systems\.[\s\S]*Python/);
  assert.doesNotMatch(jobs[0].description, /<[a-z]+>/);
  assert.equal(jobs[1].description, 'Model the data.');
  const detailCalls = ctx.calls.filter(c => new URL(c.url).pathname.startsWith(DETAIL_PATH));
  assert.equal(detailCalls.length, 2);
  for (const c of detailCalls) {
    const u = new URL(c.url);
    assert.equal(u.hostname, TRUSTED_HOST);
    assert.equal(u.searchParams.get('domain'), 'microsoft.com');
    assert.equal(c.opts.redirect, 'error');
  }
});

test('round 5: a failed detail call keeps the job with its summary description (title + link never lost)', async () => {
  const ctx = fakeCtx2({
    pages: { 0: pageWith([fakePosition(1, 'AI Engineer'), fakePosition(2, 'Data Scientist')], { count: 2 }) },
    details: { '2': { job_description: '<p>ok</p>' } },   // id 1 → 404
  });
  const jobs = await provider.fetch({ name: 'Microsoft', careers_url: USER_URL, microsoft: { fetchDetails: true } }, ctx);
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].title, 'AI Engineer');
  assert.equal(jobs[0].url, `${HOST}/careers/job/1`);
  assert.equal(jobs[0].description, 'Software Engineering · hybrid');
  assert.equal(jobs[1].description, 'ok');
});

test('round 5: no fetchDetails (default) and health probes make no detail calls', async () => {
  const ctx = fakeCtx2({ pages: { 0: pageWith([fakePosition(1)], { count: 1 }) }, details: { '1': { job_description: 'x' } } });
  await provider.fetch({ name: 'Microsoft', careers_url: USER_URL }, ctx);
  assert.equal(ctx.calls.filter(c => new URL(c.url).pathname.startsWith(DETAIL_PATH)).length, 0);
  const probe = fakeCtx2({ pages: { 0: pageWith([fakePosition(1)], { count: 1 }) }, details: { '1': { job_description: 'x' } }, maxPages: 1 });
  await provider.fetch({ name: 'Microsoft', careers_url: USER_URL, microsoft: { fetchDetails: true } }, probe);
  assert.equal(probe.calls.length, 1, 'probe = one search request, no details');
});

test('round 5: the detail URL passes the SSRF guard, other /api paths do not', () => {
  assert.equal(assertMicrosoftUrl(`${HOST}${DETAIL_PATH}123?domain=microsoft.com`), `${HOST}${DETAIL_PATH}123?domain=microsoft.com`);
  assert.throws(() => assertMicrosoftUrl(`${HOST}/api/other/123`));
});
