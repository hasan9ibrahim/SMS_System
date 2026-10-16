# SMS_System

SMPP SMS aggregation platform: partners, trunks, rates, routing, billing, monitoring
and reports. Requirements: [`docs/PRODUCT_SPEC.md`](docs/PRODUCT_SPEC.md). Project brief
and phase rules: [`CLAUDE.md`](CLAUDE.md).

**Current phase: frontend on fake data.** The GUI talks to a mock server through the API
contract; the Elixir backend replaces the mock later behind the same contract.

## Layout

```
docs/              PRODUCT_SPEC.md, design/ screenshots, BACKEND_TODO.md
contract/          openapi.yaml, events/*.json, generated/ TypeScript types
web/               React + Vite GUI
mock/              Fastify mock server (data generator and live traffic simulator follow)
db/                PostgreSQL and ClickHouse init scripts and migrations
backend/           Elixir umbrella (later phase)
tools/smpp-sim/    SMPP simulator and load tests (later phase)
docker-compose.yml postgres, clickhouse, redis
```

## Getting started

Requires Node 22 (`.nvmrc`), Git and Docker Desktop.

**Windows PowerShell:** if `npm` fails with "running scripts is disabled on this system",
run this once (it only affects your user account), then reopen PowerShell:

```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```

Or use `npm.cmd` instead of `npm`, or run the commands in Command Prompt (cmd).

```bash
cp .env.example .env      # fake local-only values; never commit .env
npm install
npm run db:up             # postgres :5432, clickhouse :8123/:9000, redis :6379
npm run dev:mock          # mock API on http://127.0.0.1:4010/api/v1
npm run dev:web           # GUI on http://localhost:5173 (proxies /api and /socket to the mock)
```

## Everyday commands

| Command | What it does |
| --- | --- |
| `npm run gen` | Regenerate TypeScript types from `contract/` (run after every contract change) |
| `npm run check` | Everything CI runs: contract lint, generated-types check, typecheck, tests, build |
| `npm run lint:contract` | Lint `contract/openapi.yaml` (Redocly) |
| `npm test` | Contract self-tests and mock-server tests (every response checked against the contract) |
| `npm run db:down` | Stop the databases (data stays in Docker volumes) |

## Rules for this phase

Fake data only, contract first, server-side lists, production-like volume, live data over
WebSocket, and every requested change logged in `docs/BACKEND_TODO.md`. See `CLAUDE.md`.
Secrets never go in the repo: real credentials, when needed, live in local `.env` files,
which `.gitignore` excludes.
