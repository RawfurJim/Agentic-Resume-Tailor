// Tests for providers/amazon.mjs (round 5, 2026-09-22) — written before the change.
// amazon.jobs search.json gives the full description + qualifications inline and
// names the HIRING ENTITY ("AWS EMEA SARL (UK Branch)"), not "Amazon". The
// provider must surface the description; scan.mjs's `company_label` renames.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const mod = await import('../../providers/amazon.mjs');
const provider = mod.default;
const { applyCompanyLabel } = await import('../../scan.mjs');

function amazonJob(overrides = {}) {
  return {
    id: '10498462',
    title: 'Senior GenAI Infra Specialist, WWSO Startups',
    job_path: '/en/jobs/10498462/senior-genai-infra-specialist-wwso-startups',
    company_name: 'AWS EMEA SARL (UK Branch)',
    normalized_location: 'London, England, GBR',
    location: 'GB, London',
    posted_date: 'August  10, 2026',
    description: '<p>Build <b>GenAI</b> infrastructure for startups.</p><ul><li>Own the roadmap</li></ul>',
    basic_qualifications: '<p>5+ years with ML systems</p>',
    preferred_qualifications: '<p>Experience with Bedrock</p>',
    ...overrides,
  };
}

function fakeCtx(pagesByOffset) {
  const calls = [];
  return {
    calls,
    async fetchJson(url) {
      calls.push(url);
      const offset = Number(new URL(url).searchParams.get('offset') || 0);
      return pagesByOffset[offset] ?? { jobs: [] };
    },
  };
}

const ENTRY = {
  name: 'Amazon / AWS (UK)',
  provider: 'amazon',
  careers_url: 'https://www.amazon.jobs/en/search',
  amazon: { normalized_country_code: ['GBR'] },
};

test('amazon: whole-board entry without base_query queries the UK facet only', async () => {
  const ctx = fakeCtx({ 0: { jobs: [amazonJob()] } });
  await provider.fetch(ENTRY, ctx);
  const u = new URL(ctx.calls[0]);
  assert.equal(u.searchParams.getAll('normalized_country_code[]').join(), 'GBR');
  assert.equal(u.searchParams.get('base_query'), '');
  assert.equal(u.searchParams.get('result_limit'), '100');
});

test('amazon: description = description + basic + preferred qualifications, as plain text', async () => {
  const ctx = fakeCtx({ 0: { jobs: [amazonJob()] } });
  const [job] = await provider.fetch(ENTRY, ctx);
  assert.equal(job.title, 'Senior GenAI Infra Specialist, WWSO Startups');
  assert.equal(job.url, 'https://www.amazon.jobs/en/jobs/10498462/senior-genai-infra-specialist-wwso-startups');
  assert.equal(job.company, 'AWS EMEA SARL (UK Branch)');           // raw entity; scan.mjs relabels
  assert.equal(job.location, 'London, England, GBR');
  assert.match(job.description, /Build GenAI infrastructure for startups/);
  assert.match(job.description, /Own the roadmap/);
  assert.match(job.description, /Basic qualifications[\s\S]*5\+ years with ML systems/i);
  assert.match(job.description, /Preferred qualifications[\s\S]*Experience with Bedrock/i);
  assert.doesNotMatch(job.description, /<[a-z]+>/, 'HTML tags must be stripped');
  assert.equal(typeof job.postedAt, 'number');
});

test('amazon: a posting with no description fields gets no description key (undefined, not "")', async () => {
  const ctx = fakeCtx({ 0: { jobs: [amazonJob({ description: undefined, basic_qualifications: undefined, preferred_qualifications: undefined })] } });
  const [job] = await provider.fetch(ENTRY, ctx);
  assert.equal(job.description, undefined);
});

test('applyCompanyLabel: renames every job to the entry label, trimmed; no label → untouched', () => {
  const jobs = [{ company: 'AWS EMEA SARL (UK Branch)' }, { company: 'Evi Technologies Limited' }, {}];
  applyCompanyLabel(jobs, { name: 'Amazon / AWS (UK)', company_label: '  Amazon ' });
  assert.deepEqual(jobs.map(j => j.company), ['Amazon', 'Amazon', 'Amazon']);

  const untouched = [{ company: 'Google' }, { company: 'DeepMind' }];
  applyCompanyLabel(untouched, { name: 'Google' });
  assert.deepEqual(untouched.map(j => j.company), ['Google', 'DeepMind']);
  applyCompanyLabel(untouched, { name: 'Google', company_label: '   ' });   // blank label = not set
  assert.deepEqual(untouched.map(j => j.company), ['Google', 'DeepMind']);
  applyCompanyLabel(untouched, { name: 'Google', company_label: 42 });      // non-string = not set
  assert.deepEqual(untouched.map(j => j.company), ['Google', 'DeepMind']);
});
