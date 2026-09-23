// browser-description.mjs (round 7, Jim 2026-09-23): the LAST resort for an Adzuna ad
// whose own details page only holds the ~400-char snippet. Adzuna's `land/ad` link is
// an HTTP 200 page with a 5 s meta-refresh to a click tracker (click.jobroute.io /
// click.appcast.io) that answers plain HTTP with a Cloudflare "Just a moment" challenge,
// so only a real browser reaches the employer's page. Jim accepted following that link
// (robots.txt disallows it) and the ~10–25 s per job. Chromium is never launched here:
// `launcher` is injected, `sleep`/`now` are a virtual clock.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  fetchViaBrowser, closeBrowser, isTrackerHost, looksLikeChallenge, routeDecision, CHALLENGE_MARKERS,
} = await import('../browser-description.mjs');

const LAND = 'https://www.adzuna.co.uk/jobs/land/ad/5893792295?se=2JlbM6C28RG6-LerT6N-jw&utm_medium=api';
const TEASER = 'hackajob is partnering directly with JPMorganChase to hire for this role. JOB DESCRIPTION Help shape how AI systems run reliably in production at scale. In this role you will apply strong engineering fundamentals and site reliability practices to cutting-edge AI platforms. You will work hands-on with cloud and Kubernetes-based deployme';
const FULL = TEASER + ' What you will do: ' + 'Build, observe and harden LLM serving platforms on Kubernetes. '.repeat(40);
const CHALLENGE = 'Just a moment... Enable JavaScript and cookies to continue';

/**
 * A fake Playwright: `states` is the sequence of {url, text, title} the page moves
 * through; every fake `sleep` advances one state (the meta-refresh, the tracker
 * hop, the employer page hydrating). `now` is a virtual clock driven by `sleep`.
 */
function fakeWorld(states, { failLaunch = false } = {}) {
  const w = { launches: 0, closed: 0, contexts: 0, contextsClosed: 0, routeHandler: null, gotos: [], clock: 0, idx: 0, states };
  const page = {
    async goto(url, opts) { w.gotos.push({ url, opts }); },
    url() { return w.states[Math.min(w.idx, w.states.length - 1)].url; },
    async evaluate() { const s = w.states[Math.min(w.idx, w.states.length - 1)]; return { title: s.title || '', text: s.text || '', anchors: [] }; },
    async waitForTimeout(ms) { w.clock += ms; },
    async close() {},
  };
  const context = {
    async route(pattern, handler) { w.routeHandler = handler; },
    async newPage() { return page; },
    async close() { w.contextsClosed++; },
  };
  const browser = {
    async newContext() { w.contexts++; return context; },
    async close() { w.closed++; },
  };
  w.launcher = async () => { w.launches++; if (failLaunch) throw new Error("browserType.launch: Executable doesn't exist"); return browser; };
  w.sleep = async (ms) => { w.clock += ms; w.idx++; };
  w.now = () => w.clock;
  w.opts = (extra = {}) => ({ launcher: w.launcher, sleep: w.sleep, now: w.now, current: TEASER, timeoutMs: 30_000, pollMs: 500, hydrationMs: 0, fetchKnownApi: async () => null, ...extra });
  return w;
}

const TRACKER = { url: 'https://click.jobroute.io/c/AB-Ct4JaSmCD', text: CHALLENGE };
const EMPLOYER = { url: 'https://careers.jpmorgan.com/jobs/210612345', title: 'Senior Lead SRE - LLM Ops', text: 'Careers\n' + FULL };

test('helpers: tracker hosts, challenge markers, route decisions (SSRF guard + no images/fonts/media)', () => {
  assert.equal(isTrackerHost('click.jobroute.io'), true);
  assert.equal(isTrackerHost('click.appcast.io'), true);
  assert.equal(isTrackerHost('click.example.com'), true, 'any click.* host is a tracker hop');
  assert.equal(isTrackerHost('www.adzuna.co.uk'), true, 'still on Adzuna = not settled');
  assert.equal(isTrackerHost('careers.jpmorgan.com'), false);
  assert.equal(looksLikeChallenge(CHALLENGE), true);
  assert.equal(looksLikeChallenge('appcast.io Please enable JS and disable any ad blocker'), true);
  assert.equal(looksLikeChallenge(FULL), false);
  assert.ok(Array.isArray(CHALLENGE_MARKERS) && CHALLENGE_MARKERS.length >= 3);
  assert.equal(routeDecision('http://127.0.0.1/x', 'document'), 'abort');
  assert.equal(routeDecision('https://169.254.169.254/latest', 'document'), 'abort');
  assert.equal(routeDecision('ftp://x.example.com/', 'document'), 'abort');
  assert.equal(routeDecision('https://x.example.com/logo.png', 'image'), 'abort');
  assert.equal(routeDecision('https://x.example.com/f.woff2', 'font'), 'abort');
  assert.equal(routeDecision('https://x.example.com/v.mp4', 'media'), 'abort');
  assert.equal(routeDecision('https://x.example.com/', 'document'), 'continue');
  assert.equal(routeDecision('https://x.example.com/app.js', 'script'), 'continue');
  assert.equal(routeDecision('https://x.example.com/api', 'xhr'), 'continue');
});

test('land → tracker challenge → employer page: returns the employer text, via browser; the route guard is installed', async () => {
  const w = fakeWorld([{ url: LAND, text: 'Redirecting you to the job…' }, TRACKER, TRACKER, EMPLOYER]);
  const r = await fetchViaBrowser(LAND, w.opts());
  assert.ok(r, 'expected a result');
  assert.equal(r.via, 'browser');
  assert.equal(r.url, LAND, 'the stored URL stays the Adzuna link the ledger knows');
  assert.equal(r.finalUrl, EMPLOYER.url);
  assert.equal(r.title, 'Senior Lead SRE - LLM Ops');
  assert.match(r.text, /What you will do: Build, observe and harden LLM serving platforms/);
  assert.equal(w.gotos.length, 1);
  assert.equal(w.gotos[0].url, LAND);
  assert.equal(typeof w.routeHandler, 'function', 'context.route(**/*) guard installed before navigation');
  assert.equal(w.contextsClosed, 1, 'the context is closed after the read');
  // the installed handler aborts private hosts and images, continues documents
  const calls = [];
  const fakeRoute = (url, type) => ({ request: () => ({ url: () => url, resourceType: () => type }), abort: (why) => calls.push(['abort', why]), continue: () => calls.push(['continue']) });
  await w.routeHandler(fakeRoute('http://10.0.0.5/x', 'document'));
  await w.routeHandler(fakeRoute('https://ok.example.com/a.png', 'image'));
  await w.routeHandler(fakeRoute('https://ok.example.com/', 'document'));
  assert.deepEqual(calls.map(c => c[0]), ['abort', 'abort', 'continue']);
  await closeBrowser();
});

test('stuck on the Cloudflare challenge until timeoutMs → null (teaser kept), no throw', async () => {
  const w = fakeWorld([{ url: LAND, text: '' }, TRACKER]); // never leaves the tracker
  const r = await fetchViaBrowser(LAND, w.opts({ timeoutMs: 5_000 }));
  assert.equal(r, null);
  assert.ok(w.clock >= 5_000, `waited out the budget (clock ${w.clock})`);
  assert.ok(w.clock < 5_000 + 2 * 500 + 1, 'and not much longer');
  await closeBrowser();
});

test('final page is private/loopback → null; final page text shorter than the teaser → null', async () => {
  const w1 = fakeWorld([{ url: LAND, text: '' }, { url: 'https://127.0.0.1/admin', text: FULL }]);
  assert.equal(await fetchViaBrowser(LAND, w1.opts()), null);
  const w2 = fakeWorld([{ url: LAND, text: '' }, { url: 'https://careers.example.com/j/1', text: 'Job expired.' }]);
  assert.equal(await fetchViaBrowser(LAND, w2.opts()), null);
  const w3 = fakeWorld([{ url: LAND, text: '' }, { url: 'https://careers.example.com/j/1', text: TEASER + ' plus a little' }]);
  assert.equal(await fetchViaBrowser(LAND, w3.opts()), null, 'not 10% longer than the teaser → not an upgrade');
  await closeBrowser();
});

test('employer runs a known ATS → fetchKnownApi(finalUrl) wins over the DOM, via browser-api', async () => {
  const GH = 'https://job-boards.greenhouse.io/acme/jobs/42';
  const w = fakeWorld([{ url: LAND, text: '' }, TRACKER, { url: GH, text: 'shell' }]);
  const seen = [];
  const fetchKnownApi = async (url) => { seen.push(url); return { url, title: 'AI Engineer', text: FULL, ats: 'greenhouse' }; };
  const r = await fetchViaBrowser(LAND, w.opts({ fetchKnownApi }));
  assert.equal(r.via, 'browser-api');
  assert.equal(r.title, 'AI Engineer');
  assert.deepEqual(seen, [GH]);
  await closeBrowser();
});

test('one shared browser per process: two fetches → one launch; closeBrowser() closes it; the next fetch relaunches', async () => {
  const w = fakeWorld([{ url: LAND, text: '' }, EMPLOYER]);
  await fetchViaBrowser(LAND, w.opts());
  w.idx = 0; w.clock = 0;
  await fetchViaBrowser(LAND, w.opts());
  assert.equal(w.launches, 1);
  assert.equal(w.contexts, 2, 'a fresh context per fetch');
  await closeBrowser();
  assert.equal(w.closed, 1);
  await closeBrowser();
  assert.equal(w.closed, 1, 'idempotent');
  w.idx = 0; w.clock = 0;
  await fetchViaBrowser(LAND, w.opts());
  assert.equal(w.launches, 2);
  await closeBrowser();
});

test('Playwright missing / launch fails → null, never a throw; textCap honoured', async () => {
  const w = fakeWorld([{ url: LAND, text: '' }, EMPLOYER], { failLaunch: true });
  assert.equal(await fetchViaBrowser(LAND, w.opts()), null);
  const w2 = fakeWorld([{ url: LAND, text: '' }, EMPLOYER]);
  const r = await fetchViaBrowser(LAND, w2.opts({ textCap: 600 }));
  assert.equal(r.text.length, 600);
  await closeBrowser();
});
