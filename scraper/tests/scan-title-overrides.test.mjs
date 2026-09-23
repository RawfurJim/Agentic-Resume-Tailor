// Unit-tests the scan.mjs wiring that resolves ONE title predicate from
// `title_filter` + `title_filter_overrides`, and the way the scan loop calls
// it: with the portals.yml entry name AND the job's own company (a Google
// board yields job.company === 'DeepMind' for DeepMind roles).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { resolveTitleFilter, buildTitleFilter } = await import('../scan.mjs');

const CONFIG = {
  title_filter: {
    positive: ['AI', 'Machine Learning'],
    negative: ['Sales', 'Research Scientist', 'word:Manager'],
  },
  title_filter_overrides: [
    { companies: ['OpenAI', 'deepmind'], positive_extra: ['Software Engineer'] },
  ],
};

test('resolveTitleFilter: global positives pass for any company', () => {
  const ok = resolveTitleFilter(CONFIG);
  assert.equal(ok('AI Engineer', 'Acme', 'Acme'), true);
  assert.equal(ok('Machine Learning Engineer', undefined, undefined), true);
});

test('resolveTitleFilter: override widens the net only for listed companies (entry name)', () => {
  const ok = resolveTitleFilter(CONFIG);
  assert.equal(ok('Software Engineer, Distributed Systems', 'OpenAI', 'OpenAI'), true);
  assert.equal(ok('Software Engineer, Distributed Systems', 'Acme', 'Acme'), false);
});

test('resolveTitleFilter: override also keys on the job company (Google board → DeepMind job)', () => {
  const ok = resolveTitleFilter(CONFIG);
  assert.equal(ok('Software Engineer, Platform', 'Google', 'DeepMind'), true);
  assert.equal(ok('Software Engineer, Platform', 'Google', 'Google'), false);
  assert.equal(ok('Software Engineer, Platform', 'Google', undefined), false);
});

test('resolveTitleFilter: global negatives veto the override', () => {
  const ok = resolveTitleFilter(CONFIG);
  assert.equal(ok('Research Scientist', 'DeepMind', 'DeepMind'), false);
  assert.equal(ok('Software Engineer, Sales Tools', 'OpenAI', 'OpenAI'), false);
  assert.equal(ok('Software Engineering Manager', 'OpenAI', 'OpenAI'), false);
});

test('resolveTitleFilter: company matching is case-insensitive and whitespace-tolerant', () => {
  const ok = resolveTitleFilter(CONFIG);
  assert.equal(ok('Software Engineer', 'OPENAI', ''), true);
  assert.equal(ok('Software Engineer', '  openai ', ''), true);
});

test('resolveTitleFilter: without title_filter_overrides it equals buildTitleFilter', () => {
  const cfg = { title_filter: CONFIG.title_filter };
  const ok = resolveTitleFilter(cfg);
  const plain = buildTitleFilter(cfg.title_filter);
  for (const t of ['AI Engineer', 'Software Engineer', 'AI Sales Lead', 'Research Scientist', '', null]) {
    assert.equal(ok(t, 'OpenAI', 'OpenAI'), plain(t), `title=${t}`);
  }
});

test('resolveTitleFilter: tolerates missing/malformed config', () => {
  assert.equal(resolveTitleFilter({})('AI Engineer'), true);            // no positive → no constraint
  assert.equal(resolveTitleFilter(null)('anything'), true);
  assert.equal(resolveTitleFilter({ title_filter_overrides: 'nope', title_filter: CONFIG.title_filter })('AI Engineer', 'x', 'y'), true);
});
