# Backend to-do and contract change log

Every change made to `contract/` during the frontend phase is logged here, so the
backend team knows exactly what to build. Newest first.

| Date | Screen | Contract change | Spec § | Requested by | Status |
| --- | --- | --- | --- | --- | --- |
| 2026-10-16 | (all, data layer) | No contract change. Database schemas for the Elixir backend to reuse: `db/postgres/migrations/001_config_schema.sql` (configuration in schema `sms`, Ecto conventions, safe-delete columns) and `db/clickhouse/migrations/001_edr.sql` (EDRs + hourly summary). See "Schema notes" | §6–§13, §14 | Build step 2 | Draft |
| 2026-10-16 | (all) | Contract skeleton v0.1.0: `GET /health`, `GET /me`, `GET /meta/lists/{list}/fields`, `POST /enterprises/query`, `GET /enterprises/{id}`; list conventions (`ListQuery` filter tree with AND/OR groups and the §13.25 operators, sort, cursor paging, `problem+json` errors); WebSocket frame = Phoenix Channels V2, events `live:dashboard/summary`, `live:tps/tick`, `alerts:<userId>/incident` | §1, §3, §5.1, §13.3, §13.6, §13.25, §14.2, §15.1 | Build step 1 | Mock done |

## Decisions

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
- `translation_rule_attachments` and `hlr_rule_attachments`: rules attach directly to trunks with a per-trunk position, no groups (§13.2).
- `transactions.send_confirmation`, `confirmation_status`, `include_in_soa`, `exclude_reason` (§13.33). `vendor_invoices.our_amount` / `our_volume` / `recon_status` (§13.31).
- `changes`: one row per save with a field-level diff and `undo_of_id` (§13.10).
- `deleted_at` / `deleted_by_id` on every archivable record; nothing is hard-deleted (§13.29).
- EDRs copy rate, cost, exchange rate and base-currency values at send time (§13.29, §13.32).

## Open questions

- MCC/MNC master (§6.1): the spec says about 1,965 entries; the generator uses a public list with 2,063 networks after cleaning, plus one "All networks" code per MCC. Which list is the source of truth for production, and who maintains it?
- Dial-code Master Table (§6.1): the generator makes up the prefixes below each real country dial code. Production needs a real numbering-plan source (and MNP/HLR for ported numbers). Which one?
- Shared MCCs (e.g. Guam uses the US MCCs 310/311): the generator gives the "All networks" code to the country with most networks on that MCC and none to the other. Is that the rule we want, or should territories get their own country-level code?
- Customer billing on re-routed messages: the generator bills the customer once, on the final attempt only, and the vendor on every attempt it accepted. Confirm this matches finance's expectation.
- Translation/HLR rules "Applies to" an enterprise, a category or all trunks (§13.2): the schema stores only direct trunk attachments. Should scope targets be stored as their own rows (and expanded at run time), or expanded into trunk attachments on save?
