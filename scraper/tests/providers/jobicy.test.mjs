// Round 5 (2026-09-22): Jobicy's API takes geo / tag / count filters
// (https://jobicy.com/api/v2/remote-jobs?count=100&geo=uk&tag=machine%20learning).
// The provider used to fetch 50 worldwide jobs; a `jobicy:` block on the entry
// now narrows the feed. No block → the exact old URL, so old configs behave as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const mod = await import('../../providers/jobicy.mjs');
const provider = mod.default;
const { buildFeedUrl, parseJobicyResponse } = mod;

function fakeCtx(json) {
  const calls = [];
  return { calls, async fetchJson(url, opts) { calls.push({ url, opts }); return json; } };
}
const SAMPLE = {
  jobs: [
    { id: 1, jobTitle: 'Senior Machine Learning Engineer', companyName: 'Acme', jobGeo: 'Europe, UK', url: 'https://jobicy.com/jobs/1-mle', pubDate: '2026-09-20 10:00:00' },
    { id: 2, jobTitle: 'Data Scientist', companyName: '', jobGeo: 'UK', url: 'https://jobicy.com/jobs/2-ds' },
    { id: 3, jobTitle: 'Bad url', companyName: 'X', jobGeo: 'UK', url: 'https://evil.example/jobs/3' },
  ],
};

test('buildFeedUrl: no jobicy block → the historical URL (count=50, no filters)', () => {
  assert.equal(buildFeedUrl({ name: 'Jobicy' }), 'https://jobicy.com/api/v2/remote-jobs?count=50');
  assert.equal(buildFeedUrl({ jobicy: {} }), 'https://jobicy.com/api/v2/remote-jobs?count=50');
});

test('buildFeedUrl: geo / tag / count go into the query; count is clamped to 1..100', () => {
  const u = new URL(buildFeedUrl({ jobicy: { geo: 'uk', tag: 'machine learning', count: 100 } }));
  assert.equal(u.origin + u.pathname, 'https://jobicy.com/api/v2/remote-jobs');
  assert.equal(u.searchParams.get('geo'), 'uk');
  assert.equal(u.searchParams.get('tag'), 'machine learning');
  assert.equal(u.searchParams.get('count'), '100');
  assert.equal(new URL(buildFeedUrl({ jobicy: { count: 5000 } })).searchParams.get('count'), '100');
  assert.equal(new URL(buildFeedUrl({ jobicy: { count: 0 } })).searchParams.get('count'), '50');
  assert.equal(new URL(buildFeedUrl({ jobicy: { count: 'abc', geo: 42 } })).searchParams.get('geo'), null);
});

test('fetch: requests the configured URL with redirect:error and normalises rows', async () => {
  const ctx = fakeCtx(SAMPLE);
  const jobs = await provider.fetch({ name: 'Jobicy (UK remote)', jobicy: { geo: 'uk' } }, ctx);
  assert.equal(ctx.calls.length, 1);
  assert.equal(new URL(ctx.calls[0].url).searchParams.get('geo'), 'uk');
  assert.equal(ctx.calls[0].opts.redirect, 'error');
  assert.deepEqual(jobs.map(j => j.title), ['Senior Machine Learning Engineer', 'Data Scientist']);
  assert.equal(jobs[0].company, 'Acme');
  assert.equal(jobs[0].location, 'Europe, UK');
  assert.equal(typeof jobs[0].postedAt, 'number');
  assert.equal(jobs[1].company, 'Jobicy (UK remote)', 'no company → entry name');
});

test('parseJobicyResponse: off-host urls are dropped, malformed payload → []', () => {
  assert.equal(parseJobicyResponse(SAMPLE).length, 2);
  assert.deepEqual(parseJobicyResponse({ nope: 1 }), []);
  assert.deepEqual(parseJobicyResponse(null), []);
});
