# SMS Aggregation Platform: project brief for Claude Code

Read this file at the start of every session. The full requirements are in
`docs/PRODUCT_SPEC.md`. That file wins over anything here if they disagree.

## What we are building

A new SMPP-based SMS aggregation platform: partners (customers and vendors), trunks,
rates, routing, billing, monitoring and reports. It replaces the platform we use
today. It must cover every screen in spec sections 3–12, plus every change in
section 13, using the design in section 15.

## Current phase: frontend on fake data

We build the GUI first so the team can use it on fake data while the backend is built.
Nothing in this phase touches live traffic or the current platform.

Hard rules for this phase:

1. **Fake data only.** No real customer or vendor names, no real credentials, IPs or
   rates. Never connect to the current production platform or copy data from it.
2. **Contract first.** Every screen talks to the backend only through the API contract
   in `contract/`. To change what a screen needs, change the contract first. The mock
   server answers the contract today. The Elixir backend answers the same contract
   later, and the screens must not need changes when that switch happens.
3. **Server-side lists.** Filtering, sorting, paging and search run on the server,
   never in the browser. Use the filter grammar from spec §13.25: per-column filters,
   the multi-field builder with AND/OR, `%` and `_` wildcards, case-insensitive, regex.
   Lists scroll with virtualisation; never load all rows.
4. **Realistic volume.** The generator must produce production-like data: thousands of
   destinations (real MCC/MNC list), hundreds of trunks, rate tables with history, and
   millions of EDRs. A screen is "done" only when it is fast at that volume.
5. **Live data over WebSocket.** Live dashboard, analytics, alerts and hover volumes
   receive pushed events from the mock traffic generator, using the same event format
   the Phoenix Channels backend will send.
6. **Log every change.** Any change the team requests goes in `docs/BACKEND_TODO.md`
   (what changed in the contract, and which spec section it touches).

## Stack (spec §14)

| Part | Choice |
| --- | --- |
| GUI | TypeScript, React, Vite. TanStack Query (data), TanStack Table + TanStack Virtual (grids), React Router, Zustand (UI state such as tabs), ECharts (charts) |
| API contract | OpenAPI 3.1 in `contract/openapi.yaml`, plus JSON Schemas for WebSocket events in `contract/events/`. TypeScript types are generated from it (openapi-typescript) |
| Mock server (this phase) | TypeScript (Fastify) implementing the contract |
| Config data | PostgreSQL (docker). The schema is written to be reused by the Elixir backend |
| EDRs and reports | ClickHouse (docker), seeded by the generator |
| Live counters | Redis (docker) |
| Final backend (later phase) | Elixir: SMPP switch, Phoenix API and Channels, billing and jobs. NATS JetStream between services (`docs/BACKEND_PLAN.md`) |

Proposed repo layout:

```
docs/              PRODUCT_SPEC.md, design/ screenshots, BACKEND_TODO.md
contract/          openapi.yaml, events/*.json
web/               React app
mock/              Fastify mock server, data generator, live traffic simulator
backend/           Elixir umbrella (later): switch, core, api
tools/smpp-sim/    SMPP simulator and load tests (later)
docker-compose.yml postgres, clickhouse, redis
```

## Design (spec §15)

- One window layout on every page:
  - top bar with the main menu (a drawer up to 1180 px)
  - page tab strip (tabs can be dragged out into their own window, §13.5)
  - page header with the title and actions (no sibling links)
  - filter card: quick search with field pills, switches, Views, Columns
  - data grid with a filter under every column header
  - detail panel on the right
  - status bar
- Light, dark and blue-grey themes: only the tokens in `web/src/styles/tokens.css` (§15.2).
- Inter (bundled), the type-scale tokens 11 / 12 / 13 / 14 / 17 / 22 px (§15.3), 22 px page titles,
  tabular numbers in grids, 14 px card corners, 1 px borders.
- One filled accent button per page. Colour only carries meaning: green good, amber warning, red
  problem; categories are neutral (Live analytics bands are the one exception, §15.3).
- No spec sections, build steps or trial rounds in anything users see; § references stay in code comments.
- Reference screenshots: `docs/design/gui_light.png`, `gui_dark.png` and
  `rate_manager.png` show the original look; §15 describes what is built where they differ.
- **Exception: Route Rules.** That page follows the screenshot's layout and form, as listed in
  spec §15.4: header actions, grid columns with per-column filters, the detail panel
  (Edit / Configuration / Conditions / Traffic / History / Test) with condition chips, and the
  status bar.

## Build order

1. Repo skeleton, docker-compose, contract skeleton, type generation.
2. Fake data generator: enterprises, trunks, MCC/MNC master, rate tables with history,
   route, translation and HLR rules, users and AMs, invoices, payments, EDRs.
3. App shell: top menu, tabs (drag-out windows), theme switch, Ctrl K jump-to, standard
   grid component with column filters and the filter builder (§13.25), undo/history hooks.
4. Screens the team uses daily, in this order:
   1. Enterprises and trunks (§5)
   2. Rate Manager (§13.12)
   3. Route Rules (§6.3, §13.8–13.11, §13.27)
   4. Rate Lookup (§13.16)
   5. Enterprise report (§13.31)
   6. Live dashboard (§13.3)
5. The remaining screens, in the order of spec sections 6–13.
6. Team trial on fake data. Feed requested changes into the contract and `BACKEND_TODO.md`.

In parallel (Elixir developer): the SMPP engine — binds, submit_sm/deliver_sm, DLRs,
session affinity §13.1 — load-tested against an SMPP simulator.

## Business rules the UI must already respect

- Per-user undo and change history on rules and rates (§13.10). Each save is one change.
- Safe delete: delete archives, shows dependencies, and is blocked while billing items are open (§13.29).
- AM visibility mode, masking and hiding (§13.17). AM attribution is taken at send time (§13.30).
- A vendor RN never re-rates traffic already sent (§13.32).
- Monthly password change and 2FA (§13.28).
- Sensitive exports (credentials) are admin-only, need 2FA and produce an encrypted file (§13.22).

## Working conventions

- Keep the spec section number in code comments and commit messages for traceability (e.g. `feat(route-rules): hover volume breakdown (§13.27)`).
- Write small, reviewable changes, and test every list endpoint with the full generated volume.
- When the spec is unclear, stop and ask instead of guessing. Add the question to `docs/BACKEND_TODO.md` under "Open questions".
