# backend/ (later phase)

Elixir umbrella (spec §14): `switch` (SMPP engine: binds, submit_sm/deliver_sm, DLRs,
session affinity §13.1), `core` (rates, rules, billing, jobs) and `api` (Phoenix API and
Channels). It must answer `contract/openapi.yaml` and push the events in `contract/events/`
exactly as the mock server does today, so the GUI needs no changes at the switch.

It reuses the PostgreSQL schema under `db/postgres/migrations/` and the ClickHouse schema
under `db/clickhouse/migrations/`.
