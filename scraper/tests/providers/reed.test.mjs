// Round 5 (2026-09-22): Reed.co.uk Jobseeker API — the UK's largest job site.
// Basic auth with the key as the username and an empty password.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const mod = await import('../../providers/reed.mjs');
const provider = mod.default;
const { buildSearchUrl, normalizeReedJob, ENV_KEY, PAGE_SIZE } = mod;

const ENTRY = { name: 'Reed.co.uk', provider: 'reed', reed: { queries: ['AI Engineer', 'Data Scientist'], max_pages: 2 } };
const RESULT = (id, title, extra = {}) => ({
  jobId: id, employerName: 'Acme Ltd', jobTitle: title, locationName: 'London', date: '19/09/2026',
  jobDescription: 'Build <b>LLM</b> products &amp; agents...', jobUrl: `https://www.reed.co.uk/jobs/${id}`,
  fullTime: true, partTime: false, contractType: 'Permanent', ...extra,
});
function fakeCtx(byKey) {
  const calls = [];
  return {
    calls,
    async fetchJson(url, opts) {
      calls.push({ url, opts });
      const u = new URL(url);
      const key = `${u.searchParams.get('keywords')}|${u.searchParams.get('resultsToSkip') || 0}`;
      return byKey[key] ?? { results: [], totalResults: 0 };
    },
  };
}
function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) { saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  return Promise.resolve().then(fn).finally(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
}

test('reed: id, explicit-provider detection only, page size 100 (API cap)', () => {
  assert.equal(provider.id, 'reed');
  assert.deepEqual(provider.detect({ provider: 'reed' }), { url: 'https://www.reed.co.uk/api/1.0/search' });
  assert.equal(provider.detect({ careers_url: 'https://www.reed.co.uk/jobs' }), null);
  assert.equal(ENV_KEY, 'REED_API_KEY'); assert.equal(PAGE_SIZE, 100);
});

test('reed: missing key → clear error naming REED_API_KEY and .env, no request', async () => {
  await withEnv({ REED_API_KEY: undefined }, async () => {
    const ctx = fakeCtx({});
    await assert.rejects(provider.fetch(ENTRY, ctx), /REED_API_KEY.*\.env/s);
    assert.equal(ctx.calls.length, 0);
  });
});

test('buildSearchUrl: keywords, resultsToTake=100, resultsToSkip, optional locationName', () => {
  const u = new URL(buildSearchUrl({ keywords: 'AI Engineer', skip: 100, locationName: 'London' }));
  assert.equal(u.origin + u.pathname, 'https://www.reed.co.uk/api/1.0/search');
  assert.equal(u.searchParams.get('keywords'), 'AI Engineer');
  assert.equal(u.searchParams.get('resultsToTake'), '100');
  assert.equal(u.searchParams.get('resultsToSkip'), '100');
  assert.equal(u.searchParams.get('locationName'), 'London');
  assert.equal(new URL(buildSearchUrl({ keywords: 'x', skip: 0 })).searchParams.get('locationName'), null);
});

test('normalizeReedJob: fields, dd/MM/yyyy date, text description, reed-hosted url; part-time / contract / temp dropped', () => {
  const j = normalizeReedJob(RESULT(1, 'Senior AI Engineer'), 'Reed');
  assert.equal(j.title, 'Senior AI Engineer');
  assert.equal(j.company, 'Acme Ltd');
  assert.equal(j.location, 'London');
  assert.equal(j.url, 'https://www.reed.co.uk/jobs/1');
  assert.equal(new Date(j.postedAt).toISOString().slice(0, 10), '2026-09-19');
  assert.equal(j.description, 'Build LLM products & agents...');
  assert.equal(j.descriptionTruncated, true, 'round 6: the search API only sends a teaser — full-description.mjs fetches /api/1.0/jobs/<id>');
  assert.equal(normalizeReedJob(RESULT(9, 'X', { jobDescription: '' }), 'Reed').descriptionTruncated, undefined, 'no teaser → no flag');
  assert.equal(normalizeReedJob(RESULT(2, 'X', { fullTime: false, partTime: true }), 'R'), null, 'part-time out');
  assert.equal(normalizeReedJob(RESULT(3, 'X', { contractType: 'Contract' }), 'R'), null, 'contract out');
  assert.equal(normalizeReedJob(RESULT(4, 'X', { contractType: 'Temp' }), 'R'), null, 'temp out');
  assert.equal(normalizeReedJob(RESULT(5, 'X', { jobUrl: 'https://evil.example/5' }), 'R'), null, 'off-host url out');
  assert.equal(normalizeReedJob(RESULT(6, 'X', { employerName: '' }), 'Reed').company, 'Reed');
  assert.equal(normalizeReedJob(RESULT(7, 'X', { date: 'garbage' }), 'R').postedAt, undefined);
  assert.equal(normalizeReedJob(null, 'R'), null);
});

test('fetch: Basic auth header (key as username), one request per query per page, dedup, short page stops', async () => {
  await withEnv({ REED_API_KEY: 'abc123' }, async () => {
    const full = Array.from({ length: 100 }, (_, i) => RESULT(1000 + i, `AI Engineer ${i}`));
    const ctx = fakeCtx({
      'AI Engineer|0': { results: full, totalResults: 101 },
      'AI Engineer|100': { results: [RESULT(2000, 'AI Engineer last'), RESULT(1000, 'dupe')], totalResults: 101 },
      'Data Scientist|0': { results: [RESULT(3000, 'Data Scientist'), RESULT(2000, 'dupe across queries')], totalResults: 2 },
    });
    const jobs = await provider.fetch(ENTRY, ctx);
    assert.equal(ctx.calls.length, 3);
    assert.equal(jobs.length, 102);
    for (const c of ctx.calls) {
      assert.equal(c.opts.redirect, 'error');
      const auth = new Headers(c.opts.headers).get('authorization');
      assert.equal(auth, `Basic ${Buffer.from('abc123:').toString('base64')}`);
    }
  });
});
