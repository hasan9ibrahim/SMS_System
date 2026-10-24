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

## SMPP PDUs (step 1)

`Sms.Switch.Smpp.Pdu.decode/2` frames a byte stream strictly by `command_length` and returns one PDU and the rest,
`{:incomplete, n}`, or an error that carries the SMPP status to answer with (`error_reply/1` builds the answer: the
request's own response with that status, or `generic_nack`). A bad `command_length` is the only fatal error.
`encode/1` checks every field against SMPP 3.4 before anything is sent. Every 3.4 command and TLV is covered; unknown
and vendor TLVs are kept as `{tag, binary}`.

## Customer side (step 2)

`Sms.Switch.Customer` is where the switch is the SMSC (spec §2, §5.4, §13.1). Each client connection is a
`Sms.Switch.Customer.Session`:

- **Binds** are checked against the customer trunks, which are loaded from PostgreSQL every 5 s
  (`Sms.Switch.Customer.TrunkStore`). The checks run in this order:
  1. the client IP is not banned on the Firewall screen (§8): the SMPP / All filters there count failed binds
     and ban an IP past their threshold, for their ban time;
  2. `system_id` exists (0x0F);
  3. the client IP is allowed (0x0D);
  4. the password is right (0x0E);
  5. the trunk is active;
  6. a TLS trunk came in over TLS at its version or newer (0x0D);
  7. `system_type` matches, when the trunk sets one (0x53);
  8. the trunk allows this bind type;
  9. the trunk has fewer binds than Max Connections, counted on both servers.

  A refused bind is answered, published on the bus and the connection is closed.
- **Message requests** (`submit_sm`, `data_sm`, `query_sm`, `cancel_sm`) are counted against the trunk's TPS
  (`tps × max_connections`) and the business company's limit. The count is shared in Redis; over a limit the answer
  is 0x58. Accepted requests go to the `Sms.Switch.Customer.Intake` behaviour, each in its own process, and the
  answer goes back on the same connection with the same sequence number (§13.1 rule 1). The message pipeline
  implements the intake in step 4; until then every request gets 0x45.
- **Flow control:** at most `inbound_window` requests are in flight per session; past that the socket is not read, so
  TCP pushes back on the client. `deliver_sm` has its own window.
- **Keep-alive:** `enquire_link` after 30 s of silence, with TCP keepalive underneath.
- **Unbind:** the answers already being decided go out before `unbind_resp`. When a trunk changes, or the node
  stops or drains (`Sms.Switch.Customer.drain/0`), the switch unbinds the trunk's sessions itself.
- **Receipts:** `Sms.Switch.Customer.deliver/4` picks the session by DLR Session Affinity (strict, same IP, same
  trunk) on either server, or answers `:hold`.

Every server listens on **2775 (plain) and 2776 (TLS)** for all customers (`SMPP_PORTS`, `SMPP_TLS_PORTS`; the TLS port
needs `SMPP_TLS_CERTFILE` / `SMPP_TLS_KEYFILE`). `SMPP_PROXY_PORTS` lists ports behind a load balancer that sends a
PROXY header.

## Run it

Versions are pinned in `.tool-versions` (Erlang/OTP 28.5, Elixir 1.19.6). From the repo root:

```sh
docker compose up -d                     # PostgreSQL, ClickHouse, Redis, NATS (JetStream)
cd backend
mix deps.get
mix test                                 # unit and property tests, no stores needed
INTEGRATION=1 mix test                   # plus the tests against the real stores, NATS and a second node
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
