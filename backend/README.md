# backend/: the Elixir backend

The platform's backend (spec §14, `docs/BACKEND_PLAN.md`). It replaces the mock server: it must answer
`contract/openapi.yaml` and push the events in `contract/events/` exactly as the mock does today, so the screens need no
change. It reuses the PostgreSQL schema in `db/postgres/migrations/` and the ClickHouse schema in
`db/clickhouse/migrations/`.

## Apps

| App | What it holds |
| --- | --- |
| `apps/sms_core` | The data stores (`Sms.Core.Repo` PostgreSQL, `Sms.Core.ClickHouse` EDRs, `Sms.Core.Redis` live counters), the event bus (`Sms.Core.Bus`, NATS JetStream) and the health check. Billing joins in step 6. |
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
  is 0x58, unless the trunk has an overflow buffer with room: then the message is accepted and the pipeline sends it
  when the TPS allows (S-2.4). Accepted requests go to the `Sms.Switch.Customer.Intake` behaviour (the message
  pipeline, step 4), each in its own process, and the answer goes back on the same connection with the same sequence
  number (§13.1 rule 1).
- **Flow control:** at most `inbound_window` requests are in flight per session; past that the socket is not read, so
  TCP pushes back on the client. `deliver_sm` has its own window.
- **Keep-alive:** `enquire_link` after 30 s of silence, with TCP keepalive underneath.
- **Unbind:** the answers already being decided go out before `unbind_resp`. When a trunk changes, or the node
  stops or drains (`Sms.Switch.Customer.drain/0`), the switch unbinds the trunk's sessions itself.
- **Receipts:** `Sms.Switch.Customer.deliver/4` picks the session by DLR Session Affinity (strict, same IP, same
  trunk) on either server, or answers `:hold`. A session holds a receipt back (at most 1 s) while the submits that
  were open when it came are answered, so a client never gets a receipt before its own `submit_sm_resp`.

Every server listens on **2775 (plain) and 2776 (TLS)** for all customers (`SMPP_PORTS`, `SMPP_TLS_PORTS`; the TLS port
needs `SMPP_TLS_CERTFILE` / `SMPP_TLS_KEYFILE`). `SMPP_PROXY_PORTS` lists ports behind a load balancer that sends a
PROXY header.

## Vendor side (step 3)

`Sms.Switch.Vendor` is where the switch is the client of each vendor's SMSC (spec §2, §5.5). The vendor trunks are
loaded from PostgreSQL every 5 s (`Sms.Switch.Vendor.TrunkStore`).

- **Connections:** each active trunk opens its Max Connections connections, **split between the servers**
  (`Sms.Switch.Vendor.Manager`, decision Q12): connection `i` of trunk `t` goes to the node at `rem(t + i, n)` among
  the `n` running nodes. A server left alone opens them all and gives half back when the other returns.
- **Each connection** (`Sms.Switch.Vendor.Session`) connects from the trunk's Source Host, over TCP or TLS at the
  trunk's version or newer, and binds as TX, RX or TR with the username, password, System Type and bind address.
  The vendor's certificate is checked against the system CAs and the host name (`VENDOR_TLS_VERIFY=peer`, the
  default; `none` accepts any certificate).
- **Reconnect:** a failed connect, a refused bind, a dropped connection or the vendor's unbind waits the next value
  of the trunk's reconnect schedule (the last repeats; reset once bound). A refused password or system ID (0x0E,
  0x0F) waits Auth Fail Retry instead. After Bind Alert minutes down, `sms.session.vendor.bind_down` is published
  once, and `bind_up` when it binds again.
- **Keep-alive:** `enquire_link` after the trunk's Enquire Link Interval of silence; no answer within its timeout
  drops the connection and opens it again.
- **Submits** (`Sms.Switch.Vendor.submit/5`): one TPS count per trunk (`tps × max_connections`) shared by both
  servers in Redis; then a bound connection, this server's first. Window Size answers waiting per connection,
  Submit Interval between submits. No answer within Submit Timeout gives `{:error, :timeout}` (the message may have
  been sent, so the pipeline re-routes it, D4); an answer that arrives later is published as
  `sms.session.vendor.late_response` so the message is flagged as a possible duplicate. The vendor's message id is
  normalised by MsgID Type (`Sms.Switch.Vendor.MessageId`, S-5.6).
- **Receipts and MO** (`deliver_sm`, `data_sm`) go to the `Sms.Switch.Vendor.Receipts` behaviour, each in its own
  process, and are answered with its status: the message pipeline (step 4) records them; MO is answered OK and
  logged (Q7, S-5.12).
- **Trunk changes:** new connection settings (host, port, credentials, TLS, bind type or address) unbind and bind
  again at once; other settings apply to live connections in place. A deactivated or deleted trunk is unbound.

## Message pipeline (step 4)

`Sms.Switch.Pipeline` takes each message from `submit_sm` to the vendor and its receipt back (spec §2, §6, §13.1,
`docs/SMPP_SCENARIOS.md`). The parts:

- **Configuration in memory** (`Pipeline.Config`, `Config.Server`, `Config.Loader`): destinations, trunks, route
  rules, translation rules, number lists, LCR profiles, QBR quality and exchange rates are one snapshot, read from
  PostgreSQL in one transaction and swapped whole when a cheap fingerprint query changes (checked every 5 s). Rate
  lines live in ETS, reloaded per rate table when that table's fingerprint changes (every 15 s). A message never
  waits for the database, and routing keeps working while PostgreSQL is down (S-7.2). Until the first load the
  intake answers 0x08.
- **The rules engines** are ports of the mock's, with its tests as the spec, so the switch decides as the screens'
  Test and Route Simulator do: `Rules.Translation` (§6.4, §13.2), `Rules.Route` and `Rules.Lcr` (§6.3, §13.23),
  `Rules.Pattern` (JavaScript regex semantics on PCRE). `Message.Text` and `Message.Concat` do the encodings, part
  counts, splitting and UDH / SAR parsing.
- **Intake** (`Pipeline.Intake`, the customer side's intake): checks the message (body, encoding, concatenation,
  addresses; empty messages refused, D10), runs the customer trunk's translation rules, finds the destination and
  the customer's rate, routes it (`Pipeline.Router`), checks credit (`Pipeline.Credit`), and publishes it on the bus
  (`sms.msg.accepted`). The `submit_sm_resp` goes out only once the bus has stored it (S-2.2); a refused message
  gets its status at once and an EDR row. A Delayed Submit trunk's resp waits for the vendor's final outcome instead
  (`Pipeline.Delayed`, S-2.18, D11). Duplicates within the trunk's window get the first message's id and are not sent
  again; a message coming back from a vendor on another trunk while ours is in flight is refused (D6, S-5.16).
- **Reassembly** (`Pipeline.Reassembly`): each part of a customer multipart message (UDH or SAR) is answered at once
  and held in Redis; with the last part the whole text is translated, rated and routed once (S-3.2–S-3.7). A group
  still incomplete after the trunk's reassembly timeout (default 120 s), or refused once put together, gets a REJECTD
  receipt per part (error 099, or the refusal's code) and is not billed (D1).
- **Sender** (`Pipeline.Sender`, consumer `pipeline-sender`): runs the vendor's egress translation, encodes again
  when the text changed (UCS-2 when it no longer fits), splits with UDH when needed, always asks the vendor for
  receipts, and sends, split in the vendor trunk's multipart format (8- or 16-bit UDH, SAR, message_payload); a
  vendor without multipart or with a shorter Max Msg Len is skipped (S-3.9, S-3.10). Temporary refusals are tried
  again on the same vendor; any other refusal, a timeout or a lost connection moves to the next vendor in the rules'
  order; none left → the customer gets a REJECTD receipt (UNKNOWN when the last vendor may have it). A translation
  that adds parts is blocked (D3). A late OK after a timeout is written as a possible duplicate (D4,
  `Pipeline.LateResponses`).
- **Receipts** (`Pipeline.Receipts`, the vendor side's handler) and **forwarding** (`Pipeline.Forwarder`, consumer
  `pipeline-forwarder`): a receipt finds its message by the vendor's id in either base (S-5.6), the first final
  status of each part wins (S-5.8), and a split message gets one receipt once all its parts have one (S-5.9). The
  customer gets what it asked for (registered_delivery), after the DLR status maps of the vendor trunk's and the
  customer trunk's rules. A receipt that came before its `submit_sm_resp` is kept a minute and applied (S-5.5).
  With no session to take it, the receipt is held per trunk (`Pipeline.Held`) and sent as soon as one binds, up to
  the trunk's DLR hold hours (72 by default). A failed receipt from a delivery-billed vendor whose Re-Route on lists
  its status sends the message to the next vendor when no part was delivered (S-5.11, D2).
- **Timeouts** (`Pipeline.Timeouts`): with no final receipt by the vendor trunk's DLR Timeout the customer gets the
  trunk's DLR Timeout Status (S-5.10); a vendor receipt that comes later is matched from the EDRs and only corrects
  them (`Pipeline.LateReceipts`, D5).
- **query_sm and cancel_sm** (`Pipeline.Queries`, S-2.15, D8): query_sm from Redis and the EDRs, only for the asking
  customer's own messages; cancel_sm only while the message is still queued (0x11 after); replace_sm 0x03.
- **Live TPS** (`Pipeline.LiveTps`, §13.8, §13.23): counts per customer trunk, enterprise, destination, sender, rule
  and vendor trunk, shared between the servers through Redis once a second; route rules' TPS conditions (with hold
  and release hysteresis), the rule's "skip a vendor at N % of its TPS limit" and LCR's "at its TPS limit".
- **Store** (`Pipeline.Store`): what both servers need about a message in flight lives in Redis (`m:`, `v:`, `o:`,
  `h:`, `t`, `rg:`, `dup:`, `lp:`, `pd:`, `rs:`, `q:`, `lt:` keys). A message is deleted as soon as every part has its final receipt and the customer's receipt is
  queued; one still waiting expires after the vendor trunk's DLR timeout plus an hour. So Redis holds only messages
  waiting for a receipt.
- **EDRs** (`Pipeline.Edr`, `Pipeline.EdrWriter`): one `edr` row per vendor attempt (or per refused message) and one
  `edr_receipt` row per receipt from a vendor and per receipt to the customer (ClickHouse migration
  `003_edr_receipt.sql`), appended, never updated. Rows go through the bus (`sms.edr.*`) to a writer that inserts
  them in batches of up to 1,000 and retries until ClickHouse takes them; only a row ClickHouse cannot read is
  dropped (logged), never a batch.
- **Billing** (`Pipeline.Billing`, §7): revenue, cost and the billable flags at the rates in force when the message
  was submitted, per trunk Billing Type. Attempt and submit are decided when the attempt ends (on the `edr` row);
  reported and delivery when its final status is known, on an `edr_receipt` **outcome** row (ClickHouse
  `005_outcome_billing.sql`), which also carries the attempt's final status into `edr_hourly` through its own view.
  The customer is billed once per message, on the status it is told; a vendor on its own status.
- **Ledger** (`Pipeline.Ledger`, `Ledger.Sync`, `Ledger.Charges`, §7, Q24): live balances. The base (opening +
  payments − invoices) comes from PostgreSQL's `balance_ledger` view every 5 s; traffic is charged when it becomes
  billable, through the bus, into 15-minute buckets in Redis (`chg:`, `chm:`, `cht:`, `cd:`, `chd`) written back to
  `traffic_charges` (migration 072). The credit check before the resp: balance + credit limit must cover the message
  (prepaid stops at 0), else 0x45; one minute of grace on the last total when Redis is unreachable. Credit alerts
  (`Ledger.Alerts`): Notice / Warning / Critical / limit reached, and prepaid balances used up (vendors alert only,
  Q22), as `sms.billing.credit_alert` events (`cal:` keys).
- **Accumulated revenue** (`Pipeline.Revenue`, §13.9): revenue earned per customer trunk, enterprise, destination,
  sender and rule in 15-minute buckets (`rv:`), counted with the customer's charge; route rules read it over 15 / 60
  minutes, today, week, month (the customer's time zone) or the billing cycle.

Message ids given to customers are 20 hex characters: milliseconds, the server's `SWITCH_NODE_ID` (0–255, different
on each server) and a counter. Rates and margins compare in `PLATFORM_CURRENCY` (default EUR).

Not yet built (planned): HLR lookups; e-mails for credit alerts (the API sends them from the events).

## Run it

Versions are pinned in `.tool-versions` (Erlang/OTP 28.5, Elixir 1.19.6). From the repo root:

```sh
docker compose up -d                     # PostgreSQL, ClickHouse, Redis, NATS (JetStream)
python3 ../tools/apply_clickhouse.py     # the EDR tables (CH_URL, CH_AUTH; the mock applies them on start too)
cd backend
mix deps.get
mix test                                 # unit and property tests, no stores needed
INTEGRATION=1 mix test                   # plus the tests against the real stores, NATS and a second node
INTEGRATION=1 mix check                  # everything CI runs (below); must pass before any push
```

The connection settings come from the same environment variables as the mock server (`.env.example`):
`POSTGRES_*`, `CLICKHOUSE_*`, `REDIS_*`, and `NATS_HOSTS` (comma-separated `host:port`). The switch adds
`SWITCH_NODE_ID`, `SWITCH_CLUSTER_SIZE`, `PLATFORM_CURRENCY` and the `SMPP_*` listener settings.

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
- `concurrency: n` handles n events at once on each node; `batch_size: n` hands events to `handle_batch/1` in
  batches instead (acknowledged only when the batch is handled); `max_deliver: :infinity` never gives up, for events
  that must never be lost (EDRs).
- Tests use `Sms.Core.Bus.Local` (in memory, same rules; it delivers inside `publish`, batch consumers get batches of
  one); the integration tests run the same checks on NATS.
