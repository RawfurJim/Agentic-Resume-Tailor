import { test } from 'node:test';
import assert from 'node:assert/strict';

const { parsePendingLine, pendingEntries, applyPrune } = await import('../prune-pipeline.mjs');

const PIPE = `# Pipeline — Pending URLs

## Pending

- [ ] https://job-boards.greenhouse.io/acme/jobs/1 | Acme | AI Engineer | London, UK | posted: 2026-09-01
- [ ] https://jobs.ashbyhq.com/beta/2 | Beta | Data Scientist
- [x] https://jobs.ashbyhq.com/beta/3 | Beta | Done already

## Processed

- [x] ~~https://old.example/9 | Old | Role~~
`;

test('parsePendingLine splits positional and labeled segments', () => {
  const e = parsePendingLine('- [ ] https://x.y/1 | Acme | AI Engineer | London, UK | posted: 2026-09-01 | note: hi');
  assert.equal(e.url, 'https://x.y/1');
  assert.equal(e.company, 'Acme');
  assert.equal(e.title, 'AI Engineer');
  assert.equal(e.location, 'London, UK');
  assert.equal(parsePendingLine('- [x] https://x.y/1 | done'), null);
  assert.equal(parsePendingLine('random text'), null);
});
test('pendingEntries lists unchecked Pending lines only', () => {
  const es = pendingEntries(PIPE);
  assert.deepEqual(es.map(e => e.company), ['Acme', 'Beta']);
});
test('applyPrune moves expired lines to Processed, struck through, and leaves others', () => {
  const [acme] = pendingEntries(PIPE);
  const out = applyPrune(PIPE, [acme], '2026-09-21');
  assert.ok(!out.includes('- [ ] https://job-boards.greenhouse.io/acme/jobs/1'), 'removed from Pending');
  assert.ok(out.includes('- [ ] https://jobs.ashbyhq.com/beta/2 | Beta | Data Scientist'), 'other pending kept');
  assert.match(out, /## Processed\n\n- \[x\] ~~https:\/\/job-boards\.greenhouse\.io\/acme\/jobs\/1 \| Acme \| AI Engineer \| London, UK~~ \| posted: 2026-09-01 \| note: expired 2026-09-21/);
  assert.ok(out.includes('~~https://old.example/9 | Old | Role~~'), 'existing processed kept');
  assert.deepEqual(pendingEntries(out).map(e => e.company), ['Beta']);
});
test('applyPrune creates a Processed section when missing', () => {
  const noProc = PIPE.split('## Processed')[0];
  const [acme] = pendingEntries(noProc);
  const out = applyPrune(noProc, [acme], '2026-09-21');
  assert.match(out, /\n## Processed\n\n- \[x\] ~~https:\/\/job-boards/);
});
test('applyPrune with nothing expired is a no-op', () => {
  assert.equal(applyPrune(PIPE, []), PIPE);
});
