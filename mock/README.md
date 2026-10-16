# mock: mock server and fake data generator

This package holds the Fastify mock server (build-order step 1, `src/server.ts`) and the
seeded fake data generator (build-order step 2, `src/generator/`) that fills PostgreSQL
(configuration) and ClickHouse (EDRs) with production-like **fake** data. The live traffic
simulator will also live here.

## Run the generator

```bash
cp .env.example .env          # repo root; connection values for docker-compose and the generator
npm install                   # repo root
npm run db:up                 # postgres, clickhouse, redis
npm run seed:small            # ~80 enterprises, ~100k rate lines, 200k EDRs, < 1 min
npm run seed:full             # production-like volume (see below), ~13 minutes
npm run gen:csv -w mock       # small profile to mock/out/*.csv + edr.tsv.gz, no databases
npm test -w mock              # includes determinism, integrity and EDR consistency checks
```

The generator applies the schemas itself: it drops and recreates the `sms` schema in
PostgreSQL from `db/postgres/init` + `db/postgres/migrations`, and the EDR tables in the
`CLICKHOUSE_DB` database from `db/clickhouse/migrations`. Connection settings come from the
root `.env` (`POSTGRES_*`, `CLICKHOUSE_*`, same names and defaults as `.env.example`).

Options (pass after `--`, e.g. `npm run gen -w mock -- --profile full --edrs 20000000`):

| Flag | Default | Meaning |
| --- | --- | --- |
| `--profile small\|full` | `small` | Volume profile (`src/generator/profiles.ts`) |
| `--seed <s>` | `42` | Same seed + anchor = identical data |
| `--anchor <ISO time>` | now | "Now" for the data set: history ends here, scheduled changes start after it |
| `--target db\|csv` | `db` | Load into PostgreSQL + ClickHouse, or write files to `--out` |
| `--edrs <n>` / `--days <n>` | profile | EDR count and time window ending at the anchor |
| `--skip-edrs` / `--edrs-only` | off | Only configuration / only EDRs (config is rebuilt in memory from the seed) |
| `--no-reset` | off | Keep existing schemas (default drops and recreates them from `db/`) |

## What it creates

| Area | Content | Spec |
| --- | --- | --- |
| Reference | 5 currencies with daily exchange-rate history, 12 billing cycles, 17 product categories, 225 countries, the **real MCC/MNC list** (2,063 networks) plus a country-level "All networks" code per MCC, dial-code Master Table | §5.5, §6.1, §7, §13.21 |
| Admin | Business companies, 7 departments, 7 GUI access groups, users with account managers and team leads, password age (some expired) and 2FA state | §11, §12.5, §13.28 |
| Enterprises | Customers, vendors and reciprocal partners with tiers, 4 contact types, customer and vendor billing, beneficiaries, AM history with past and scheduled handovers, some inactive and some archived | §5.1–5.3, §13.29, §13.30 |
| Trunks | Customer trunks (SMPP/HTTP, bind type, TPS, DLR session affinity, revenue limits, express vendor) and vendor trunks (bind params, window, allowed codings, re-route list, quality profile, cost limits) | §5.4, §5.5, §13.1, §13.26 |
| Rates | One buy table per vendor trunk (direct vendors cover a few countries, wholesale vendors most of the world) and sell tables on customer trunks (some shared, some unattached). Full history from change events: new / increase / decrease lines, closed destinations, blocked lines, sender-ID lines, scheduled future changes, back-dated vendor RNs with the stated date kept, and an import-history row per event | §6.2, §12.1, §13.12, §13.32 |
| Routing | Catch-all least-cost rule per category, block rules, country and network rules (static, QBR, dynamic) with percentage or top-down vendors and backups, customer-trunk include/exclude lists, TPS and revenue conditions, warm-up thresholds, number whitelists, HLR actions, groups. Includes dirty data for the Cleanup Center: inactive, expired, scheduled, deleted, identical copies, references to inactive vendors | §6.3, §13.8, §13.9, §13.19, §13.24, §13.27 |
| Switch rules | Translation rules and HLR rules attached **directly to trunks** with per-trunk order (no groups); some unattached; HLR providers; number lists | §6.4, §6.5, §13.2 |
| Finance | Monthly customer invoices with running balance, receipts, bank charges kept off the SOA, credit notes; vendor invoices with reconciliation status; vendor payments | §7, §13.31, §13.33 |
| History | Change log for undo: creates, field edits, enable/disable, bulk vendor replacements, undo entries | §13.10 |
| EDRs | Message attempts over the last N days, in ClickHouse `edr` plus the hourly summary `edr_hourly` | §9.1, §13.1, §13.29, §13.30 |

### How EDRs follow the configuration

For each message: pick a live customer trunk (weighted by client size) and a destination
from its rate tables (weighted by country traffic and the client's focus countries); rate it
with the line valid at send time (sender-ID line, then MCCMNC, then country "All networks";
first matching table wins); route it through the rules in priority order (category, trunk
lists, sender patterns, TPS condition, whitelist, then warm-up, then split; dynamic rules
take one of the 3 cheapest vendors in base currency); cost it with the vendor line valid at
submit time. Submit success and delivery follow the vendor's quality profile, failed
submits and some failed receipts are re-routed as a second attempt. Billable flags follow
each side's billing type. The rate, cost and both AMs are copied into the row, so later
rate changes or handovers never change past traffic. Traffic follows a daily curve with
quieter weekends.

### Volumes

Measured with seed 42 (full run: about 13 minutes on 4 cores; config + Postgres load take
under 3 minutes, EDRs about 8,600 rows/s into ClickHouse).

| | small | full |
| --- | --- | --- |
| Enterprises | 80 | 600 |
| Customer / vendor trunks | 101 / 59 | 813 / 407 |
| Rate tables / rate lines (with history) | 142 / ~96k | 963 / ~1.45M |
| Route rules / vendor levels | 300 / ~440 | 3,000 / ~4,700 |
| Invoices / transactions | ~550 / ~1,000 | ~5,900 / ~10,000 |
| EDR rows (attempts) | ~210k over 3 days | ~5.2M over 30 days (5M messages; `--edrs` for more) |

### Fake data only

Company, brand and person names are invented (syllables or common first/last names).
Domains use `.example`, IPs come from RFC 5737 documentation ranges and 10.0.0.0/8,
IBANs and SWIFT codes contain `TEST`, passwords are random strings and user password
hashes are fake. Only the MCC/MNC list, country names and dial codes are real
(public list, MIT licence, snapshot in `data/source/`, rebuilt with `npm run build:mccmnc`).
Dial-code prefixes below the country code are made up.
