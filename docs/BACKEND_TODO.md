# Backend to-do and contract change log

Every change made to `contract/` during the frontend phase is logged here, so the
backend team knows exactly what to build. Newest first.

| Date | Screen | Contract change | Spec § | Requested by | Status |
| --- | --- | --- | --- | --- | --- |
| 2026-10-16 | (all, data layer) | No contract change. Database schemas for the Elixir backend to reuse: `db/postgres/migrations/001_config_schema.sql` (configuration in schema `sms`, Ecto conventions, safe-delete columns) and `db/clickhouse/migrations/001_edr.sql` (EDRs + hourly summary). See "Schema notes" | §6–§13, §14 | Build step 2 | Draft |
| 2026-10-16 | (all) | Contract skeleton v0.1.0: `GET /health`, `GET /me`, `GET /meta/lists/{list}/fields`, `POST /enterprises/query`, `GET /enterprises/{id}`; list conventions (`ListQuery` filter tree with AND/OR groups and the §13.25 operators, sort, cursor paging, `problem+json` errors); WebSocket frame = Phoenix Channels V2, events `live:dashboard/summary`, `live:tps/tick`, `alerts:<userId>/incident` | §1, §3, §5.1, §13.3, §13.6, §13.25, §14.2, §15.1 | Build step 1 | Mock done |

## Decisions

- 2026-10-16, rule targets (§13.2, option A): a translation or HLR rule keeps what it applies to (specific trunks, a whole enterprise, a product category or all customer / all vendor trunks). A trunk added later to that enterprise or category gets the rule automatically, and its Rules tab shows it as inherited. Order and on/off stay per trunk. Decided by: Hasan Ibrahim.
- 2026-10-16, MCC/MNC master (§6.1): production uses a list Hasan Ibrahim supplies as an Excel/CSV file, loaded through the MCCMNC Unique Codes import. The public list in `mock/data/` is for fake data only. Backend: the import must match existing codes, add new ones and report codes that disappear but are still used by rate lines or rules. Decided by: Hasan Ibrahim.
- 2026-10-16, dial-code Master Table / numbering plan (§6.1): production uses a ready list supplied by Hasan Ibrahim and loaded through the Master Table import. The generated prefixes are fake-data only. Decided by: Hasan Ibrahim.
- 2026-10-16, shared MCCs (e.g. Guam on 310/311): no special rule in the system; the supplied MCC/MNC list decides which country-level codes exist. Decided by: Hasan Ibrahim.
- 2026-10-16, re-routed messages: the customer is billed once, on the final attempt; the vendor is billed for every attempt it accepted (per its billing type). Decided by: Hasan Ibrahim.
- 2026-10-16, billing data retention (§13.29): EDRs, invoices, SOAs, payments, credit notes, balance history, disputes, rate history and audit records are kept for 7 years and cannot be purged before that (anonymising a closed client's contact details stays allowed, as §13.29 says). Decided by: Hasan Ibrahim.
- 2026-10-16, excluded payments (§13.33): a payment with "Include in SOA" unticked is left off the partner's SOA (and shown in the SOA preview's collapsed "excluded" section) but still counts in the partner's balance and in finance reports. Decided by: Hasan Ibrahim.
- 2026-10-16, saved filter views (§13.25): a saved view is private to the user who saved it. The owner can share it with named colleagues (chosen users), who see it read-only in their view list. No department-wide or company-wide sharing. To be added to the contract with the views endpoint. Decided by: Hasan Ibrahim.

## Schema notes (build step 2, fake data generator)

New tables or columns beyond the reference platform, so the backend builds the same shape:

- `enterprise_am_history` (one open row = current AM) and `c_am_user_id` / `v_am_user_id` on every EDR: AM taken at send time (§13.30).
- `customer_trunks.dlr_session_affinity` (strict / same_ip / same_trunk) and `dlr_hold_hours`; EDR columns `c_session_id`, `c_bind_type`, `receipt_session_id`, `receipt_held_ms` (§13.1).
- `customer_trunks.revenue_limit` / `vendor_trunks.cost_limit` with a period (§13.26).
- `rate_tables.kind` (customer / vendor): every vendor trunk owns exactly one vendor table, so the Rate Manager treats sell and buy tables alike (§13.12).
- `rate_lines` keeps every version (`valid_from`, `valid_to`, NULL = open); two exclusion constraints forbid overlapping versions of the same destination (and sender ID). `stated_valid_from` holds the RN date when a back-dated RN is applied from the received time (§13.32).
- `route_rules.tps_condition`, `revenue_condition`, `hlr_action` are jsonb (§13.8, §13.9, §13.24); `route_rule_vendors.warmup_*` and `route_rule_whitelists` (§13.27).
- `translation_rule_targets` / `hlr_rule_targets`: what a rule applies to (`target_type` trunk / enterprise / category / all, plus `trunk_kind` for translation rules; customer side = ingress, vendor side = egress). `translation_rule_trunk_settings` / `hlr_rule_trunk_settings`: optional per-trunk position, continue flag and on/off. No groups (§13.2).
- Rules that run on a trunk, in order (the backend must match `rulesForTrunk` in `mock/src/generator/world.ts`): every active rule reaching the trunk through any target, minus rules switched off for that trunk; unpositioned rules whose target says "top" first, then positioned rules by position, then the rest; ties by rule id. HLR rules are then checked top to bottom and the first DNID match picks the provider.
- `transactions.send_confirmation`, `confirmation_status`, `include_in_soa`, `exclude_reason` (§13.33). `vendor_invoices.our_amount` / `our_volume` / `recon_status` (§13.31).
- `changes`: one row per save with a field-level diff and `undo_of_id` (§13.10).
- `deleted_at` / `deleted_by_id` on every archivable record; nothing is hard-deleted (§13.29).
- EDRs copy rate, cost, exchange rate and base-currency values at send time (§13.29, §13.32).

## Open questions

- None open.
