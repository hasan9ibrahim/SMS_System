# Backend to-do and contract change log

Every change made to `contract/` during the frontend phase is logged here, so the
backend team knows exactly what to build. Newest first.

| Date | Screen | Contract change | Spec § | Requested by | Status |
| --- | --- | --- | --- | --- | --- |
| 2026-10-16 | (all) | Contract skeleton v0.1.0: `GET /health`, `GET /me`, `GET /meta/lists/{list}/fields`, `POST /enterprises/query`, `GET /enterprises/{id}`; list conventions (`ListQuery` filter tree with AND/OR groups and the §13.25 operators, sort, cursor paging, `problem+json` errors); WebSocket frame = Phoenix Channels V2, events `live:dashboard/summary`, `live:tps/tick`, `alerts:<userId>/incident` | §1, §3, §5.1, §13.3, §13.6, §13.25, §14.2, §15.1 | Build step 1 | Mock done |

## Open questions

- Saved filter views (§13.25 "saved as named views and shared"): shared with whom: everyone, the user's department, or chosen users? Needed before the views endpoint is added to the contract.
- Billing data retention period (spec §13.29 uses 7 years as a placeholder; confirm with accounting).
- Excluded payments (§13.33): should they also be removed from the partner balance, or only from the SOA?
