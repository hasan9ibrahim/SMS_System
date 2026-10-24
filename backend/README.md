# backend/: the Elixir backend

The platform's backend (spec §14, `docs/BACKEND_PLAN.md`). It replaces the mock server: it must answer
`contract/openapi.yaml` and push the events in `contract/events/` exactly as the mock does today, so the screens need no
change. It reuses the PostgreSQL schema in `db/postgres/migrations/` and the ClickHouse schema in
`db/clickhouse/migrations/`.

## Apps

| App | What it holds |
| --- | --- |
| `apps/sms_core` | The data stores (`Sms.Core.Repo` PostgreSQL, `Sms.Core.ClickHouse` EDRs, `Sms.Core.Redis` live counters), the event bus (`Sms.Core.Bus`, NATS JetStream) and the health check. From step 4: rating, routing, billing. |
| `apps/sms_switch` | The SMPP 3.4 switch: PDUs (step 1), customer side (step 2), vendor side (step 3), message pipeline (step 4). |

The API (Phoenix, the contract) and the jobs app join in phase B.

## Run it

Versions are pinned in `.tool-versions` (Erlang/OTP 28.5, Elixir 1.19.6). From the repo root:

```sh
docker compose up -d                     # PostgreSQL, ClickHouse, Redis, NATS (JetStream)
cd backend
mix deps.get
mix test                                 # unit and property tests, no stores needed
INTEGRATION=1 mix test                   # plus the tests against the real stores and NATS
INTEGRATION=1 mix check                  # everything CI runs (below); must pass before any push
```

The connection settings come from the same environment variables as the mock server (`.env.example`):
`POSTGRES_*`, `CLICKHOUSE_*`, `REDIS_*`, and `NATS_HOSTS` (comma-separated `host:port`).

## Quality gates (`mix check`, CI job `backend`)

1. `mix format --check-formatted`
2. no unused dependencies in `mix.lock`
3. no retired packages and no known vulnerabilities in dependencies (`hex.audit`, `deps.audit`)
4. compile with warnings as errors
5. Credo, strict
6. Dialyzer (types), 0 warnings
7. every test, integration included, with at least 90 % coverage per app

## The event bus

```elixir
{:ok, event} = Sms.Core.Bus.publish("sms.msg.accepted", "msg.accepted", %{"msg_id" => "..."})

defmodule Sms.Billing.Rater do
  use Sms.Core.Bus.Consumer, name: "billing-rater", filter: "sms.msg.>"

  @impl true
  def handle_event(%Sms.Core.Bus.Event{} = event), do: :ok
end
```

- `publish/4` returns `{:ok, event}` only after JetStream has stored the event on disk (on three nodes in
  production). A retried publish with the same `:id` is stored once.
- A consumer gets each matching event at least once and continues where it stopped after a restart. Return `:ok`,
  `{:error, reason}` (delivered again after `ack_wait`, up to `max_deliver` times) or `{:discard, reason}`. Handlers
  must be idempotent: the event id is the key.
- Tests use `Sms.Core.Bus.Local` (in memory, same rules); the integration tests run the same checks on NATS.
