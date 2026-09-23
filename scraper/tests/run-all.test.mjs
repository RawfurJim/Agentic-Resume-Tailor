// run-all.mjs: the one command behind `npm run scan:uk` — Indeed (python) →
// scan.mjs → exports (in-process) → CV matcher (python). Nothing real is
// spawned here: every test injects a fake spawn and fake export helpers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { STEP_NAMES, resolvePython, parseSteps, pythonEnv, newestNewJobsCsv, splitForwardedArgs, runAll } =
  await import('../run-all.mjs');

test('STEP_NAMES: the canonical order', () => {
  assert.deepEqual(STEP_NAMES, ['indeed', 'scan', 'export', 'match']);
});

test('resolvePython: PYTHON from .env wins; otherwise per-platform candidates, first that runs', () => {
  const ok = () => true;
  assert.equal(resolvePython({ PYTHON: 'C:\\conda\\envs\\whisper-env\\python.exe' }, 'win32', ok), 'C:\\conda\\envs\\whisper-env\\python.exe');
  assert.equal(resolvePython({}, 'win32', ok), 'python');
  assert.equal(resolvePython({}, 'linux', ok), 'python3');
  assert.equal(resolvePython({}, 'win32', (cmd) => cmd === 'py'), 'py', 'Windows Store stub for python fails the probe → py');
  assert.equal(resolvePython({}, 'linux', (cmd) => cmd === 'python'), 'python');
  assert.equal(resolvePython({}, 'linux', () => false), null);
  assert.throws(() => resolvePython({ PYTHON: '/nope/python' }, 'linux', () => false), /PYTHON=\/nope\/python .*does not run/);
});

test('parseSteps: default all, subset in canonical order, unknown name → error', () => {
  assert.deepEqual(parseSteps([]).steps, STEP_NAMES);
  assert.deepEqual(parseSteps(['--steps', 'match,indeed']).steps, ['indeed', 'match']);
  assert.deepEqual(parseSteps(['--steps', 'scan, export']).steps, ['scan', 'export']);
  assert.match(parseSteps(['--steps', 'scan,linkedin']).error, /unknown step "linkedin".*indeed, scan, export, match/);
  assert.match(parseSteps(['--steps', '']).error, /--steps needs/);
});

test('pythonEnv: UTF-8 for the child, existing vars kept', () => {
  const env = pythonEnv({ PATH: '/bin', DEEPSEEK_API_KEY: 'k' });
  assert.equal(env.PATH, '/bin');
  assert.equal(env.DEEPSEEK_API_KEY, 'k');
  assert.equal(env.PYTHONUTF8, '1');
  assert.equal(env.PYTHONIOENCODING, 'utf-8');
});

test('newestNewJobsCsv: last new-jobs-*.csv by name, null when none', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'runall-'));
  assert.equal(newestNewJobsCsv(dir), null);
  assert.equal(newestNewJobsCsv(path.join(dir, 'missing')), null);
  for (const f of ['new-jobs-2026-09-21-190405.csv', 'new-jobs-2026-09-22-080000.csv', 'exported-urls.txt', 'other.csv']) writeFileSync(path.join(dir, f), '');
  assert.equal(newestNewJobsCsv(dir), path.join(dir, 'new-jobs-2026-09-22-080000.csv'));
});

test('splitForwardedArgs: everything after -- goes to the matcher untouched', () => {
  assert.deepEqual(splitForwardedArgs(['--steps', 'match', '--', '--limit', '3']), { own: ['--steps', 'match'], forwarded: ['--limit', '3'] });
  assert.deepEqual(splitForwardedArgs(['--dry-run']), { own: ['--dry-run'], forwarded: [] });
});

// ── runAll with fakes ────────────────────────────────────────────────────────
function fakes({ indeedStatus = 0, scanStatus = 0, matchStatus = 0, newRows = 1, indeedCounts = [2, 3], python = 'python3' } = {}) {
  const calls = [];
  const logs = [];
  let indeedReads = 0;
  const csvPath = newRows > 0 ? '/data/new-data/new-jobs-2026-09-22-101500.csv' : null;
  const deps = {
    python,
    spawn: (cmd, args, opts) => {
      calls.push({ cmd, args, cwd: opts?.cwd });
      const script = String(args[0] ?? '');
      if (script.endsWith('indeed_grab.py')) return { status: indeedStatus };
      if (script.endsWith('scan.mjs')) return { status: scanStatus };
      if (script.endsWith('match_jobs.py')) return { status: matchStatus };
      throw new Error(`unexpected spawn ${cmd} ${args.join(' ')}`);
    },
    readIndeedRows: () => Array.from({ length: indeedCounts[Math.min(indeedReads++, indeedCounts.length - 1)] }, (_, i) => ({ url: `https://uk.indeed.com/viewjob?jk=${i}` })),
    loadExportInputs: () => ({ historyText: 'h', pipelineText: '', titleFilter: () => true, descriptions: new Map() }),
    buildRows: ({ extraRows }) => [{ company: 'Acme', source: 'ashby-api', description: 'x' }, ...extraRows],
    writeExports: async (rows) => { calls.push({ cmd: 'writeExports', rows: rows.length }); return { csvPath: '/data/exports/uk-ai-jobs.csv', xlsxPath: '/data/exports/uk-ai-jobs.xlsx' }; },
    runNewExport: ({ dryRun, extraRows }) => { calls.push({ cmd: 'runNewExport', dryRun, extra: extraRows.length }); return { rows: Array.from({ length: newRows }, () => ({ company: 'Acme', source: 'indeed' })), skippedOld: [], csvPath: dryRun ? null : csvPath }; },
    log: (m) => logs.push(String(m)),
    newDir: '/data/new-data',
    exportsDir: '/data/exports',
  };
  return { deps, calls, logs, csvPath };
}
const byScript = (calls, name) => calls.filter(c => String(c.args?.[0] ?? c.cmd).endsWith(name));

test('runAll happy path: four steps, exports in-process with Indeed rows, matcher gets the new csv', async () => {
  const { deps, calls, logs, csvPath } = fakes();
  const r = await runAll({ steps: STEP_NAMES }, deps);
  assert.equal(r.exitCode, 0);
  assert.deepEqual(r.results.map(s => [s.name, s.status]), [['indeed', 'ok'], ['scan', 'ok'], ['export', 'ok'], ['match', 'ok']]);
  assert.equal(byScript(calls, 'indeed_grab.py').length, 1);
  assert.ok(byScript(calls, 'indeed_grab.py')[0].cwd.endsWith('indeed_scrapper'));
  assert.deepEqual(byScript(calls, 'scan.mjs')[0].args.slice(1), ['--quiet']);
  assert.equal(calls.find(c => c.cmd === 'writeExports').rows, 4, '1 ledger row + 3 Indeed rows');
  assert.equal(calls.find(c => c.cmd === 'runNewExport').extra, 3);
  const match = byScript(calls, 'match_jobs.py')[0];
  assert.equal(match.cmd, 'python3');
  assert.equal(match.args[1], csvPath);
  assert.equal(r.csvPath, csvPath);
  assert.ok(r.results[0].note.includes('+1'), `indeed note should report new rows: ${r.results[0].note}`);
  assert.ok(logs.some(l => /step 1\/4/.test(l)), logs.join('\n'));
});

test('runAll: Indeed failure is reported and the run continues; --strict aborts instead', async () => {
  let f = fakes({ indeedStatus: 1 });
  let r = await runAll({ steps: STEP_NAMES }, f.deps);
  assert.equal(r.results[0].status, 'failed');
  assert.deepEqual(r.results.slice(1).map(s => s.status), ['ok', 'ok', 'ok']);
  assert.equal(r.exitCode, 0, 'Indeed is optional');
  assert.ok(f.logs.some(l => /Indeed step failed.*continuing/i.test(l)), f.logs.join('\n'));

  f = fakes({ indeedStatus: 1 });
  r = await runAll({ steps: STEP_NAMES, strict: true }, f.deps);
  assert.equal(r.results[0].status, 'failed');
  assert.equal(byScript(f.calls, 'scan.mjs').length, 0);
  assert.notEqual(r.exitCode, 0);
});

test('runAll: scan failure stops everything after it and propagates the exit code', async () => {
  const { deps, calls } = fakes({ scanStatus: 3 });
  const r = await runAll({ steps: STEP_NAMES }, deps);
  assert.deepEqual(r.results.map(s => [s.name, s.status]), [['indeed', 'ok'], ['scan', 'failed'], ['export', 'not run'], ['match', 'not run']]);
  assert.equal(calls.filter(c => c.cmd === 'writeExports').length, 0);
  assert.equal(r.exitCode, 3);
});

test('runAll: no python → indeed and match skipped, scan and export still run', async () => {
  const { deps, calls, logs } = fakes({ python: null });
  const r = await runAll({ steps: STEP_NAMES }, deps);
  assert.deepEqual(r.results.map(s => s.status), ['skipped', 'ok', 'ok', 'skipped']);
  assert.equal(byScript(calls, 'indeed_grab.py').length, 0);
  assert.equal(byScript(calls, 'match_jobs.py').length, 0);
  assert.ok(logs.some(l => /no python found.*PYTHON/i.test(l)), logs.join('\n'));
  assert.equal(r.exitCode, 0);
});

test('runAll: zero new jobs → matcher not spawned', async () => {
  const { deps, calls } = fakes({ newRows: 0 });
  const r = await runAll({ steps: STEP_NAMES }, deps);
  assert.equal(byScript(calls, 'match_jobs.py').length, 0);
  assert.equal(r.results[3].status, 'skipped');
  assert.match(r.results[3].note, /no new jobs/);
  assert.equal(r.exitCode, 0);
});

test('runAll: matcher failure → warning with the rerun command, exit 1', async () => {
  const { deps, logs } = fakes({ matchStatus: 1 });
  const r = await runAll({ steps: STEP_NAMES }, deps);
  assert.equal(r.results[3].status, 'failed');
  assert.equal(r.exitCode, 1);
  assert.ok(logs.some(l => /npm run match -- --csv/.test(l)), logs.join('\n'));
});

test('runAll: --steps match alone uses --csv, else the newest new-jobs csv; forwarded args reach the matcher', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'runall-'));
  writeFileSync(path.join(dir, 'new-jobs-2026-09-22-080000.csv'), '');
  let f = fakes();
  let r = await runAll({ steps: ['match'], csv: '/tmp/given.csv', matchArgs: ['--limit', '3'] }, f.deps);
  assert.deepEqual(byScript(f.calls, 'match_jobs.py')[0].args.slice(1), ['/tmp/given.csv', '--limit', '3']);
  assert.equal(r.exitCode, 0);

  f = fakes();
  f.deps.newDir = dir;
  r = await runAll({ steps: ['match'] }, f.deps);
  assert.equal(byScript(f.calls, 'match_jobs.py')[0].args[1], path.join(dir, 'new-jobs-2026-09-22-080000.csv'));

  f = fakes();
  f.deps.newDir = path.join(dir, 'empty');
  r = await runAll({ steps: ['match'] }, f.deps);
  assert.equal(r.results[0].status, 'skipped');
  assert.match(r.results[0].note, /no new-jobs csv/);
});

test('runAll --dry-run: python steps only print their command, scan gets --dry-run, export writes nothing', async () => {
  const { deps, calls, logs } = fakes();
  const r = await runAll({ steps: STEP_NAMES, dryRun: true }, deps);
  assert.equal(byScript(calls, 'indeed_grab.py').length, 0);
  assert.equal(byScript(calls, 'match_jobs.py').length, 0);
  assert.deepEqual(byScript(calls, 'scan.mjs')[0].args.slice(1), ['--quiet', '--dry-run']);
  assert.equal(calls.filter(c => c.cmd === 'writeExports').length, 0);
  assert.equal(calls.find(c => c.cmd === 'runNewExport').dryRun, true);
  assert.ok(logs.some(l => /would run: python3 .*indeed_grab\.py/.test(l)), logs.join('\n'));
  assert.equal(r.exitCode, 0);
});

test('runAll: summary lists every step with its status', async () => {
  const { deps, logs } = fakes({ indeedStatus: 1 });
  await runAll({ steps: STEP_NAMES }, deps);
  const summary = logs.slice(logs.findIndex(l => /^Summary/.test(l)));
  assert.ok(summary.some(l => /indeed\s+failed/.test(l)), summary.join('\n'));
  assert.ok(summary.some(l => /match\s+ok/.test(l)), summary.join('\n'));
});

test('runAll: Indeed exit 3 (layout changed) is named in the summary note', async () => {
  const { deps, logs } = fakes({ indeedStatus: 3 });
  const r = await runAll({ steps: STEP_NAMES }, deps);
  assert.equal(r.results[0].status, 'failed');
  assert.match(r.results[0].note, /Indeed page layout probably changed.*indeed_scrapper\/debug/);
  assert.equal(r.exitCode, 0, 'still optional — the ATS scan ran');
  assert.ok(logs.some(l => /layout probably changed/.test(l)), logs.join('\n'));
});
