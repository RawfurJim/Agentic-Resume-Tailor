#!/usr/bin/env node
/**
 * run-all.mjs — the one command behind `npm run scan:uk` (round 4, 2026-09-22).
 *
 *   1. indeed   python indeed_scrapper/indeed_grab.py   — the Indeed links Jim pasted
 *                into indeed_scrapper/links.txt, fetched through a visible Chrome.
 *                Optional: if it fails or Indeed blocks it, the run carries on.
 *   2. scan     node scan.mjs --quiet                    — every ATS board in portals.yml.
 *   3. export   in-process: data/exports/uk-ai-jobs.csv/.xlsx (everything kept so far,
 *                Indeed rows included) and data/new-data/new-jobs-<stamp>.csv (only
 *                jobs never handed out before, posted ≤ 5 days ago).
 *   4. match    python match_job/match_jobs.py <that csv> — DeepSeek scores each new
 *                job against match_job/cv.txt and adds one column:
 *                Match status (top match | medium match | low match).
 *
 * JavaScript and Python cooperate through child processes and csv files: Node
 * spawns the two Python scripts with their output wired to this console (the
 * Indeed script may ask you to click a "verify you are human" box), and the
 * csv written by step 3 is the hand-off to step 4.
 *
 * Usage:
 *   node run-all.mjs                         # all four steps
 *   node run-all.mjs --steps scan,export     # a subset, always in the order above
 *   node run-all.mjs --steps match --csv data/new-data/new-jobs-….csv -- --limit 3
 *                                            # re-run the matcher on one file; args after
 *                                            # `--` go to match_jobs.py untouched
 *   node run-all.mjs --dry-run               # print the python commands, scan --dry-run, write nothing
 *   node run-all.mjs --strict                # an Indeed failure aborts instead of continuing
 *
 * Python interpreter: PYTHON in .env if set (e.g. the Anaconda env that has
 * Playwright), else the first of `python`, `py` (Windows) / `python3`, `python`
 * (elsewhere) that runs. None found → the two Python steps are skipped and
 * the ATS scan + exports still run.
 */

import { spawnSync } from 'child_process';
import { existsSync, readdirSync } from 'fs';
import path from 'path';
import dotenv from 'dotenv';

import { getCareerOpsRoot } from './path-resolver.mjs';
import { flagValue, hasFlag, validateFlags } from './lib/cli-flags.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { buildRows, writeExports, loadExportInputs, reportExport } from './export-jobs.mjs';
import { runNewExport, reportNewExport, DEFAULT_NEW_DIR } from './export-new-jobs.mjs';
import { readIndeedRows } from './indeed-rows.mjs';

const ROOT = getCareerOpsRoot();
dotenv.config({ path: path.join(ROOT, '.env'), quiet: true });

export const STEP_NAMES = ['indeed', 'scan', 'export', 'match'];
export const INDEED_DIR = path.join(ROOT, 'indeed_scrapper');
export const INDEED_SCRIPT = path.join(INDEED_DIR, 'indeed_grab.py');
export const SCAN_SCRIPT = path.join(ROOT, 'scan.mjs');
export const MATCH_SCRIPT = path.join(ROOT, 'match_job', 'match_jobs.py');
export const EXPORTS_DIR = path.join(ROOT, 'data', 'exports');

const NEW_JOBS_RE = /^new-jobs-.*\.csv$/;
/** indeed_grab.py exits with this when every job page loaded but none could be parsed (LAYOUT_CHANGED_EXIT). */
export const INDEED_LAYOUT_CHANGED_EXIT = 3;

/** Does `cmd --version` run? Rejects the Windows Store "python" stub (non-zero exit). */
function defaultProbe(cmd) {
  try { return spawnSync(cmd, ['--version'], { stdio: 'ignore' }).status === 0; } catch { return false; }
}

/**
 * The Python interpreter to use, or null when none runs.
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [platform]
 * @param {(cmd: string) => boolean} [probe]
 */
export function resolvePython(env = process.env, platform = process.platform, probe = defaultProbe) {
  if (env.PYTHON) {
    if (probe(env.PYTHON)) return env.PYTHON;
    throw new Error(`PYTHON=${env.PYTHON} (from .env) does not run — fix the path or remove the line`);
  }
  const candidates = platform === 'win32' ? ['python', 'py'] : ['python3', 'python'];
  return candidates.find(probe) ?? null;
}

/**
 * `--steps a,b` → the chosen steps in canonical order. No flag → all four.
 * @param {string[]} args
 * @returns {{steps: string[], error?: string}}
 */
export function parseSteps(args) {
  if (!hasFlag(args, '--steps')) return { steps: [...STEP_NAMES] };
  const raw = flagValue(args, '--steps');
  const names = String(raw ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (names.length === 0) return { steps: [], error: `--steps needs a comma-separated list of: ${STEP_NAMES.join(', ')}` };
  const unknown = names.find(n => !STEP_NAMES.includes(n));
  if (unknown) return { steps: [], error: `unknown step "${unknown}" — choose from ${STEP_NAMES.join(', ')}` };
  return { steps: STEP_NAMES.filter(s => names.includes(s)) };
}

/** Child environment: force UTF-8 so titles with curly quotes survive a Windows console. */
export function pythonEnv(env = process.env) {
  return { ...env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };
}

/** The most recent data/new-data/new-jobs-*.csv (names sort chronologically), or null. */
export function newestNewJobsCsv(dir = DEFAULT_NEW_DIR) {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter(f => NEW_JOBS_RE.test(f)).sort();
  return files.length ? path.join(dir, files[files.length - 1]) : null;
}

/** Split argv at `--`: our flags before it, the matcher's after it. */
export function splitForwardedArgs(argv) {
  const i = argv.indexOf('--');
  return i === -1 ? { own: argv, forwarded: [] } : { own: argv.slice(0, i), forwarded: argv.slice(i + 1) };
}

/**
 * Run a child whose console we share, letting Ctrl+C reach the child (which
 * saves its work and exits) instead of killing this process mid-pipeline.
 */
function spawnInteractive(spawn, cmd, args, opts) {
  const ignore = () => {};
  process.on('SIGINT', ignore);
  try { return spawn(cmd, args, { stdio: 'inherit', ...opts }); } finally { process.removeListener('SIGINT', ignore); }
}

function describe(result) {
  if (result?.error) return result.error.code === 'ENOENT' ? 'command not found' : (result.error.message || String(result.error));
  return `exit ${result?.status ?? '?'}`;
}

const fmtSeconds = (ms) => `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;

/**
 * Run the pipeline. Every side effect goes through `deps` so tests can fake it.
 * @param {{steps?: string[], dryRun?: boolean, strict?: boolean, csv?: string|null, matchArgs?: string[]}} opts
 * @param {Partial<{spawn: typeof spawnSync, python: string|null, readIndeedRows: Function, loadExportInputs: Function,
 *          buildRows: Function, writeExports: Function, runNewExport: Function, log: Function, newDir: string, exportsDir: string}>} [deps]
 * @returns {Promise<{results: Array<{name: string, status: string, note: string}>, exitCode: number, csvPath: string|null}>}
 */
export async function runAll({ steps = STEP_NAMES, dryRun = false, strict = false, csv = null, matchArgs = [] } = {}, deps = {}) {
  const d = {
    spawn: spawnSync, python: undefined, readIndeedRows, loadExportInputs, buildRows, writeExports, runNewExport,
    log: console.log, newDir: DEFAULT_NEW_DIR, exportsDir: EXPORTS_DIR, ...deps,
  };
  if (d.python === undefined) d.python = resolvePython();
  const log = d.log;
  const noPython = 'no python found — set PYTHON in .env to your interpreter';

  const results = STEP_NAMES.filter(s => steps.includes(s)).map(name => ({ name, status: 'not run', note: '' }));
  let exitCode = 0;
  let aborted = false;
  let csvPath = csv || null;
  let newRowCount = null;
  const started = Date.now();

  for (let i = 0; i < results.length && !aborted; i++) {
    const step = results[i];
    log(`\n── step ${i + 1}/${results.length}: ${step.name} ──`);
    const t0 = Date.now();

    if (step.name === 'indeed') {
      if (!d.python) { step.status = 'skipped'; step.note = noPython; log(`Indeed: skipped — ${noPython}`); }
      else if (dryRun) { step.status = 'ok'; step.note = 'dry run'; log(`would run: ${d.python} ${INDEED_SCRIPT}`); }
      else {
        const before = d.readIndeedRows().length;
        const r = spawnInteractive(d.spawn, d.python, [INDEED_SCRIPT], { cwd: INDEED_DIR, env: pythonEnv() });
        const after = d.readIndeedRows().length;
        if (r?.error || r?.status !== 0) {
          step.status = 'failed';
          step.note = r?.status === INDEED_LAYOUT_CHANGED_EXIT
            ? 'Indeed page layout probably changed — see indeed_scrapper/debug/ (exit 3)'
            : describe(r);
          if (strict) { exitCode = 1; aborted = true; log(`Indeed step failed (${step.note}) — aborting (--strict)`); }
          else log(`Indeed step failed (${step.note}); continuing with the ATS scan`);
        } else { step.status = 'ok'; step.note = `+${after - before} job(s) in indeed_scrapper/jobs.csv`; }
      }
    } else if (step.name === 'scan') {
      const args = [SCAN_SCRIPT, '--quiet', ...(dryRun ? ['--dry-run'] : [])];
      const r = d.spawn(process.execPath, args, { stdio: 'inherit', cwd: ROOT });
      if (r?.error || r?.status !== 0) {
        step.status = 'failed'; step.note = describe(r);
        exitCode = r?.status || 1; aborted = true;
        log(`scan.mjs failed (${step.note}) — stopping; nothing exported`);
      } else step.status = 'ok';
    } else if (step.name === 'export') {
      try {
        const inputs = d.loadExportInputs();
        const extraRows = d.readIndeedRows();
        if (dryRun) log('dry run — uk-ai-jobs.csv/.xlsx not rewritten');
        else {
          const rows = d.buildRows({ ...inputs, extraRows });
          reportExport(rows, await d.writeExports(rows, d.exportsDir), log);
        }
        const res = d.runNewExport({ ...inputs, extraRows, newDir: d.newDir, dryRun });
        reportNewExport(res, { dryRun, log });
        newRowCount = res.rows.length;
        if (!csvPath && res.csvPath) csvPath = res.csvPath;
        step.status = 'ok';
        step.note = `${res.rows.length} new job(s)${res.csvPath ? ` → ${path.basename(res.csvPath)}` : ''}`;
      } catch (err) {
        step.status = 'failed'; step.note = err.message; exitCode = 1; aborted = true;
        log(`export failed: ${err.message}`);
      }
    } else if (step.name === 'match') {
      if (!steps.includes('export') && !csvPath) csvPath = newestNewJobsCsv(d.newDir);
      if (!d.python) { step.status = 'skipped'; step.note = noPython; log(`match: skipped — ${noPython}`); }
      else if (steps.includes('export') && newRowCount === 0) { step.status = 'skipped'; step.note = 'no new jobs — matcher skipped'; log('No new jobs — matcher skipped'); }
      else if (!csvPath && !dryRun) { step.status = 'skipped'; step.note = `no new-jobs csv in ${d.newDir}`; log(`match: skipped — ${step.note}`); }
      else if (dryRun) { step.status = 'ok'; step.note = 'dry run'; log(`would run: ${d.python} ${MATCH_SCRIPT} ${csvPath ?? '<new-jobs csv>'} ${matchArgs.join(' ')}`.trim()); }
      else {
        const r = spawnInteractive(d.spawn, d.python, [MATCH_SCRIPT, csvPath, ...matchArgs], { cwd: ROOT, env: pythonEnv() });
        if (r?.error || r?.status !== 0) {
          step.status = 'failed'; step.note = describe(r); exitCode = 1;
          log(`The new-jobs csv is written but matching failed (${step.note}) — rerun: npm run match -- --csv "${csvPath}"`);
        } else { step.status = 'ok'; step.note = path.basename(csvPath); }
      }
    }
    if (step.status !== 'not run') step.note = `${step.note}${step.note ? ' ' : ''}(${fmtSeconds(Date.now() - t0)})`.trim();
  }

  log('');
  log(`Summary (${fmtSeconds(Date.now() - started)})`);
  for (const s of results) log(`  ${s.name.padEnd(8)} ${s.status.padEnd(8)} ${s.note}`);
  return { results, exitCode, csvPath };
}

const KNOWN_FLAGS = ['--steps', '--csv', '--dry-run', '--strict', '--help', '-h'];
const USAGE = `Usage:
  node run-all.mjs [--steps <a,b,..>] [--csv <file>] [--dry-run] [--strict] [-- <matcher args>]
  node run-all.mjs --help

  steps (always in this order): ${STEP_NAMES.join(', ')}
  --csv <file>   the new-jobs csv the matcher should score (default: the one this run writes,
                 or the newest in data/new-data when export is not among the steps)
  --dry-run      print the python commands, scan with --dry-run, write nothing
  --strict       an Indeed failure aborts the run instead of continuing
  -- <args>      passed to match_jobs.py, e.g.  -- --limit 3`;

async function main() {
  const { own, forwarded } = splitForwardedArgs(process.argv.slice(2));
  if (own.includes('--help') || own.includes('-h')) { console.log(USAGE); return; }
  validateFlags(own, KNOWN_FLAGS, USAGE, { valueFlags: ['--steps', '--csv'] });
  const { steps, error } = parseSteps(own);
  if (error) { console.error(`Error: ${error}\n\n${USAGE}`); process.exit(1); }
  if (hasFlag(own, '--csv') && !flagValue(own, '--csv')) { console.error('Error: --csv requires a file'); process.exit(1); }
  let python;
  try { python = resolvePython(); } catch (err) { console.error(`Error: ${err.message}`); process.exit(1); }
  const { exitCode } = await runAll({
    steps, dryRun: own.includes('--dry-run'), strict: own.includes('--strict'),
    csv: flagValue(own, '--csv') || null, matchArgs: forwarded,
  }, { python });
  process.exit(exitCode);
}

if (isMainModule(import.meta.url)) {
  main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
}
