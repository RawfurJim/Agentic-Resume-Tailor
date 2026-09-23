// Round 2, Task 3: finance / insurance / defence employers are out of scope
// for Jim. Two layers enforce it and this file asserts both against the LIVE
// files: (1) their portals.yml entries are disabled so they are never fetched,
// (2) data/blacklist.md lists them (plus banks / insurers / defence names that
// could arrive through aggregator feeds) so scan.mjs skips any posting that
// still names them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as yaml from 'js-yaml';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const BLACKLIST_PATH = path.join(root, 'data', 'blacklist.md');

const { parseBlacklist, loadBlacklist } = await import('../scan.mjs');
const { normalizeCompany } = await import('../tracker-utils.mjs');

const config = yaml.load(readFileSync(path.join(root, 'portals.yml'), 'utf8'));
const entries = config.tracked_companies ?? [];
const entryByName = new Map(entries.map(e => [normalizeCompany(e.name), e]));

// portals.yml entries that Round 1 enabled and Task 3 switches off (Phase C2).
const DISABLED_SECTOR_ENTRIES = [
  'Stripe', 'Coinbase', 'Monzo', 'Ramp', 'Revolut', 'Klarna', 'N26', 'Trade Republic',
  'SumUp', 'Qonto', 'Mollie', 'Pleo', 'Allianz', 'Helsing', 'Palantir', 'Rolls-Royce',
];

// Names with no portals.yml entry that the Himalayas / Agentic / websearch
// feeds could still surface (Phase C3).
const FEED_ONLY_BLACKLIST = [
  'Barclays', 'HSBC', 'Lloyds', 'NatWest', 'Standard Chartered', 'Goldman Sachs',
  'JPMorgan', 'Morgan Stanley', 'Citi', 'Wise', 'Starling', 'Zopa', 'Checkout.com',
  'Aviva', 'Legal & General', 'Prudential', 'Bupa', 'BAE Systems', 'Leonardo',
  'Thales', 'QinetiQ', 'Anduril',
  // 2026-09-23 (Jim): eFinancialCareers is a finance job board that Reed/Adzuna hand on as the
  // "company" (its rows are Citi, Barings, Selby Jennings… roles); Janus Henderson is an asset manager.
  'eFinancialCareers', 'Janus Henderson Investors',
];

test('data/blacklist.md exists and parses to a non-empty company map', () => {
  assert.ok(existsSync(BLACKLIST_PATH), 'data/blacklist.md is missing');
  const map = parseBlacklist(readFileSync(BLACKLIST_PATH, 'utf8'));
  assert.ok(map.size >= DISABLED_SECTOR_ENTRIES.length + FEED_ONLY_BLACKLIST.length,
    `expected at least ${DISABLED_SECTOR_ENTRIES.length + FEED_ONLY_BLACKLIST.length} rows, got ${map.size}`);
});

test('loadBlacklist() with the live path returns the same map scan.mjs will use', () => {
  const map = loadBlacklist(BLACKLIST_PATH);
  for (const name of ['Monzo', 'Revolut', 'Palantir', 'Helsing', 'Allianz', 'Barclays']) {
    assert.ok(map.has(normalizeCompany(name)), `${name} not on the blacklist`);
  }
});

test('every disabled-sector employer and every feed-only name is blacklisted with a sector reason', () => {
  const map = loadBlacklist(BLACKLIST_PATH);
  for (const name of [...DISABLED_SECTOR_ENTRIES, ...FEED_ONLY_BLACKLIST]) {
    const row = map.get(normalizeCompany(name));
    assert.ok(row, `${name} not on the blacklist`);
    assert.equal(row.scope, 'company', `${name}: scope should be "company"`);
    assert.match(row.reason, /sector/i, `${name}: reason should name the sector`);
    assert.match(row.since, /^\d{4}-\d{2}-\d{2}$/, `${name}: since should be an ISO date`);
  }
});

test('blacklist keys use the same normalization scan.mjs matches postings with', () => {
  // A feed that writes "rolls royce plc" or "CHECKOUT.COM" must still hit.
  const map = loadBlacklist(BLACKLIST_PATH);
  assert.ok(map.has(normalizeCompany('Rolls Royce')));
  assert.ok(map.has(normalizeCompany('CHECKOUT.COM')));
  assert.ok(map.has(normalizeCompany('legal & general')));
});

test('every finance/insurance/defence entry in portals.yml is disabled', () => {
  for (const name of DISABLED_SECTOR_ENTRIES) {
    const entry = entryByName.get(normalizeCompany(name));
    assert.ok(entry, `${name} has no portals.yml entry (expected one, disabled)`);
    assert.equal(entry.enabled, false, `${name} is still enabled in portals.yml`);
  }
});

test('no enabled portals.yml entry is on the blacklist (config and blacklist agree)', () => {
  const map = loadBlacklist(BLACKLIST_PATH);
  const offenders = entries
    .filter(e => e.enabled !== false && map.has(normalizeCompany(e.name)))
    .map(e => e.name);
  assert.deepEqual(offenders, []);
});

test('the AI employers Jim wants are NOT blacklisted', () => {
  const map = loadBlacklist(BLACKLIST_PATH);
  for (const name of ['Google', 'Microsoft', 'OpenAI', 'Anthropic', 'Amazon', 'NVIDIA', 'DeepMind', 'Wayve']) {
    assert.ok(!map.has(normalizeCompany(name)), `${name} must not be blacklisted`);
  }
});
