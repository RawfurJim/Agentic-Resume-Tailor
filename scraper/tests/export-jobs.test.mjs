import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';

const { parseScanHistory, pendingUrls, buildRows, toCsv, writeExports, EXPORT_COLUMNS } = await import('../export-jobs.mjs');

const HEADER = 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\tlocation\tfingerprint\tposted_at\ttrust_score\ttrust_flags\tnormalized_company\n';
const TSV = HEADER
  + 'https://job-boards.greenhouse.io/anthropic/jobs/1\t2026-09-18\tgreenhouse-api\tForward Deployed Engineer\tAnthropic\tadded\tLondon, UK\t\t2026-09-14\t\t\tanthropic\n'
  + 'https://www.google.com/about/careers/applications/jobs/results/2-x\t2026-09-21\tgoogle-api\tData Scientist, "Ads"\tGoogle\tadded\tLondon, UK · Dublin, Ireland\t\t2026-09-18\t\t\tgoogle\n'
  + 'https://jobs.ashbyhq.com/openai/3\t2026-09-21\tashby-api\tML Engineer\tOpenAI\tadded\tDublin, Ireland\t\t\t\t\topenai\n'
  + 'https://jobs.ashbyhq.com/openai/4\t2026-09-21\tashby-api\tOld role\tOpenAI\tskipped_expired\tLondon\t\t\t\t\topenai\n'
  + 'garbage line without tabs\n';
const PIPELINE = `# Pipeline — Pending URLs

## Pending

- [ ] https://job-boards.greenhouse.io/anthropic/jobs/1 | Anthropic | Forward Deployed Engineer | London, UK
- [x] https://jobs.ashbyhq.com/openai/3 | OpenAI | ML Engineer

## Processed

- [ ] https://www.google.com/about/careers/applications/jobs/results/2-x | Google | Data Scientist
`;

test('parseScanHistory skips header and malformed lines', () => {
  const rows = parseScanHistory(TSV);
  assert.equal(rows.length, 4);
  assert.equal(rows[0].company, 'Anthropic');
  assert.equal(rows[1].location, 'London, UK · Dublin, Ireland');
});
test('pendingUrls reads only unchecked lines under ## Pending', () => {
  const p = pendingUrls(PIPELINE);
  assert.equal(p.size, 1);
  assert.ok([...p][0].includes('anthropic/jobs/1'));
});
test('buildRows keeps added only, newest first, flags in_pipeline', () => {
  const rows = buildRows({ historyText: TSV, pipelineText: PIPELINE, today: '2026-09-21' });
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map(r => r.first_seen), ['2026-09-21', '2026-09-21', '2026-09-18']);
  assert.equal(rows.find(r => r.company === 'Anthropic').in_pipeline, 'yes');
  assert.equal(rows.find(r => r.company === 'Google').in_pipeline, 'no');
});
test('buildRows --since and --pending-only', () => {
  assert.equal(buildRows({ historyText: TSV, pipelineText: PIPELINE, sinceDays: 1, today: '2026-09-21' }).length, 2);
  assert.equal(buildRows({ historyText: TSV, pipelineText: PIPELINE, pendingOnly: true, today: '2026-09-21' }).length, 1);
});
test('buildRows re-applies the current title filter so a tightened portals.yml cleans old rows', () => {
  const rejectMl = (title, company) => !/^ML Engineer$/.test(title) || company !== 'OpenAI';
  const rows = buildRows({ historyText: TSV, pipelineText: PIPELINE, today: '2026-09-21', titleFilter: rejectMl });
  assert.deepEqual(rows.map(r => r.title), ['Data Scientist, "Ads"', 'Forward Deployed Engineer']);
  // no filter passed → every added row, as before
  assert.equal(buildRows({ historyText: TSV, pipelineText: PIPELINE, today: '2026-09-21' }).length, 3);
});
test('toCsv quotes commas and double quotes', () => {
  const csv = toCsv(buildRows({ historyText: TSV, pipelineText: PIPELINE, today: '2026-09-21' }));
  const lines = csv.trim().split('\r\n');
  assert.equal(lines.length, 4);
  assert.equal(lines[0], 'Company,Title,Location,URL,Source,Posted,First seen,Description');
  assert.ok(lines.some(l => l.includes('"Data Scientist, ""Ads"""')), 'title with comma+quotes is quoted');
});
// Round 3 (Jim): exactly the columns he asked for — company, title, location,
// link, source, posted date, seen date, job description. Internal columns gone.
test('EXPORT_COLUMNS is the agreed 8-column contract', () => {
  assert.deepEqual(EXPORT_COLUMNS.map(c => c.header), ['Company', 'Title', 'Location', 'URL', 'Source', 'Posted', 'First seen', 'Description']);
});
test('buildRows joins the description store on the normalized URL; unknown → empty string', () => {
  const descriptions = new Map([
    ['https://jobs.ashbyhq.com/openai/3', 'Line one.\n\nLine "two", with comma.'],
  ]);
  const rows = buildRows({ historyText: TSV, pipelineText: PIPELINE, today: '2026-09-21', descriptions });
  assert.equal(rows.find(r => r.company === 'OpenAI').description, 'Line one.\n\nLine "two", with comma.');
  assert.equal(rows.find(r => r.company === 'Google').description, '');
  const csv = toCsv(rows);
  assert.ok(csv.includes('"Line one.\n\nLine ""two"", with comma."'), 'multi-line description is one quoted cell');
  // rows are \r\n-separated; the description's own \n stays inside its quoted cell, as the last column
  const openaiLine = csv.split('\r\n').find(l => l.startsWith('OpenAI,'));
  assert.ok(openaiLine.endsWith(',"Line one.\n\nLine ""two"", with comma."'), 'description is the last column');
});
test('writeExports: when Excel holds the .xlsx open (EBUSY) the csv is still written and xlsxPath is null', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'export-jobs-'));
  const rows = buildRows({ historyText: TSV, pipelineText: PIPELINE, today: '2026-09-21' });
  const busy = Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
  const warnings = [];
  const { csvPath, xlsxPath } = await writeExports(rows, dir, 'uk-ai-jobs', {
    writeXlsx: async () => { throw busy; }, warn: (m) => warnings.push(m),
  });
  assert.ok(readFileSync(csvPath, 'utf8').startsWith('Company,Title'));
  assert.equal(xlsxPath, null);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /uk-ai-jobs\.xlsx is open in Excel/);
  // any other error still propagates
  await assert.rejects(writeExports(rows, dir, 'uk-ai-jobs', { writeXlsx: async () => { throw new Error('disk on fire'); } }), /disk on fire/);
});
test('writeExports: a locked csv (EACCES via the Windows share) is reported too, the xlsx is still written', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'export-jobs-'));
  const rows = buildRows({ historyText: TSV, pipelineText: PIPELINE, today: '2026-09-21' });
  const locked = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
  const warnings = [];
  const { csvPath, xlsxPath } = await writeExports(rows, dir, 'uk-ai-jobs', {
    writeCsv: () => { throw locked; }, warn: (m) => warnings.push(m),
  });
  assert.equal(csvPath, null);
  assert.ok(xlsxPath && readFileSync(xlsxPath).length > 0);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /uk-ai-jobs\.csv is open in Excel/);
});
test('writeExports produces an xlsx with Jobs + Summary sheets and a csv', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'export-jobs-'));
  const rows = buildRows({ historyText: TSV, pipelineText: PIPELINE, today: '2026-09-21' });
  const { csvPath, xlsxPath } = await writeExports(rows, dir);
  assert.ok(readFileSync(csvPath, 'utf8').startsWith('Company,Title'));
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(xlsxPath);
  const jobs = wb.getWorksheet('Jobs');
  assert.ok(jobs);
  assert.equal(jobs.rowCount, 4); // header + 3
  const link = jobs.getRow(2).getCell(4).value;
  assert.ok(link && typeof link === 'object' && 'hyperlink' in link, 'URL cell is a hyperlink');
  assert.equal(jobs.getRow(1).getCell(8).value, 'Description');
  const align = jobs.getRow(2).getCell(8).alignment || {};
  assert.equal(align.vertical, 'top');
  assert.ok(!align.wrapText, 'description cells do not wrap (one line per job)');
  assert.ok(wb.getWorksheet('Summary'));
});

// ── Round 4 (2026-09-22): hand-picked Indeed jobs ride along as `extraRows` ──
const { loadExportInputs } = await import('../export-jobs.mjs');
const indeedRow = (jk, date, title = 'Warehouse Operative', extra = {}) => ({
  company: 'Acme', title, location: 'Leeds', url: `https://uk.indeed.com/viewjob?jk=${jk}`,
  posted_at: date, first_seen: date, source: 'indeed', status: 'added', in_pipeline: 'no', trust_score: '',
  description: 'Title: X\n\n---\n\nbody', ...extra,
});

test('buildRows extraRows: included with Source indeed, NOT subject to the title filter, sorted with the rest', () => {
  const onlyAi = (title) => /AI|ML|Data Scientist|Forward Deployed/i.test(title);
  const rows = buildRows({ historyText: TSV, titleFilter: onlyAi, today: '2026-09-22',
    extraRows: [indeedRow('aaaaaaaa11111111', '2026-09-22'), indeedRow('bbbbbbbb22222222', '2026-09-10')] });
  const indeed = rows.filter(r => r.source === 'indeed');
  assert.equal(indeed.length, 2, 'both Indeed rows kept although "Warehouse Operative" fails the title filter');
  assert.equal(rows[0].url, 'https://uk.indeed.com/viewjob?jk=aaaaaaaa11111111', 'newest first across sources');
  assert.equal(rows[rows.length - 1].url, 'https://uk.indeed.com/viewjob?jk=bbbbbbbb22222222');
  assert.ok(rows.filter(r => r.source !== 'indeed').every(r => onlyAi(r.title)), 'ledger rows still filtered');
});

test('buildRows extraRows: a URL already in the ledger is not duplicated (ledger row wins)', () => {
  const dup = { ...indeedRow('x', '2026-09-22'), url: 'https://jobs.ashbyhq.com/openai/3/?utm_source=indeed', company: 'Indeed copy' };
  const rows = buildRows({ historyText: TSV, extraRows: [dup] });
  const hits = rows.filter(r => r.url.includes('openai/3'));
  assert.equal(hits.length, 1);
  assert.equal(hits[0].company, 'OpenAI');
});

test('buildRows extraRows: --since cutoff applies to Indeed rows too; default extraRows is none', () => {
  const rows = buildRows({ historyText: TSV, today: '2026-09-22', sinceDays: 3,
    extraRows: [indeedRow('aaaaaaaa11111111', '2026-09-22'), indeedRow('bbbbbbbb22222222', '2026-09-01')] });
  assert.deepEqual(rows.filter(r => r.source === 'indeed').map(r => r.url.slice(-16)), ['aaaaaaaa11111111']);
  assert.equal(buildRows({ historyText: TSV }).filter(r => r.source === 'indeed').length, 0);
});

test('toCsv: an Indeed row prints Source indeed and the clean viewjob URL', () => {
  const csv = toCsv([indeedRow('aaaaaaaa11111111', '2026-09-22', 'AI Engineer')]);
  assert.ok(csv.includes('Acme,AI Engineer,Leeds,https://uk.indeed.com/viewjob?jk=aaaaaaaa11111111,indeed,2026-09-22,2026-09-22,'), csv);
});

test('loadExportInputs: reads ledger + pipeline + descriptions + current title filter; clear error when the ledger is missing', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'inputs-'));
  const historyPath = path.join(dir, 'scan-history.tsv');
  assert.throws(() => loadExportInputs({ historyPath }), /No scan history at .*scan-history\.tsv.*run node scan\.mjs first/);
  const { writeFileSync } = await import('node:fs');
  writeFileSync(historyPath, TSV);
  writeFileSync(path.join(dir, 'job-descriptions.jsonl'), JSON.stringify({ url: 'https://jobs.ashbyhq.com/openai/3', text: 'Build agents.' }) + '\n');
  const inputs = loadExportInputs({ historyPath, pipelinePath: path.join(dir, 'missing.md'), descriptionsPath: path.join(dir, 'job-descriptions.jsonl'), portalsPath: path.join(dir, 'missing.yml') });
  assert.equal(inputs.historyText, TSV);
  assert.equal(inputs.pipelineText, '');
  assert.equal(typeof inputs.titleFilter, 'function');
  assert.equal(inputs.titleFilter('anything', 'x', 'x'), true, 'no portals.yml → keep everything');
  assert.equal(inputs.descriptions.get('https://jobs.ashbyhq.com/openai/3'), 'Build agents.');
});

// Round 5 (Jim, 2026-09-22): a job with no description is still exported with
// its title and link — Microsoft rows had an empty Description for a day and
// must never be dropped for it.
test('buildRows keeps a row whose description is unknown: title + URL present, Description empty', () => {
  const rows = buildRows({ historyText: TSV, pipelineText: PIPELINE, today: '2026-09-21', descriptions: new Map() });
  assert.equal(rows.length, 3);
  for (const r of rows) {
    assert.ok(r.title && r.url, 'title and link present');
    assert.equal(r.description, '');
  }
});

// ── 2026-09-23 (Jim): "block eFinancialCareers — no finance, bank, insurance jobs" ──
// The scan already skips blacklisted companies; the exporters now do too, so a
// name added to data/blacklist.md disappears from uk-ai-jobs.csv and the new-jobs
// feed on the next export, without touching the append-only ledger.
test('buildRows drops rows whose company is on the blacklist (normalised match)', async () => {
  const { normalizeCompany } = await import('../tracker-utils.mjs');
  const tsv = TSV + 'https://www.reed.co.uk/jobs/machine-learning-engineer/57375181\t2026-09-21\treed-api\tMachine Learning Engineer\teFinancialCareers\tadded\tLondon\t\t2026-09-21\t\t\tefinancialcareers\n';
  const blacklist = new Map([[normalizeCompany('eFinancialCareers'), { company: 'eFinancialCareers', scope: 'company', reason: 'sector: finance' }]]);
  const all = buildRows({ historyText: tsv, pipelineText: PIPELINE, today: '2026-09-21' });
  assert.equal(all.length, 4);
  const kept = buildRows({ historyText: tsv, pipelineText: PIPELINE, today: '2026-09-21', blacklist });
  assert.equal(kept.length, 3);
  assert.ok(!kept.some(r => r.company === 'eFinancialCareers'));
  // extraRows (Jim's hand-picked Indeed jobs) are never blacklisted
  const extra = [{ company: 'eFinancialCareers', title: 'X', location: '', url: 'https://uk.indeed.com/viewjob?jk=1', source: 'indeed', posted_at: '2026-09-21', first_seen: '2026-09-21', description: '' }];
  assert.equal(buildRows({ historyText: tsv, pipelineText: PIPELINE, today: '2026-09-21', blacklist, extraRows: extra }).length, 4);
});

test('loadExportInputs() carries the live data/blacklist.md so both exporters and run-all apply it', async () => {
  const { loadExportInputs } = await import('../export-jobs.mjs');
  const { normalizeCompany } = await import('../tracker-utils.mjs');
  const inputs = loadExportInputs();
  assert.ok(inputs.blacklist instanceof Map);
  assert.ok(inputs.blacklist.has(normalizeCompany('eFinancialCareers')), 'eFinancialCareers must be on the live blacklist (Jim, 2026-09-23)');
});
