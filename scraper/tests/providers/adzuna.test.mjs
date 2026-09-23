// Round 5 (2026-09-22): Adzuna — the broadest UK job aggregator (Reed, TotalJobs,
// CV-Library, LinkedIn…). Official JSON API, free app_id/app_key.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const mod = await import('../../providers/adzuna.mjs');
const provider = mod.default;
const { buildSearchUrl, normalizeAdzunaJob, ENV_APP_ID, ENV_APP_KEY } = mod;

const ENTRY = { name: 'Adzuna (UK)', provider: 'adzuna', adzuna: { country: 'gb', queries: ['AI Engineer', 'Data Scientist'], max_pages: 2 } };
const RESULT = (id, title, extra = {}) => ({
  id: String(id), title, redirect_url: `https://www.adzuna.co.uk/jobs/details/${id}?utm_source=api`,
  company: { display_name: 'Acme Ltd' }, location: { display_name: 'London, UK', area: ['UK', 'London'] },
  created: '2026-09-20T09:12:00Z', description: 'Build <b>LLM</b> products &amp; agents.', ...extra,
});
function fakeCtx(byUrl) {
  const calls = [];
  return {
    calls,
    async fetchJson(url, opts) {
      calls.push({ url, opts });
      const u = new URL(url);
      const key = `${u.searchParams.get('what')}|${u.pathname.split('/').pop()}`;
      return byUrl[key] ?? { results: [], count: 0 };
    },
  };
}
function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) { saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  return Promise.resolve().then(fn).finally(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
}

test('adzuna: id, explicit-provider detection only', () => {
  assert.equal(provider.id, 'adzuna');
  assert.deepEqual(provider.detect({ provider: 'adzuna' }), { url: 'https://api.adzuna.com/v1/api/jobs/gb/search/1' });
  assert.equal(provider.detect({ careers_url: 'https://www.adzuna.co.uk/' }), null);
  assert.equal(ENV_APP_ID, 'ADZUNA_APP_ID'); assert.equal(ENV_APP_KEY, 'ADZUNA_APP_KEY');
});

test('adzuna: missing keys → one clear error naming the .env variables, no request made', async () => {
  await withEnv({ ADZUNA_APP_ID: undefined, ADZUNA_APP_KEY: undefined }, async () => {
    const ctx = fakeCtx({});
    await assert.rejects(provider.fetch(ENTRY, ctx), /ADZUNA_APP_ID.*ADZUNA_APP_KEY.*\.env/s);
    assert.equal(ctx.calls.length, 0);
  });
});

test('adzuna: no queries configured → error (the board is UK-wide, a search is required)', async () => {
  await withEnv({ ADZUNA_APP_ID: 'id', ADZUNA_APP_KEY: 'key' }, async () => {
    await assert.rejects(provider.fetch({ name: 'A', provider: 'adzuna' }, fakeCtx({})), /queries/);
  });
});

test('buildSearchUrl: country, page, what, keys, 50 per page, max_days_old, json content-type', () => {
  const u = new URL(buildSearchUrl({ country: 'gb', what: 'AI Engineer', page: 2, appId: 'ID', appKey: 'KEY', maxDaysOld: 60, where: 'London' }));
  assert.equal(u.origin + u.pathname, 'https://api.adzuna.com/v1/api/jobs/gb/search/2');
  assert.equal(u.searchParams.get('app_id'), 'ID');
  assert.equal(u.searchParams.get('app_key'), 'KEY');
  assert.equal(u.searchParams.get('what'), 'AI Engineer');
  assert.equal(u.searchParams.get('where'), 'London');
  assert.equal(u.searchParams.get('results_per_page'), '50');
  assert.equal(u.searchParams.get('max_days_old'), '60');
  assert.equal(u.searchParams.get('content-type'), 'application/json');
  assert.throws(() => buildSearchUrl({ country: '../x', what: 'a', page: 1, appId: 'i', appKey: 'k' }), /country/);
});

test('normalizeAdzunaJob: plain-text title, company, location, adzuna-hosted url, posted date, text description', () => {
  const j = normalizeAdzunaJob(RESULT(1, 'Senior <strong>AI</strong> Engineer'), 'Adzuna');
  assert.equal(j.title, 'Senior AI Engineer');
  assert.equal(j.company, 'Acme Ltd');
  assert.equal(j.location, 'London, UK');
  assert.equal(j.url, 'https://www.adzuna.co.uk/jobs/details/1?utm_source=api');
  assert.equal(j.postedAt, Date.parse('2026-09-20T09:12:00Z'));
  assert.equal(j.description, 'Build LLM products & agents.');
  assert.equal(j.descriptionTruncated, true, 'round 6: the search API only sends a teaser — full-description.mjs fetches the rest');
  assert.equal(normalizeAdzunaJob(RESULT(2, 'X', { description: '' }), 'Adzuna').descriptionTruncated, undefined, 'no teaser → no flag');
  assert.equal(normalizeAdzunaJob(RESULT(2, 'X', { company: {} }), 'Adzuna').company, 'Adzuna', 'no employer → entry name');
  assert.equal(normalizeAdzunaJob(RESULT(3, 'X', { redirect_url: 'http://evil.example/3' }), 'A'), null, 'off-host url dropped');
  assert.equal(normalizeAdzunaJob(RESULT(4, ''), 'A'), null);
  assert.equal(normalizeAdzunaJob(null, 'A'), null);
});

test('fetch: one request per query per page, pages stop on a short page, results deduped by url', async () => {
  await withEnv({ ADZUNA_APP_ID: 'id', ADZUNA_APP_KEY: 'key' }, async () => {
    const full = Array.from({ length: 50 }, (_, i) => RESULT(100 + i, `AI Engineer ${i}`));
    const ctx = fakeCtx({
      'AI Engineer|1': { results: full, count: 60 },
      'AI Engineer|2': { results: [RESULT(200, 'AI Engineer 200'), RESULT(100, 'AI Engineer 0 again')], count: 60 },
      'Data Scientist|1': { results: [RESULT(300, 'Data Scientist'), RESULT(200, 'dupe across queries')], count: 2 },
    });
    const jobs = await provider.fetch(ENTRY, ctx);
    assert.equal(ctx.calls.length, 3, 'AI Engineer p1+p2, Data Scientist p1 (short page → stop)');
    assert.equal(jobs.length, 52);
    for (const c of ctx.calls) assert.equal(c.opts.redirect, 'error');
  });
});
