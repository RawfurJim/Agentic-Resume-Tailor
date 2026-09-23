#!/usr/bin/env node
/**
 * prune-pipeline.mjs — drop expired postings from data/pipeline.md's Pending list.
 *
 * scan.mjs only ever ADDS to the Pending list. Employers close roles, so over
 * time the list fills with dead links. This script re-checks each unchecked
 * Pending URL and, when a posting is conclusively gone:
 *   - moves its line to `## Processed` as `- [x] ~~url | company | title~~`
 *     (the strikethrough form scan.mjs already recognises as processed), and
 *   - appends a `skipped_expired` row to data/scan-history.tsv so the dead URL
 *     stays deduped but no longer seeds the company+role key
 *     (an identical role re-opened later can therefore resurface).
 *
 * Liveness rungs — same as check-liveness.mjs:
 *   1. zero-token ATS API check (Greenhouse / Lever / Ashby / Workday ...)
 *   2. Playwright page check — only with --browser (needs Chromium installed)
 * Anything inconclusive is left in Pending untouched. Nothing is ever deleted.
 *
 * Usage:
 *   node prune-pipeline.mjs                 # API rung only; prints what would move, then moves it
 *   node prune-pipeline.mjs --dry-run       # report only, write nothing
 *   node prune-pipeline.mjs --browser       # also run the Playwright rung for non-ATS URLs (sequential)
 *   node prune-pipeline.mjs --throttle=5000 # jittered gap between browser checks
 *   node prune-pipeline.mjs --limit 50      # check at most N URLs this run (oldest first)
 */

import { existsSync, readFileSync } from 'fs';

import {
  PIPELINE_PATH, appendToScanHistory, atomicWriteFile,
} from './scan.mjs';
import { withPipelineLock } from './pipeline-lock.mjs';
import { checkLivenessViaApi } from './liveness-api.mjs';
import { flagValue, hasFlag, validateFlags } from './lib/cli-flags.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { localToday } from './lib/local-today.mjs';

const PENDING_RE = /^## (Pending|Pendientes)\s*$/m;
const PROCESSED_RE = /^## (Processed|Procesadas)\s*$/m;
const PENDING_LINE_RE = /^- \[ \]\s+(https?:\/\/[^\s|]+)(.*)$/;

/**
 * Split a pipeline line into its parts.
 * `- [ ] url | company | title | location | posted: 2026-01-01 | note: x`
 * @param {string} line
 * @returns {{url: string, company: string, title: string, location: string, line: string}|null}
 */
export function parsePendingLine(line) {
  const m = PENDING_LINE_RE.exec(line);
  if (!m) return null;
  const url = m[1];
  const rest = m[2].split('|').map(s => s.trim()).filter(Boolean);
  const positional = rest.filter(s => !/^(posted|trust|note|rank):\s/i.test(s));
  return {
    url,
    company: positional[0] || '',
    title: positional[1] || '',
    location: positional[2] || '',
    line,
  };
}

/**
 * Every unchecked Pending line, in file order.
 * @param {string} text
 */
export function pendingEntries(text) {
  const src = String(text ?? '');
  const start = src.search(PENDING_RE);
  if (start === -1) return [];
  const after = src.slice(start);
  const next = after.slice(3).search(/^## /m);
  const section = next === -1 ? after : after.slice(0, next + 3);
  return section.split(/\r?\n/).map(parsePendingLine).filter(Boolean);
}

/**
 * Move the given Pending lines into Processed, struck through. Pure.
 * @param {string} text  current pipeline.md
 * @param {Array<{line: string, url: string}>} expired
 * @param {string} [today]
 * @returns {string}
 */
export function applyPrune(text, expired, today = localToday()) {
  if (expired.length === 0) return text;
  const lines = String(text).split(/\r?\n/);
  const gone = new Set(expired.map(e => e.line));
  const moved = [];
  const kept = [];
  for (const l of lines) {
    if (gone.has(l)) {
      const body = l.replace(/^- \[ \]\s+/, '');
      // Keep url|company|title(|location) inside the strikethrough; labeled
      // segments (posted:, trust:, note:) ride outside so parsers still see them.
      const parts = body.split(' | ');
      const positional = [];
      const labeled = [];
      for (const p of parts) (/^(posted|trust|note|rank):\s/i.test(p) ? labeled : positional).push(p);
      moved.push(`- [x] ~~${positional.join(' | ')}~~${labeled.length ? ' | ' + labeled.join(' | ') : ''} | note: expired ${today}`);
    } else {
      kept.push(l);
    }
  }
  let out = kept.join('\n');
  const procIdx = out.search(PROCESSED_RE);
  if (procIdx === -1) {
    out = out.replace(/\s*$/, '') + '\n\n## Processed\n\n' + moved.join('\n') + '\n';
  } else {
    const headerEnd = out.indexOf('\n', procIdx);
    const insertAt = headerEnd === -1 ? out.length : headerEnd + 1;
    out = out.slice(0, insertAt) + '\n' + moved.join('\n') + '\n' + out.slice(insertAt);
  }
  return out;
}

const KNOWN_FLAGS = ['--dry-run', '--browser', '--throttle', '--limit', '--help', '-h'];
const USAGE = `Usage:
  node prune-pipeline.mjs [--dry-run] [--browser] [--throttle[=ms]] [--limit <n>]
  node prune-pipeline.mjs --help`;

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) { console.log(USAGE); return; }
  validateFlags(args.filter(a => !a.startsWith('--throttle=')), KNOWN_FLAGS, USAGE, { valueFlags: ['--limit'] });
  const dryRun = args.includes('--dry-run');
  const useBrowser = args.includes('--browser');
  const throttleArg = args.find(a => a === '--throttle' || a.startsWith('--throttle='));
  const throttleBaseMs = throttleArg ? (Number(throttleArg.split('=')[1]) || 5000) : 0;
  const limitRaw = flagValue(args, '--limit');
  if (hasFlag(args, '--limit') && !(Number(limitRaw) > 0)) { console.error('Error: --limit expects a positive number'); process.exit(1); }
  const limit = limitRaw ? Number(limitRaw) : Infinity;

  if (!existsSync(PIPELINE_PATH)) { console.error(`No pipeline at ${PIPELINE_PATH}`); process.exit(1); }
  const text = readFileSync(PIPELINE_PATH, 'utf-8');
  const entries = pendingEntries(text).slice(0, limit);
  console.log(`Checking ${entries.length} pending URL(s)${useBrowser ? ' (API, then Playwright)' : ' (API rung only — add --browser for non-ATS pages)'}${dryRun ? ' — dry run' : ''}\n`);

  let browser = null, page = null, headed = null, lb = null, chromium = null;
  async function ensureBrowser() {
    if (browser) return;
    ({ chromium } = await import('playwright'));
    lb = await import('./liveness-browser.mjs');
    browser = await chromium.launch({ headless: true });
    page = await lb.newLivenessPage(browser);
    headed = null; // headless only: unattended runs have no display
  }

  const expired = [];
  let active = 0, uncertain = 0, viaApi = 0;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    let result = 'uncertain', reason = 'no ATS API for this host', usedBrowser = false;
    const api = await checkLivenessViaApi(e.url);
    if (api) {
      ({ result, reason } = api); viaApi++;
    } else if (useBrowser) {
      await ensureBrowser();
      ({ result, reason } = await lb.checkUrlLivenessWithFallback(page, e.url, {}));
      usedBrowser = true;
    }
    const icon = { active: '✅', expired: '❌', uncertain: '⚠️' }[result] || '⚠️';
    console.log(`${icon} ${String(result).padEnd(10)} ${api ? '(api) ' : '      '}${e.company} | ${e.title}`);
    if (result !== 'active') console.log(`           ${reason}`);
    if (result === 'active') active++;
    else if (result === 'expired') expired.push(e);
    else uncertain++;
    if (usedBrowser && i < entries.length - 1 && throttleBaseMs) await lb.sleep(lb.jitteredDelayMs(throttleBaseMs));
  }
  if (browser) await browser.close();

  console.log(`\nResults: ${active} active  ${expired.length} expired  ${uncertain} uncertain  (${viaApi} via API)`);
  if (expired.length === 0 || dryRun) {
    if (dryRun && expired.length) console.log('(dry run — nothing written)');
    return;
  }
  const today = localToday();
  await withPipelineLock(PIPELINE_PATH, async () => {
    const current = readFileSync(PIPELINE_PATH, 'utf-8');
    atomicWriteFile(PIPELINE_PATH, applyPrune(current, expired, today));
  });
  await appendToScanHistory(
    expired.map(e => ({ url: e.url, title: e.title, company: e.company, location: e.location, source: 'prune-pipeline' })),
    today,
    'skipped_expired',
  );
  console.log(`Moved ${expired.length} expired posting(s) to ## Processed and recorded them in scan-history.tsv.`);
}

if (isMainModule(import.meta.url)) {
  main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
}
