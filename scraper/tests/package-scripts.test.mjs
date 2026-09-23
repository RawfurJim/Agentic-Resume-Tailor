// Round 4 wiring: npm run scan:uk is the whole pipeline; the old chain survives as scan:uk:ats.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const envExample = readFileSync(path.join(root, '.env.example'), 'utf8');
const readme = readFileSync(path.join(root, 'README.md'), 'utf8');

test('package.json: scan:uk runs the orchestrator; the ATS-only chain and helpers exist', () => {
  assert.equal(pkg.scripts['scan:uk'], 'node run-all.mjs');
  assert.equal(pkg.scripts['scan:uk:ats'], 'node scan.mjs --quiet && node export-jobs.mjs && node export-new-jobs.mjs');
  assert.equal(pkg.scripts.indeed, 'node run-all.mjs --steps indeed');
  assert.equal(pkg.scripts.match, 'node run-all.mjs --steps match');
  assert.match(pkg.scripts['test:py'], /unittest discover -s match_job\/tests/);
});

test('.env.example documents the DeepSeek key, model and the PYTHON override', () => {
  assert.match(envExample, /^DEEPSEEK_API_KEY=/m);
  assert.match(envExample, /DEEPSEEK_MODEL=deepseek-flash/);
  assert.match(envExample, /^# PYTHON=/m);
});

test('README names the two hand-edited inputs and the 9 output columns (Match status only — round 7)', () => {
  assert.match(readme, /indeed_scrapper\/links\.txt/);
  assert.match(readme, /match_job\/cv\.txt/);
  assert.match(readme, /Description, Match status`/);
  assert.match(readme, /9 columns/);
  assert.doesNotMatch(readme, /Matching experience|Not matching experience/, 'the two dropped columns are gone from the docs');
  assert.match(readme, /--limit 3/);
});
