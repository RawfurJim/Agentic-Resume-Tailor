#!/usr/bin/env node
/**
 * fetch-jd.mjs — read a job description from its ATS's public API instead of
 * the rendered page (#2582).
 *
 * A headless caller that wants a JD today has one option: fetch the posting
 * page and strip HTML. That is 10-30k tokens of nav and markup on a
 * server-rendered board, and on a JS-rendered one (Ashby, Greenhouse's
 * embedded boards) it returns an unrendered shell — correctly detected as thin
 * and discarded — so the caller falls through to WebFetch, which hits the same
 * shell and fails the same way. Meanwhile the ATS's own public JSON endpoint,
 * the one liveness checks already use, ships the full JD body for free.
 *
 *   node fetch-jd.mjs <url>
 *   node fetch-jd.mjs --browser <url>   # round 7: also open an Adzuna land link in headless Chromium
 *
 * JD text on stdout, exit 0, when a known ATS answers with real content.
 * Exit 1 with empty stdout and no stderr noise otherwise — a miss is the
 * expected "fall back to the browser path" case, not an error condition, and
 * a visible miss is the whole point: never a fabricated JD.
 *
 * Coverage: JD_TEXT_API_ATS (liveness-api.mjs: Greenhouse, Lever, Ashby,
 * Workday) via fetchJdViaKnownApi() in browser-extract.mjs, plus — round 6,
 * 2026-09-22 — Reed postings (per-job API, then the public page) and Adzuna
 * `land/ad` links (Adzuna's details page, then the employer's page), all
 * through full-description.mjs — the same dispatch the scanner and the
 * backfill use, so the three cannot drift on where a full description lives.
 * A `via` note on stderr names the route that answered.
 */

import { fetchFullDescription } from './full-description.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import path from 'path';
import dotenv from 'dotenv';
import { getCareerOpsRoot } from './path-resolver.mjs';

// Standalone entry point: REED_API_KEY etc. live in .env (run-all.mjs loads it the same way).
dotenv.config({ path: path.join(getCareerOpsRoot(), '.env'), quiet: true });

const TEXT_CAP = 20_000; // a batch report reads the whole JD; no token-budget reason to cap tighter
const TIMEOUT_MS = 15_000;

async function main() {
  const argv = process.argv.slice(2);
  const browser = argv.includes('--browser');
  const url = argv.find((a) => !a.startsWith('--'));

  if (!url) {
    console.error('usage: node fetch-jd.mjs [--browser] <url>');
    process.exit(1);
  }

  let result;
  try {
    result = await fetchFullDescription(url, TEXT_CAP, TIMEOUT_MS, { browser });
    // `--browser` means "the best text there is": when Adzuna's details page only
    // returned the snippet (no teaser was given, so the 200-char floor let it
    // through), go through Chromium with that snippet as the bar to beat.
    if (browser && result && !String(result.via).startsWith('browser') && /\/jobs\/land\/ad\//.test(url)) {
      const better = await fetchFullDescription(url, TEXT_CAP, TIMEOUT_MS, { browser: true, detailsPage: false, current: result.text });
      if (better) result = better;
    }
  } finally {
    if (browser) { try { await (await import('./browser-description.mjs')).closeBrowser(); } catch { /* never launched */ } }
  }
  // No stderr, by design: the caller's browser/WebFetch fallback is the
  // intended next step, and warning on every non-covered host would make the
  // normal path look broken.
  if (!result) process.exit(1);

  if (result.via && result.via !== 'api') console.error(`via ${result.via}, ${result.text.length} chars`);
  const header = result.title ? `${result.title}\n\n` : '';
  process.stdout.write(header + result.text);
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(`fetch-jd: unexpected error — ${err?.message || err}`);
    process.exit(1);
  });
}
