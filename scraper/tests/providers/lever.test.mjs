// Lever's v0 postings API puts a bare city in `categories.location` ("Cambridge")
// and the ISO 3166-1 alpha-2 country in a separate `country` field ("GB").
// scan.mjs judges location on ONE string, so a UK config that must reject
// "Cambridge, MA" (and therefore cannot always_allow a bare "Cambridge") lost
// Healx's "AI Engineer (Agentic Systems)" in Cambridge UK (round 2, Task 4).
// The provider now folds the country code into the location string.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const lever = (await import('../../providers/lever.mjs')).default;

const ENTRY = { name: 'Healx', careers_url: 'https://jobs.lever.co/healx' };
const ctxWith = (postings) => ({
  fetchJson: async () => postings,
  fetchText: async () => { throw new Error('unexpected'); },
});
const posting = (over = {}) => ({
  text: 'AI Engineer (Agentic Systems)',
  hostedUrl: 'https://jobs.lever.co/healx/abc',
  createdAt: 1758000000000,
  country: 'GB',
  categories: { location: 'Cambridge', allLocations: ['Cambridge'] },
  ...over,
});

test('lever: appends the ISO country code when the location does not name it', async () => {
  const [job] = await lever.fetch(ENTRY, ctxWith([posting()]));
  assert.equal(job.location, 'Cambridge, GB');
});

test('lever: does not repeat a country code the location already contains', async () => {
  const [a] = await lever.fetch(ENTRY, ctxWith([posting({ categories: { location: 'London, GB' } })]));
  assert.equal(a.location, 'London, GB');
  const [b] = await lever.fetch(ENTRY, ctxWith([posting({ categories: { location: 'Remote - gb' } })]));
  assert.equal(b.location, 'Remote - gb');
});

test('lever: multi-location postings keep every location, then the country once', async () => {
  const [job] = await lever.fetch(ENTRY, ctxWith([posting({
    categories: { location: 'Barcelona', allLocations: ['Barcelona', 'Montevideo'] },
    country: 'ES',
  })]));
  assert.equal(job.location, 'Barcelona; Montevideo, ES');
});

test('lever: no country field → location unchanged; empty location + country → just the code', async () => {
  const [a] = await lever.fetch(ENTRY, ctxWith([posting({ country: undefined })]));
  assert.equal(a.location, 'Cambridge');
  const [b] = await lever.fetch(ENTRY, ctxWith([posting({ categories: {} })]));
  assert.equal(b.location, 'GB');
  const [c] = await lever.fetch(ENTRY, ctxWith([posting({ categories: {}, country: undefined })]));
  assert.equal(c.location, '');
});

test('lever: ignores a malformed country value (not two letters)', async () => {
  const [a] = await lever.fetch(ENTRY, ctxWith([posting({ country: 'United Kingdom' })]));
  assert.equal(a.location, 'Cambridge');
  const [b] = await lever.fetch(ENTRY, ctxWith([posting({ country: 42 })]));
  assert.equal(b.location, 'Cambridge');
});

test('lever: the Healx case passes the live UK location_filter only WITH the country code', async () => {
  const { readFileSync } = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const yaml = await import('js-yaml');
  const here = path.dirname(fileURLToPath(import.meta.url));
  const cfg = yaml.load(readFileSync(path.join(here, '..', '..', 'portals.yml'), 'utf8'));
  const { buildLocationFilter } = await import('../../scan.mjs');
  const locOk = buildLocationFilter(cfg.location_filter);
  assert.equal(locOk('Cambridge'), false, 'bare Cambridge must stay ambiguous (Cambridge, MA leaked before)');
  assert.equal(locOk('Cambridge, GB'), true);
  assert.equal(locOk('Cambridge, US'), false);
});
