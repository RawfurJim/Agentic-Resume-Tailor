// Asserts the LIVE portals.yml expresses Jim's brief: UK/Ireland locations,
// AI/ML/DS/FDE titles, full-time only. Loads the real config, builds the real
// filters from scan.mjs, and checks a table of examples.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as yaml from 'js-yaml';

const here = path.dirname(fileURLToPath(import.meta.url));
const config = yaml.load(readFileSync(path.join(here, '..', 'portals.yml'), 'utf8'));
const { buildTitleFilterWithOverrides, buildTitleFilterOverrides, buildLocationFilter } = await import('../scan.mjs');

// Same construction scan.mjs uses (round 2): the global filter plus the
// per-company `title_filter_overrides` block, keyed by lowercased company.
const titleWithCompany = buildTitleFilterWithOverrides(
  config.title_filter,
  buildTitleFilterOverrides(config.title_filter_overrides),
);
const titleOk = (title, company = '') => titleWithCompany(title, String(company).toLowerCase());
const locOk = buildLocationFilter(config.location_filter);

const TITLES_PASS = [
  // round 3 recall check (2026-09-22)
  'Artificial Intelligence Engineer',
  'Senior Artificial Intelligence Specialist',
  'Model Optimisation Engineer',
  'Software Engineer, Model Inference, DeepMind',
  'Foundation Models Engineer',
  'Neural Graphics Engineer',                        // NVIDIA, audit 2026-09-22
  'Senior Solutions Architect – Large Scale Neural Networks Inference',
  'AI Engineer',
  'Senior AI Engineer',
  'AI/ML Engineer',
  'Senior Machine Learning Engineer',
  'ML Engineer',
  'Staff Machine Learning Engineer, Ads',
  'Data Scientist, Ads',
  'Senior Data Scientist',
  'Forward Deployed Engineer',
  'Forward Deployed Software Engineer',
  'LLM Engineer',
  'GenAI Engineer',
  'Generative AI Engineer',
  'Applied AI Engineer',
  'Research Engineer, Gemini',
  'MLOps Engineer',
  // ── Round 2: "AI-related even if the title is slightly off" (Jim) ──
  'AI Product Developer',
  'AI Developer',
  'Machine Learning Developer',
  'Deep Learning Engineer',
  'Computer Vision Engineer',
  'NLP Engineer',
  'Member of Technical Staff',
  'Member of Technical Staff - Applied AI Software Engineer, Health',
  'Prompt Engineer',
  'AI Solutions Architect',
  'AI Specialist',
  'Agentic Systems Engineer',
  'Inference Engineer',
  'Software Engineer, TPU Compiler',
  'Software Engineer, Model Inference, DeepMind',
  'Senior Data Scientist',
  'Lead Data Scientist',
  'Staff Data Scientist',
  'Speech Recognition Engineer',
  'Conversational AI Engineer',
  'GenAI Platform Engineer',
  'Software Engineer, GenAI Platform',
  'Forward Deployed Engineer',
  'Research Engineer, Agents',
  'Senior Software Engineer (Typescript), AI Clients: Duo CLI',
  'AI Infrastructure Engineer, Serving Platform',
  'Staff Applied AI Engineer',
  'Principal Machine Learning Engineer',
  // ── Round 5 (2026-09-22): Amazon's title style — role, team, org. Jim keeps
  // AWS Solutions Architects AND AWS Professional Services delivery roles
  // ("Consultant" is no longer a blanket negative).
  'Delivery Consultant AI - Enterprises, AWS Professional Services',
  'Senior AI/ML Consultant, AWS Professional Services',
  'Sr. Applied AI Solutions Architect, Amazon Connect',
  'Sr. WW Applied AI Specialist SA, Amazon Connect',
  'Senior GenAI Infra Specialist, WWSO Startups',
  'Senior Specialist PhysicalAI & Models, WWSO Startups',      // "PhysicalAI" has no space
  'Software Development Engineer, Ring Cloud Computer Vision',
  'AI Language Engineer II, Alexa for Shopping Lang-Tech',
  'Data Scientist II, RufusX Science UK',
  'Worldwide Specialist Solutions Architect – Database, Data & AI Specialist',
  // round 5 boards
  'Forward Deployed Scientist II',                              // UiPath
  'Software engineer, agents (UK)',                             // Writer
  'AI deployment engineer (UK)',
  'Senior ML Compiler Engineer',                                // Fractile
  'Applied AI/ML Engineer (Agents)',                            // CuspAI
  'Forward Deployed Engineer - Greek, Turkish',                 // Salesforce
  'Agentforce Operations FDE',
  'Software Engineer - Agentic Orchestration',                  // Genesys
  'Senior AI Data Engineer',                                    // Zendesk
];
const TITLES_FAIL = [
  'AI Sales Specialist, Startups',
  'ML Engineer Intern',
  'Machine Learning Engineer Internship',
  'Data Scientist (12-month Fixed Term)',
  'Data Scientist - Contract',
  'Junior Data Scientist',
  'Graduate Data Scientist',
  'Software Engineer',
  'Site Reliability Engineer',
  'AI Product Manager',
  'Technical Program Manager, AI',
  'Recruiter, AI Research',
  'Marketing Manager, AI',
  'Account Executive, AI Native',
  'Werkstudent Machine Learning',
  'PhD Student, Machine Learning',
  'Data Scientist (Part-time)',
  'Manager, Applied AI Engineering, DeepMind',
  'Systems Engineering Manager, Site Reliability Engineering, ML Compute',
  'Engineering Analyst, AI Answers, Google Search',
  // ── Round 2: researcher roles — Jim is an engineer, not a researcher ──
  'Research Scientist, World Models, DeepMind',
  'Research Scientist, Robotics RL, DeepMind',
  'Research Scientist',
  'Staff Research Scientist',
  'AI Research Scientist',
  'Reinforcement Learning Researcher',
  'NLP Scientist',
  'Applied Scientist, Demand Tech',
  'Applied Scientist, Amazon Ads',
  'Machine Learning Scientist',
  'Lead Machine Learning Scientist, Business Banking',
  'Senior AI Scientist',
  'Postdoctoral Researcher',
  'Research Fellow, Machine Learning',
  // ── Round 2: non-engineering roles the broader positives would let in ──
  'AI Sales Specialist',
  'Senior UX Design Manager, Cloud',
  'Talent Acquisition Partner, DeepMind',
  'Creator Experience Policy Analyst',
  'AI Value Creation Senior Principal',
  'Director, Regulatory Affairs',
  'Senior Field Sales Representative, FSI',
  'App Specialist, Customer Onboarding',
  'Apps Growth Consultant',
  'Game Designer, Games, DeepMind',
  'AI Data Associate - Dutch',
  'Data Science PhD Intern, 2027',
  'Customer Engineer, UK/IE Startups',
  'Staff Site Reliability Engineer, Core Networking',
  'Strategic Operations Lead, Trust and Safety',
  'Software Engineer III, Android, Jetpack Remote Compose',
  'Head of AI',
  'VP, Machine Learning',
  'AI Technical Writer',
  'Machine Learning Support Engineer',
  // round 3 recall check (2026-09-22)
  'Machine Learning Engineer - 12 month FTC',       // fixed-term contract
  'Vehicle Performance Modelling Engineer',         // "Modelling" is not "Model"
  'Financial Modelling Analyst',
  'Senior Corporate Travel Agent - GDS',            // "Agent" ≠ AI agent
  'Software Engineer, Agent (New Grad 2027)',       // full-time experienced only
  'GPU Architecture Engineer - New College Grad 2026',
  'Member of Technical Staff - New Grad (2027 Start)',
  // ── Round 5 (2026-09-22): Amazon whole-board false positives + new boards ──
  'Delivery Station Liaison Agent',                                       // human agent
  'Software Dev. Engineer in Test, Conversational shopping',              // QA role
  'EMEA Partner Lead, Data Foundations for AI, EMEA Partner Specialist team',
  'Business Development Manager, GenAI, Global Education',
  'AI Data Associate - Dutch, Artificial General Intelligence',
  'Principal GTM Specialist, Physical AI - EMEA, WWSO EMEA Advanced Compute',
  'AI/ML Team Manager, Artificial General Intelligence – Data Services',
  'Principal Executive AI Strategist - Business Development, Amazon Connect Applied AI Solutions',
  'Software Development Engineer, Alexa for Shopping',                    // team name alone is not an AI title (round-3 rule)
  'Applied Scientist, Silicon and Systems Group Edge AI',                 // researcher rule stands
  'AI Sales Consultant',
  'Solutions Consultant, AI',
  'Recruitment Consultant - AI & Data',
  'Lead Marketer, AI Usage Automation',                                   // HubSpot
  'AI Creative Producer',                                                 // ElevenLabs
  'Forward Deployed Creative',
  'Enterprise AI transformation lead (UK)',                               // Writer
  'Enterprise AI adoption lead (UK)',
  'Operations Specialist, AI Enablement [Content Moderation]',            // Bumble
  'AI Portfolio Lead',                                                    // Multiverse
  'Principal Success Architect - AI Control Tower',                       // ServiceNow
  'AI Transformation Architect',                                          // Dialpad
  'Field CAIO, AI & Agentic Ecosystem',                                   // Salesforce (live 2026-09-22)
  'Field CTO, Data and AI',
  'Partner Technical Architect - Agentforce',
  'Senior Success Guide - Data Cloud/ Agentforce - Italian Speaking',
];

// [title, company, expected]. Round 3 (Jim, 2026-09-22): the per-company
// `title_filter_overrides` block is GONE — a plain "Software Engineer" /
// "Developer" title is out everywhere, AI lab or not. A title only survives when
// it itself mentions AI / ML / LLM / GenAI / Data Science / FDE etc.
const TITLES_BY_COMPANY = [
  ['Staff Software Engineer - Physical AI', 'Weights & Biases (CoreWeave)', true],   // AI in the title → in
  ['Senior Software Engineer, LLM Inference', 'Anthropic', true],
  ['Software Engineer, GenAI Platform', 'DeepL', true],
  ['Member of Technical Staff', 'Anthropic', true],      // global positive, not an override
  ['Staff Software Engineer', 'Anthropic', false],
  ['Software Engineer', 'OpenAI', false],
  ['Senior Software Engineer | API Enterprise', 'DeepL', false],
  ['Software Engineer, Distributed Systems', 'OpenAI', false],   // round 3: no AI in title → out, even at a lab
  ['Software Engineer, Distributed Systems', 'Acme', false],
  ['Software Engineer, Platform', 'DeepMind', false],     // round 3: plain SWE at DeepMind is out too
  ['Software Engineer, Platform', 'Google', false],       // plain Google SWE stays out
  ['Software Engineer III, Android, Jetpack Remote Compose', 'Google', false],
  ['Research Scientist', 'DeepMind', false],              // negative veto beats the override
  ['Research Scientist', 'Anthropic', false],
  ['Backend Developer', 'ElevenLabs', false],
  ['Backend Developer', 'Deliveroo', false],
  // Microsoft is a generalist employer, NOT an AI-native lab: no override there.
  // Seen live on 2026-09-21 — plain engineering titles must stay out, AI ones in.
  ['Software Engineer', 'Microsoft', false],
  ['Service Engineer', 'Microsoft', false],
  ['Senior Security Engineer', 'Microsoft', false],
  ['Senior/Principal Optical Packaging Engineer', 'Microsoft', false],
  ['Project SME - Civil Engineering', 'Microsoft', false],
  ['Principal Business Architect', 'Microsoft', false],
  ['Solution Engineer - Data', 'Microsoft', false],
  ['Sales Engineer', 'Microsoft', false],
  ['Member of Technical Staff - Applied AI Software Engineer, Health', 'Microsoft', true],
  ['Applied AI Innovation Architect (Cloud Solutions)', 'Microsoft', true],
  ['Principal Software Engineer, FDE', 'Microsoft', true],   // FDE = Forward Deployed Engineer
  ['Sr Data Scientist - FDE - Security Check (SC) Clearance', 'Microsoft', true],
  // Phase D tightening (full dry-run 2026-09-21): the lab override no longer
  // includes bare "Engineer" / "Architect" — they admitted IT, network, AV,
  // mechanical and pre-sales titles. "Software Engineer" / "Developer" /
  // "Technical Staff" still count at a lab. Plain Solutions Architect is
  // pre-sales; "AI Solutions Architect" still passes via the global "AI".
  ['Solutions Architect', 'Anthropic', false],
  ['Solutions Architect', 'Deliveroo', false],
  ['AI Solutions Architect', 'Deliveroo', true],
  ['Staff Software Engineer, Infrastructure (Distributed Systems)', 'Anthropic', false],
  ['AV Engineer', 'Anthropic', false],
  ['Software Engineer, Business Technology', 'Anthropic', false],
  ['Network Engineer', 'OpenAI', false],
  ['Software Engineer, ChatGPT Infrastructure', 'OpenAI', false],
  ['IT Engineer', 'ElevenLabs', false],
  ['Martech Engineer', 'ElevenLabs', false],
  ['Website Growth Engineer', 'ElevenLabs', false],
  ['Design Engineer, Brand', 'Lovable', false],
  ['Solutions Architect - MENA', 'Deepgram', false],
  ['Deployed Architect, Professional Services (London)', 'LangChain', true],
  ['Deployed Infrastructure Engineer (Spanish speaking)', 'Sierra', true],
  ['Strategist, Agent Development (Flemish speaking)', 'Sierra', false],
  ['GTM Operations, Agent Development (London)', 'Sierra', false],
  ['AI Enablement Lead', 'Legora', false],
  ['Value Engineer', 'Legora', false],
  ['Solutions Engineer, London', 'Legora', false],
  ['Senior Security Engineer', 'Cohere', false],
  ['Member of Technical Staff - RL Environments', 'Cohere', true],
  ['Mechanical Design Engineer', 'Wayve', false],
  ['Controls Engineer', 'Wayve', false],
  ['Software Engineer, Simulation', 'Wayve', false],
  ['Staff Robotics Engineer', 'Wayve', false],
  ['Senior Machine Learning Engineer - AV Core', 'Wayve', true],   // AV = autonomous vehicle here
  ['Platform Engineer, AI Enablement', 'Wayve', true],
  ['Applied AI Strategist, EMEA', 'Anthropic', false],
  ['Abschlussarbeit Entwicklung von KI-Agenten für die Produktionsplanung (w/m/x)', 'BMW Group', false],                 // robotics ≠ AI engineering (Jim can add "Robotics")
  ['IT Lead Engineer', 'PhysicsX', false],
  ['Engineering Site Lead', 'Perplexity', false],
  ['Product Education Engineer', 'Cursor', false],
  ['Frontend Engineer', 'Faculty', false],
  ['Senior Software Engineer', 'Faculty', false],
  ['Senior Software Engineer | Voice | Full-Stack', 'DeepL', true],
  ['Member of Technical Staff - Privacy Engineer, Health', 'Microsoft', false],
  ['AI Security Operations (SecOps) Specialist', 'AstraZeneca', false],
  ['AI Transformation Owner, Product & Design', 'GitLab', false],
  ['Principal Engineer, Duo Agent Platform', 'GitLab', true],   // GitLab's AI agent platform
  ['Commercial Merchant Support Agent', 'Deliveroo', false],    // "Agent" positive must not catch support agents
  ['Customer Service Agent (Italian Speaking) - Inbound B2B', 'Deliveroo', false],
];

// Data Scientist survives the researcher block: the negatives are chosen so
// none is a substring of "<Level> Data Scientist".
const DATA_SCIENTIST_SURVIVES = [
  'Senior Data Scientist',
  'Lead Data Scientist',
  'Staff Data Scientist',
  'Principal Data Scientist',
];

const LOCATIONS_PASS = [
  'London, UK',
  'London',
  'United Kingdom',
  'Remote - UK',
  'Remote (United Kingdom)',
  'Dublin, Ireland',
  'Cardiff, Wales',
  'Edinburgh, Scotland',
  'Belfast, Northern Ireland',
  'Manchester, UK',
  'Cambridge, United Kingdom',
  'Cambridge, UK',
  'UK - Cambridge',
  'Cardiff, London or Remote (UK)',
  'London, England, GBR',
  'Remote, United Kingdom',
  'London, UK · San Francisco, CA, USA',
  'London, UK; Ontario, CAN; Remote-Friendly, United States; San Francisco, CA',
  'GB, London',
  'Remote - EMEA',
  'Remote - Europe',
  '',            // missing data always passes (scanner convention)
];
const LOCATIONS_FAIL = [
  'San Francisco, CA',
  'New York City, NY',
  'San Francisco, CA | New York City, NY | Seattle, WA',
  'Remote',            // bare remote is usually US-only → dropped on purpose
  'Remote - US',
  'Bengaluru, India',
  'Munich, Germany',
  'Paris, France',
  'Singapore',
  'Tokyo, Japan',
  'Toronto, Canada',
  'Warsaw, Poland',
  'Madrid, Spain',
  'Mountain View, CA, USA',
  'San Francisco, CA · Boston, MA · Cambridge · United States · New York, NY · New York',
  'New York, NY · Atlanta, GA · Boston, MA · Cambridge · Washington DC · Remote',
  'Cambridge, MA',
];

test('portals.yml: location_filter is configured', () => {
  assert.ok(config.location_filter, 'location_filter block missing');
  assert.ok(Array.isArray(config.location_filter.always_allow) && config.location_filter.always_allow.length > 0);
});
test('portals.yml: full-time only — skip_tiers includes intern', () => {
  assert.ok(Array.isArray(config.skip_tiers) && config.skip_tiers.includes('intern'));
});
test('portals.yml: no title_filter_overrides — plain software titles are out everywhere (round 3)', () => {
  const block = config.title_filter_overrides;
  assert.ok(block == null || (Array.isArray(block) && block.length === 0),
    'title_filter_overrides must stay removed: Jim does not want software jobs whose title does not mention AI');
});
test('portals.yml: researcher titles are not positives (Jim is an engineer)', () => {
  for (const k of config.title_filter.positive) {
    assert.doesNotMatch(k.toLowerCase(), /applied scientist|research scientist|researcher|\+ scientist/, k);
  }
});
// Round 5: Amazon is ONE whole-board entry (765 UK postings = 8 API pages on
// 2026-09-22); the title filter, not a keyword search, decides. The hiring
// entity ("AWS EMEA SARL (UK Branch)") is relabelled to "Amazon".
test('portals.yml: Amazon is a single UK whole-board entry labelled "Amazon"', () => {
  const amazon = (config.tracked_companies ?? []).filter(e => e.provider === 'amazon' && e.enabled !== false);
  assert.equal(amazon.length, 1, 'exactly one enabled amazon entry');
  const [e] = amazon;
  assert.equal(e.company_label, 'Amazon');
  assert.deepEqual(e.amazon.normalized_country_code, ['GBR']);
  assert.equal(e.amazon.base_query, undefined, 'no keyword search — fetch the whole UK board');
  assert.equal(e.max_posting_age_days, undefined, 'the global 60-day cap applies to Amazon too (Jim, 2026-09-22)');
});

// Round 2, Task 4 (Phase E): Jim's UK AI companies whose careers pages expose a
// scrapable board. Each row = [entry name, careers_url host, explicit provider or null].
const UK_AI_ENTRIES = [
  ['BenevolentAI', 'apply.workable.com', null],
  ['Recursion (Exscientia)', 'job-boards.greenhouse.io', null],
  ['Healx', 'jobs.lever.co', null],
  ['Gigaton', 'jobs.ashbyhq.com', null],
  ['Darktrace', 'darktrace.wd3.myworkdayjobs.com', null],
  ['Antiverse', 'careers.antiverse.io', 'teamtailor'],
];
const entriesByName = new Map((config.tracked_companies ?? []).map(e => [e.name, e]));
for (const [name, host, provider] of UK_AI_ENTRIES) {
  test(`portals.yml: UK AI company "${name}" is present, enabled, on ${host}`, () => {
    const entry = entriesByName.get(name);
    assert.ok(entry, `${name} has no portals.yml entry`);
    assert.notEqual(entry.enabled, false, `${name} is disabled`);
    assert.equal(new URL(entry.careers_url).hostname, host);
    if (provider) assert.equal(entry.provider, provider, `${name} needs an explicit provider`);
  });
}

// Round 5 (2026-09-22): every ENABLED employer entry must resolve to a provider.
// Jim's run said "20 skipped — no provider matched": websearch stubs from the
// template that this install can never scan. They are now real boards or
// disabled with a reason, and this test keeps it that way.
const { loadProviders, resolveProvider } = await import('../providers/_registry.mjs');
const providers = await loadProviders(path.join(here, '..', 'providers'));
test('portals.yml: every enabled tracked_companies / job_boards entry resolves to a provider', () => {
  const unresolved = [];
  for (const e of [...(config.tracked_companies ?? []), ...(config.job_boards ?? [])]) {
    if (!e || e.enabled === false) continue;
    const r = resolveProvider(e, providers);
    if (!r || r.error || !r.provider) unresolved.push(`${e.name} (${r?.error || 'no provider matched'})`);
  }
  assert.deepEqual(unresolved, [], 'entries no provider can scan');
});

// Round 5 employers + the fixed template stubs: [entry name, careers_url host, explicit provider or null].
const ROUND5_ENTRIES = [
  ['Writer', 'jobs.ashbyhq.com', null],
  ['Sony Interactive Entertainment (PlayStation)', 'job-boards.greenhouse.io', null],
  ['Mistral AI', 'jobs.ashbyhq.com', null],          // the Lever board was empty
  ['Cognition', 'jobs.ashbyhq.com', null],
  ['Trainline', 'jobs.ashbyhq.com', null],
  ['Latent Labs', 'jobs.ashbyhq.com', null],
  ['Bumble', 'jobs.ashbyhq.com', null],
  ['MongoDB', 'job-boards.greenhouse.io', null],
  ['Encord', 'jobs.ashbyhq.com', null],
  ['Prolific', 'job-boards.greenhouse.io', null],
  ['UiPath', 'jobs.ashbyhq.com', null],
  ['Motorway', 'jobs.ashbyhq.com', null],
  ['Together AI', 'job-boards.greenhouse.io', null],
  ['Ocado Group', 'job-boards.greenhouse.io', null],
  ['CuspAI', 'jobs.ashbyhq.com', null],
  ['Poolside', 'jobs.ashbyhq.com', null],
  ['Fractile', 'jobs.ashbyhq.com', null],
  ['Auto Trader UK', 'job-boards.greenhouse.io', null],
  ['Reddit', 'job-boards.greenhouse.io', null],
  ['Flo Health', 'job-boards.greenhouse.io', null],
  ['Quantexa', 'jobs.ashbyhq.com', null],
  ['Twilio', 'job-boards.greenhouse.io', null],
  ['Salesforce', 'salesforce.wd12.myworkdayjobs.com', null],
  ['Genesys', 'genesys.wd1.myworkdayjobs.com', null],
  ['Dialpad', 'job-boards.greenhouse.io', null],
  ['Zendesk', 'zendesk.wd1.myworkdayjobs.com', null],
  ['Talkdesk', 'job-boards.greenhouse.io', null],
];
test('portals.yml: Arm stays listed but disabled — its iCIMS portal is CAPTCHA-walled (2026-09-22)', () => {
  const arm = entriesByName.get('Arm');
  assert.ok(arm); assert.equal(arm.enabled, false); assert.equal(arm.provider, 'icims');
});
// Round 5 platforms: the two keyed UK aggregators plus the two zero-code remote feeds.
test('portals.yml: job_boards carry Adzuna, Reed, Remotive and a UK-filtered Jobicy, all aggregator: true', () => {
  const boards = new Map((config.job_boards ?? []).map(e => [e.name, e]));
  for (const [name, provider] of [['Adzuna (UK)', 'adzuna'], ['Reed.co.uk', 'reed'], ['Remotive', 'remotive'], ['Jobicy (UK remote)', 'jobicy']]) {
    const e = boards.get(name);
    assert.ok(e, `${name} missing`);
    assert.equal(e.provider, provider);
    assert.equal(e.aggregator, true, `${name} must be flagged aggregator`);
    assert.notEqual(e.enabled, false);
  }
  assert.equal(boards.get('Jobicy (UK remote)').jobicy.geo, 'uk');
  assert.ok(boards.get('Adzuna (UK)').adzuna.queries.length >= 4);
  assert.ok(boards.get('Reed.co.uk').reed.queries.length >= 4);
});

for (const [name, host, provider] of ROUND5_ENTRIES) {
  test(`portals.yml: round-5 entry "${name}" is present, enabled, on ${host}`, () => {
    const entry = entriesByName.get(name);
    assert.ok(entry, `${name} has no portals.yml entry`);
    assert.notEqual(entry.enabled, false, `${name} is disabled`);
    assert.equal(new URL(entry.careers_url).hostname, host);
    assert.equal(entry.scan_method, undefined, 'websearch stubs are gone');
    if (provider) assert.equal(entry.provider, provider, `${name} needs an explicit provider`);
  });
}

for (const t of TITLES_PASS) test(`title passes: "${t}"`, () => assert.equal(titleOk(t), true));
for (const t of TITLES_FAIL) test(`title rejected: "${t}"`, () => assert.equal(titleOk(t), false));
for (const [t, c, want] of TITLES_BY_COMPANY) {
  test(`title "${t}" at ${c} → ${want ? 'kept' : 'rejected'}`, () => assert.equal(titleOk(t, c), want));
}
for (const t of DATA_SCIENTIST_SURVIVES) test(`data scientist survives researcher block: "${t}"`, () => assert.equal(titleOk(t), true));
for (const l of LOCATIONS_PASS) test(`location passes: "${l}"`, () => assert.equal(locOk(l), true));
for (const l of LOCATIONS_FAIL) test(`location rejected: "${l}"`, () => assert.equal(locOk(l), false));
