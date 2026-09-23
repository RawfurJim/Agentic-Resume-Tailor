// full-description.mjs: the WHOLE job description behind a posting URL —
// Reed (per-job API → public page JSON-LD), Adzuna (details page → follow the
// land redirect to the employer's page → known ATS API or the page itself),
// anything else via fetchJdViaKnownApi. Round 6 (Jim, 2026-09-22): the CV
// matcher needs the full posting, and both aggregator APIs send ~500-char teasers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const {
  fetchFullDescription, sourceKind, reedJobId, adzunaAdId, isBetterText, extractDescriptionFromHtml,
  elementInnerHtml, followToPage, MAX_REDIRECT_HOPS, MIN_FULL_TEXT_CHARS,
} = await import('../full-description.mjs');
const { jsonLdNodes, jobPostingDescription } = await import('../providers/_jsonld.mjs');

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (name) => readFileSync(path.join(FIX, name), 'utf8');
const REED_URL = 'https://www.reed.co.uk/jobs/ai-engineer/57364884';
const ADZ_URL = 'https://www.adzuna.co.uk/jobs/land/ad/5893962963?se=6pKJkZW28RGP9pI-TYx0qg&utm_medium=api&utm_source=dc96cb17&v=666423A61D';
const TEASER = 'We have an exciting opportunity for a Senior AI Engineer (Manager) to join our IT (EA & Technology Platforms) team, based in Belfast. What you will do Reporting to the AI Platform Owner, this role will be a senior technical leader responsible for the strategy, design, and implementation of advanced AI and ML use cases across the firm. The role is a member of AI leadership and';
const LONG_HTML = '<p><b>Role</b></p><p>' + 'Build and ship machine learning systems in production. '.repeat(20) + '</p><ul><li>Python</li><li>PyTorch</li></ul>';
const ENV = { REED_API_KEY: 'k3y' };

// A 3xx under redirect:'manual' surfaces from providers/_http.mjs fetchResponse as a thrown error with status + location.
const redirectTo = (location, status = 302) => { const e = new Error(`HTTP ${status}`); e.status = status; e.location = location; return e; };
const httpError = (status) => { const e = new Error(`HTTP ${status}`); e.status = status; return e; };
const page = (html) => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
const never = async (url) => { throw new Error(`unexpected request ${url}`); };

test('sourceKind / ids: reed and adzuna URLs are recognised, everything else https is "other", non-https is null', () => {
  assert.equal(sourceKind(REED_URL), 'reed');
  assert.equal(sourceKind('https://reed.co.uk/jobs/57364884'), 'reed');
  assert.equal(reedJobId(new URL(REED_URL)), '57364884');
  assert.equal(reedJobId(new URL('https://www.reed.co.uk/jobs/ai-engineer-jobs')), '');
  assert.equal(sourceKind(ADZ_URL), 'adzuna');
  assert.equal(sourceKind('https://www.adzuna.com.au/jobs/details/123'), 'adzuna');
  assert.equal(adzunaAdId(new URL(ADZ_URL)), '5893962963');
  assert.equal(sourceKind('https://www.adzuna.co.uk/search?q=ai'), 'other');
  assert.equal(sourceKind('https://job-boards.greenhouse.io/acme/jobs/1'), 'other');
  assert.equal(sourceKind('http://www.reed.co.uk/jobs/x/1'), null);
  assert.equal(sourceKind('not a url'), null);
});

test('isBetterText: real (≥ 200 chars) and at least 10% longer than the teaser it replaces', () => {
  const full = 'x'.repeat(1000);
  assert.equal(isBetterText(full), true);
  assert.equal(isBetterText('x'.repeat(MIN_FULL_TEXT_CHARS - 1)), false);
  assert.equal(isBetterText(full, 'y'.repeat(500)), true);
  assert.equal(isBetterText('x'.repeat(520), 'y'.repeat(500)), false, 'same text with a few more chars is not the full posting');
  assert.equal(isBetterText(full, ''), true);
});

test('_jsonld: nodes flattened from bare / array / @graph shapes, nonce before type, bad JSON skipped; JobPosting description found', () => {
  const html = '<script nonce="n" type="application/ld+json">{"@type":"BreadcrumbList"}</script>'
    + '<script type="application/ld+json">[{"@type":"Organization"},{"@type":["JobPosting","Thing"],"description":"<p>Body A</p>"}]</script>'
    + '<script type="application/ld+json">{"@graph":[{"@type":"JobPosting","description":"Body B"}]}</script>'
    + '<script type="application/ld+json">{not json</script>';
  assert.equal(jsonLdNodes(html).length, 4);
  assert.equal(jobPostingDescription(html), '<p>Body A</p>');
  assert.equal(jobPostingDescription('<html></html>'), '');
  assert.equal(jobPostingDescription(null), '');
});

test('extractDescriptionFromHtml: Reed public page → the JSON-LD JobPosting body (real page saved 2026-09-22)', () => {
  const text = extractDescriptionFromHtml(fixture('reed-job-page.html'));
  assert.ok(text.length > 4000, `got ${text.length} chars`);
  assert.match(text, /Norton Rose Fulbright is a global law firm/);
  assert.match(text, /Role Purpose/);
  assert.doesNotMatch(text, /<p>|<br/);
  assert.doesNotMatch(text, /Apply now/, 'page chrome is not part of the description');
});

test('extractDescriptionFromHtml: Adzuna details page → the adp-body section only (no nav, sidebar, footer)', () => {
  const text = extractDescriptionFromHtml(fixture('adzuna-details.html'));
  assert.match(text, /^We have an exciting opportunity/);
  assert.match(text, /What you will have/);
  assert.match(text, /- Proficiency in programming languages such as Python, R, or C-Sharp\./);
  assert.match(text, /NO AGENCIES PLEASE/);
  assert.doesNotMatch(text, /Similar jobs|Salaries|Cookie policy|__ADZ__/);
});

test('extractDescriptionFromHtml: employer page without JSON-LD → the description container; nav/forms/footer/scripts never leak', () => {
  const text = extractDescriptionFromHtml(fixture('employer-page.html'));
  assert.match(text, /Job description/);
  assert.match(text, /What you will do[\s\S]*What you will have/);
  assert.match(text, /- Proven track record of managing large global teams\./);
  assert.doesNotMatch(text, /Skip to main content|Talent community|Search by keyword|dataLayer|Attorney advertising|Marketing Operations/);
});

test('extractDescriptionFromHtml: no container at all → stripped body text; too little text → ""', () => {
  const body = '<html><head><script>x()</script></head><body><nav>Home</nav><div><p>' + 'Real posting text here. '.repeat(20) + '</p></div><footer>foot</footer></body></html>';
  const text = extractDescriptionFromHtml(body);
  assert.match(text, /^Real posting text here\./);
  assert.doesNotMatch(text, /Home|foot|x\(\)/);
  assert.equal(extractDescriptionFromHtml('<html><body><p>tiny</p></body></html>'), '');
  assert.equal(extractDescriptionFromHtml(''), '');
  assert.equal(extractDescriptionFromHtml(undefined), '');
  assert.equal(extractDescriptionFromHtml('<p>' + 'x'.repeat(50_000) + '</p>', 1000).length, 1000, 'textCap honoured');
});

test('elementInnerHtml: nested same-name tags are balanced; unclosed → ""', () => {
  const html = '<div class="a"><div>in</div>tail</div><div>other</div>';
  assert.equal(elementInnerHtml(html, 0), '<div>in</div>tail');
  assert.equal(elementInnerHtml('<section><p>x</p>', 0), '');
});

// ── Reed ──────────────────────────────────────────────────────────────────

test('reed: the per-job API answers → clean text with bullets, via reed-detail-api, Basic auth with the key as username', async () => {
  const calls = [];
  const fetchJson = async (url, opts) => { calls.push({ url, opts }); return { jobId: 57364884, jobTitle: 'AI Engineer', jobDescription: LONG_HTML }; };
  const r = await fetchFullDescription(REED_URL, 20_000, 5_000, { env: ENV, fetchJson, fetchText: never, current: TEASER });
  assert.equal(r.via, 'reed-detail-api');
  assert.equal(r.title, 'AI Engineer');
  assert.match(r.text, /^Role\nBuild and ship machine learning systems/);
  assert.match(r.text, /\n- Python\n- PyTorch/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://www.reed.co.uk/api/1.0/jobs/57364884');
  assert.equal(calls[0].opts.headers.authorization, `Basic ${Buffer.from('k3y:').toString('base64')}`);
  assert.equal(calls[0].opts.redirect, 'error');
});

test('reed: API 401 (or no key) → the public page JSON-LD, via reed-page; both failing → null', async () => {
  const fetchText = async (url) => { assert.equal(url, REED_URL); return fixture('reed-job-page.html'); };
  const r = await fetchFullDescription(REED_URL, 20_000, 5_000, { env: ENV, fetchJson: async () => { throw httpError(401); }, fetchText, current: TEASER });
  assert.equal(r.via, 'reed-page');
  assert.match(r.text, /Norton Rose Fulbright/);

  const noKey = await fetchFullDescription(REED_URL, 20_000, 5_000, { env: {}, fetchJson: never, fetchText, current: TEASER });
  assert.equal(noKey.via, 'reed-page');

  const miss = await fetchFullDescription(REED_URL, 20_000, 5_000, { env: ENV, fetchJson: async () => { throw httpError(401); }, fetchText: async () => { throw httpError(500); } });
  assert.equal(miss, null);
});

test('reed: an API body no longer than the teaser is not an upgrade → falls to the page', async () => {
  const fetchJson = async () => ({ jobDescription: `<p>${TEASER}</p>` });
  const r = await fetchFullDescription(REED_URL, 20_000, 5_000, { env: ENV, fetchJson, fetchText: async () => fixture('reed-job-page.html'), current: TEASER });
  assert.equal(r.via, 'reed-page');
});

// ── Adzuna ────────────────────────────────────────────────────────────────

test('adzuna: the details page answers → adp-body text, via adzuna-details; the land redirect is never followed', async () => {
  const calls = [];
  const fetchText = async (url) => { calls.push(url); return fixture('adzuna-details.html'); };
  const r = await fetchFullDescription(ADZ_URL, 20_000, 5_000, { fetchText, fetchResponse: never, fetchKnownApi: never, current: TEASER });
  assert.equal(r.via, 'adzuna-details');
  assert.match(r.text, /What you will have/);
  assert.deepEqual(calls, ['https://www.adzuna.co.uk/jobs/details/5893962963']);
});

test('adzuna: details 403 + followRedirect → follow the land redirect hop by hop → employer page text, via source-page', async () => {
  const hops = [];
  const fetchResponse = async (url, opts) => {
    hops.push(url);
    assert.equal(opts.redirect, 'manual');
    if (url.startsWith('https://www.adzuna.co.uk/jobs/land/ad/')) throw redirectTo('https://click.appcast.io/track/abc?dest=x', 302);
    if (url === 'https://click.appcast.io/track/abc?dest=x') throw redirectTo('/jobs/10740BR/senior-ai-engineer', 301); // relative → resolved against the hop
    if (url === 'https://click.appcast.io/jobs/10740BR/senior-ai-engineer') throw redirectTo('https://careers.aoshearman.com/jobs/10740BR', 302);
    if (url === 'https://careers.aoshearman.com/jobs/10740BR') return page(fixture('employer-page.html'));
    throw httpError(404);
  };
  const r = await fetchFullDescription(ADZ_URL, 20_000, 5_000, {
    followRedirect: true, fetchText: async () => { throw httpError(403); }, fetchResponse, fetchKnownApi: async () => null, current: TEASER,
  });
  assert.equal(r.via, 'source-page');
  assert.match(r.text, /What you will do[\s\S]*Proven track record/);
  assert.equal(hops.length, 4);
  assert.equal(r.url, ADZ_URL, 'the stored URL stays the Adzuna link the ledger knows');
});

test('adzuna: the employer runs a known ATS → its public API wins over scraping the page, via source-api', async () => {
  const fetchResponse = async (url) => {
    if (url.startsWith('https://www.adzuna.co.uk/')) throw redirectTo('https://job-boards.greenhouse.io/acme/jobs/42');
    return page('<html><body><div id="app"></div></body></html>'); // JS-rendered shell
  };
  const fetchKnownApi = async (url) => { assert.equal(url, 'https://job-boards.greenhouse.io/acme/jobs/42'); return { url, title: 'AI Engineer', text: LONG_HTML.replace(/<[^>]+>/g, ' ') }; };
  const r = await fetchFullDescription(ADZ_URL, 20_000, 5_000, { detailsPage: false, followRedirect: true, fetchText: never, fetchResponse, fetchKnownApi, current: TEASER });
  assert.equal(r.via, 'source-api');
  assert.equal(r.title, 'AI Engineer');
});

test('adzuna: the land redirect is NOT followed by default (robots.txt disallows /jobs/land/ad/) — details page only', async () => {
  const fetchResponse = async () => { throw new Error('the land link must not be requested by default'); };
  const blocked = await fetchFullDescription(ADZ_URL, 20_000, 5_000, { fetchText: async () => { throw httpError(403); }, fetchResponse, fetchKnownApi: never, current: TEASER });
  assert.equal(blocked, null, 'details page down → teaser kept, no redirect chase');
  // opt-in: detailsPage off + followRedirect on → straight to the employer page
  const follow = async (url) => { if (url.startsWith('https://www.adzuna.co.uk/')) throw redirectTo('https://careers.example.com/j/1'); return page(fixture('employer-page.html')); };
  const r = await fetchFullDescription(ADZ_URL, 20_000, 5_000, { detailsPage: false, followRedirect: true, fetchText: never, fetchResponse: follow, fetchKnownApi: async () => null, current: TEASER });
  assert.equal(r.via, 'source-page');
});

test('adzuna: a redirect to http://, a private host, or more than MAX_REDIRECT_HOPS hops → null (teaser kept)', async () => {
  const to = (target) => async (url) => { if (url.startsWith('https://www.adzuna.co.uk/')) throw redirectTo(target); return page(fixture('employer-page.html')); };
  const opts = (fetchResponse) => ({ detailsPage: false, followRedirect: true, fetchText: never, fetchResponse, fetchKnownApi: never, current: TEASER });
  assert.equal(await fetchFullDescription(ADZ_URL, 20_000, 5_000, opts(to('http://careers.example.com/j/1'))), null, 'https only');
  assert.equal(await fetchFullDescription(ADZ_URL, 20_000, 5_000, opts(to('https://127.0.0.1/j/1'))), null, 'loopback rejected');
  assert.equal(await fetchFullDescription(ADZ_URL, 20_000, 5_000, opts(to('https://10.0.0.5/j/1'))), null, 'private range rejected');
  assert.equal(await fetchFullDescription(ADZ_URL, 20_000, 5_000, opts(to('https://169.254.169.254/latest/meta-data'))), null, 'link-local rejected');
  let n = 0;
  const loop = async () => { n++; throw redirectTo(`https://hop${n}.example.com/`); };
  assert.equal(await fetchFullDescription(ADZ_URL, 20_000, 5_000, opts(loop)), null);
  assert.equal(n, MAX_REDIRECT_HOPS + 1, 'gives up after the hop budget');
});

test('adzuna: a details URL (not land/ad) with the details page blocked → null, nothing to follow', async () => {
  const r = await fetchFullDescription('https://www.adzuna.co.uk/jobs/details/5893962963', 20_000, 5_000, { fetchText: async () => { throw httpError(403); }, fetchResponse: never, fetchKnownApi: never });
  assert.equal(r, null);
});

test('followToPage: a final non-2xx (404 after redirects) → null; the redirect chain is exposed for reuse', async () => {
  const fetchResponse = async (url) => { if (url.endsWith('/a')) throw redirectTo('https://x.example.com/b'); throw httpError(404); };
  assert.equal(await followToPage('https://x.example.com/a', { fetchResponse, timeoutMs: 1000 }), null);
  const ok = await followToPage('https://x.example.com/b', { fetchResponse: async () => page('<p>hi</p>'), timeoutMs: 1000 });
  assert.deepEqual(ok, { url: 'https://x.example.com/b', html: '<p>hi</p>' });
});

// ── other hosts ───────────────────────────────────────────────────────────

test('other host: routed to the known-ATS API fetcher, via "api"; a miss or a throw → null, never an exception', async () => {
  const gh = 'https://job-boards.greenhouse.io/acme/jobs/1';
  const r = await fetchFullDescription(gh, 20_000, 5_000, { fetchKnownApi: async (url, cap, ms) => { assert.equal(url, gh); assert.equal(cap, 20_000); assert.equal(ms, 5_000); return { url, title: 'T', text: 'x'.repeat(900), ats: 'greenhouse' }; } });
  assert.equal(r.via, 'api');
  assert.equal(r.title, 'T');
  assert.equal(await fetchFullDescription(gh, 20_000, 5_000, { fetchKnownApi: async () => null }), null);
  assert.equal(await fetchFullDescription(gh, 20_000, 5_000, { fetchKnownApi: async () => { throw new Error('boom'); } }), null);
  assert.equal(await fetchFullDescription('ftp://x', 20_000, 5_000, { fetchKnownApi: never }), null);
});

// ── Round 7 (Jim, 2026-09-23): details page 404-with-body, and the browser tier ──

test('adzuna: details page answers 404 but the HTML still carries the posting (expired ad) → text via adzuna-details', async () => {
  const fetchText = async () => { const e = httpError(404); e.body = fixture('adzuna-details.html'); throw e; };
  const r = await fetchFullDescription('https://www.adzuna.co.uk/jobs/details/5894005685?utm_medium=api', 20_000, 5_000, { fetchText, fetchResponse: never, fetchKnownApi: never, current: TEASER });
  assert.equal(r.via, 'adzuna-details');
  assert.match(r.text, /What you will have/);
});

test('adzuna: details page only has the snippet + browser:true → browserFetch(landUrl, {current, textCap, timeoutMs, fetchKnownApi}) → via browser', async () => {
  const calls = [];
  const browserFetch = async (url, opts) => { calls.push({ url, opts }); return { url, text: 'x'.repeat(3000), via: 'browser', finalUrl: 'https://careers.example.com/j/1' }; };
  const snippetPage = async () => fixture('adzuna-details.html').replace(/<section class="adp-body[\s\S]*?<\/section>/, `<section class="adp-body"><p>${TEASER}</p></section>`);
  const r = await fetchFullDescription(ADZ_URL, 20_000, 5_000, { browser: true, browserFetch, fetchText: snippetPage, fetchResponse: never, fetchKnownApi: never, current: TEASER });
  assert.equal(r.via, 'browser');
  assert.equal(r.url, ADZ_URL);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, ADZ_URL);
  assert.equal(calls[0].opts.current, TEASER);
  assert.equal(calls[0].opts.textCap, 20_000);
  assert.equal(typeof calls[0].opts.timeoutMs, 'number');
  assert.equal(typeof calls[0].opts.fetchKnownApi, 'function');
});

test('adzuna: the browser tier is off unless browser:true; never used for a non-land Adzuna URL; a throwing browserFetch → null', async () => {
  let called = 0;
  const browserFetch = async () => { called++; return { text: 'x'.repeat(3000), via: 'browser' }; };
  const blocked = async () => { throw httpError(403); };
  assert.equal(await fetchFullDescription(ADZ_URL, 20_000, 5_000, { browserFetch, fetchText: blocked, fetchResponse: never, fetchKnownApi: never, current: TEASER }), null);
  assert.equal(called, 0, 'default: no browser');
  assert.equal(await fetchFullDescription('https://www.adzuna.co.uk/jobs/details/5894005685', 20_000, 5_000, { browser: true, browserFetch, fetchText: blocked, fetchResponse: never, fetchKnownApi: never, current: TEASER }), null);
  assert.equal(called, 0, 'a details URL has no land link to open');
  assert.equal(await fetchFullDescription(ADZ_URL, 20_000, 5_000, { browser: true, browserFetch: async () => { throw new Error('chromium crashed'); }, fetchText: blocked, fetchResponse: never, fetchKnownApi: never, current: TEASER }), null);
});

test('adzuna: a full details page never reaches the browser (cheap route first)', async () => {
  let called = 0;
  const r = await fetchFullDescription(ADZ_URL, 20_000, 5_000, { browser: true, browserFetch: async () => { called++; return null; }, fetchText: async () => fixture('adzuna-details.html'), fetchResponse: never, fetchKnownApi: never, current: TEASER });
  assert.equal(r.via, 'adzuna-details');
  assert.equal(called, 0);
});

// ── 2026-09-23 (Jim: "google have no description"): a Google Careers posting page ──
// carries the whole job in its ds:0 init block (live postings) — or an ErrorDetails
// block when the posting was taken down (the AI Architect ad Jim saw, 105831148344484550).
const GOOGLE_URL = 'https://www.google.com/about/careers/applications/jobs/results/116637011183313606-research-engineer-responsible-frontier-ai-research-deepmind';

test('google: sourceKind recognises a Careers posting URL; the results list / other Google URLs stay "other"', () => {
  assert.equal(sourceKind(GOOGLE_URL), 'google');
  assert.equal(sourceKind('https://www.google.com/about/careers/applications/jobs/results/116637011183313606'), 'google');
  assert.equal(sourceKind('https://www.google.com/about/careers/applications/jobs/results/?q=AI'), 'other');
  assert.equal(sourceKind('https://www.google.com/search?q=jobs'), 'other');
});

test('google: the posting page ds:0 block → full description + title, via google-page; a removed posting → null', async () => {
  const calls = [];
  const fetchText = async (url) => { calls.push(url); return fixture('google-job-detail.html'); };
  const r = await fetchFullDescription(GOOGLE_URL, 20_000, 5_000, { fetchText, fetchKnownApi: never, fetchResponse: never });
  assert.ok(r, 'expected a result');
  assert.equal(r.via, 'google-page');
  assert.equal(r.title, 'Research Engineer, Responsible Frontier AI Research, DeepMind');
  assert.match(r.text, /Minimum qualifications/);
  assert.ok(r.text.length > 1000, `full text expected, got ${r.text.length}`);
  assert.deepEqual(calls, [GOOGLE_URL]);
  const gone = await fetchFullDescription(GOOGLE_URL, 20_000, 5_000, { fetchText: async () => fixture('google-job-removed.html'), fetchKnownApi: never, fetchResponse: never });
  assert.equal(gone, null, 'ErrorDetails block = posting removed → nothing to store');
  assert.equal(await fetchFullDescription(GOOGLE_URL, 20_000, 5_000, { fetchText: async () => { throw httpError(404); }, fetchKnownApi: never, fetchResponse: never }), null);
});
