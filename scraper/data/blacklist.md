# Company Blacklist

Jim's do-not-scan list (user layer, opt-in). `scan.mjs` skips any posting whose
company matches a row below (case- and punctuation-insensitive) and reports the
count as "Blacklisted: N skipped" in the run summary. `--include-blacklisted`
lets them through annotated, for auditing.

Round 2, 2026-09-21: finance, insurance and defence employers are out of scope.
The ones with a `portals.yml` entry are also switched off there (`enabled: false`),
so this table mainly catches names that arrive through aggregator feeds
(Himalayas, Agentic, websearch). To let a company back in, delete its row and
re-enable its `portals.yml` entry if it has one.

| Company | Since | Scope | Reason |
|---------|-------|-------|--------|
| Stripe | 2026-09-21 | company | sector: finance (payments) |
| Coinbase | 2026-09-21 | company | sector: finance (crypto exchange) |
| Monzo | 2026-09-21 | company | sector: finance (bank) |
| Ramp | 2026-09-21 | company | sector: finance (corporate cards) |
| Revolut | 2026-09-21 | company | sector: finance (bank) |
| Klarna | 2026-09-21 | company | sector: finance (payments) |
| N26 | 2026-09-21 | company | sector: finance (bank) |
| Trade Republic | 2026-09-21 | company | sector: finance (broker) |
| SumUp | 2026-09-21 | company | sector: finance (payments) |
| Qonto | 2026-09-21 | company | sector: finance (bank) |
| Mollie | 2026-09-21 | company | sector: finance (payments) |
| Pleo | 2026-09-21 | company | sector: finance (spend management) |
| Allianz | 2026-09-21 | company | sector: insurance |
| Helsing | 2026-09-21 | company | sector: defence |
| Palantir | 2026-09-21 | company | sector: defence / government |
| Rolls-Royce | 2026-09-21 | company | sector: defence / aerospace |
| Barclays | 2026-09-21 | company | sector: finance (bank) |
| HSBC | 2026-09-21 | company | sector: finance (bank) |
| Lloyds | 2026-09-21 | company | sector: finance (bank) |
| Lloyds Banking Group | 2026-09-21 | company | sector: finance (bank) |
| NatWest | 2026-09-21 | company | sector: finance (bank) |
| Standard Chartered | 2026-09-21 | company | sector: finance (bank) |
| Goldman Sachs | 2026-09-21 | company | sector: finance (investment bank) |
| JPMorgan | 2026-09-21 | company | sector: finance (investment bank) |
| JPMorgan Chase | 2026-09-21 | company | sector: finance (investment bank) |
| Morgan Stanley | 2026-09-21 | company | sector: finance (investment bank) |
| Citi | 2026-09-21 | company | sector: finance (bank) |
| Wise | 2026-09-21 | company | sector: finance (payments) |
| Starling | 2026-09-21 | company | sector: finance (bank) |
| Starling Bank | 2026-09-21 | company | sector: finance (bank) |
| Zopa | 2026-09-21 | company | sector: finance (bank) |
| Checkout.com | 2026-09-21 | company | sector: finance (payments) |
| Aviva | 2026-09-21 | company | sector: insurance |
| Legal & General | 2026-09-21 | company | sector: insurance |
| Prudential | 2026-09-21 | company | sector: insurance |
| Bupa | 2026-09-21 | company | sector: insurance (health) |
| BAE Systems | 2026-09-21 | company | sector: defence |
| Leonardo | 2026-09-21 | company | sector: defence |
| Thales | 2026-09-21 | company | sector: defence |
| QinetiQ | 2026-09-21 | company | sector: defence |
| Anduril | 2026-09-21 | company | sector: defence |
| eFinancialCareers | 2026-09-23 | company | sector: finance (finance job board — its Reed/Adzuna ads are bank, asset-manager and fintech roles: Citi, Barings, Selby Jennings…) |
| Janus Henderson Investors | 2026-09-23 | company | sector: finance (asset manager) |
