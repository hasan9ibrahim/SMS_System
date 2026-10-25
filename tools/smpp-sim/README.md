# SMPP simulator and load tests (backend step 7)

Fake customers (ESMEs) and fake vendors (an SMSC) that drive the switch over real SMPP, measure it and check that
nothing was lost. It compiles the switch's own PDU codec (`backend/apps/sms_switch/lib/sms/switch/smpp`), so both
sides speak exactly the same SMPP. **Fake data only:** it never connects to the current platform.

Results of the runs so far: `docs/LOAD_TEST_RESULTS.md`.

## What it does

* **Customers:** `--trunks` × `--sessions` transceiver sessions spread over the switch nodes' ports, each sending
  its share of the rate with a window of `--window` open submits (random phase, so sessions do not burst together).
  Texts are unique per message, `--multipart` percent are two-part UDH messages. Every receipt is matched to its submit.
* **Vendors:** one SMSC on `VENDOR_PORT` (9100) for every fake vendor trunk. Answers in `--resp-ms`, receipts after
  `--dlr-ms`, `--vendor-errors` percent refused with 0x58. It flags any duplicate submit (same number and text), and
  sends a receipt again when the switch refuses it or the connection drops before it is answered, as real SMSCs do.
* **Checks** (one row each in the report): rate sent, submit errors, submit_sm_resp p99 under `--resp-p99-ms`,
  receipts for ≥ 90 % of accepted parts at the end of the drain, and with `--clickhouse` one EDR per accepted message.
  Also reported: machine CPU, the switch nodes' CPU and memory (`--switch-pids`), throttled (0x58) answers,
  duplicates, receipt delay.

## Scenarios

| Scenario | What | Example |
| --- | --- | --- |
| steady | one rate for a while | `mix sim.run steady --rate 1000 --duration 300` |
| ramp | step the rate up until a step fails: the breaking point | `mix sim.run ramp --from 100 --step 100 --step-seconds 60 --max 5000` |
| spike | base, peak, base: does it absorb and recover? | `mix sim.run spike --base 150 --peak 1000 --spike-seconds 20` |
| soak | one rate for hours, measured in chunks: memory growth, latency drift | `mix sim.run soak --rate 200 --duration 1800 --chunk-seconds 300` |
| failover | kill (or cut off) one server under traffic, bring it back | see below |

## Running it

Needs the docker-compose services (PostgreSQL, ClickHouse, Redis) with the seeded development data, Docker for the
load-test NATS, and Elixir. Everything runs from `tools/smpp-sim`.

```sh
mix deps.get
NATS_MODE=default scripts/setup.sh        # sms_load DB, sms_load_edr, Redis flushed, NATS on 4223, run/loadtest.json

scripts/switch.sh start a 2775 1 b        # node a, customers on 2775, node id 1, peer b
scripts/switch.sh start b 2785 2 a

mix sim.run steady --rate 200 --duration 120 --ports 2775,2785 \
  --switch-pids "$(scripts/switch.sh pid a),$(scripts/switch.sh pid b)" \
  --clickhouse "http://$CLICKHOUSE_USER:$CLICKHOUSE_PASSWORD@localhost:8123/?database=sms_load_edr"

scripts/switch.sh stop a; scripts/switch.sh stop b
scripts/switch.sh purge                   # empty the stream between runs
```

`NATS_MODE` is `always` (fsync every write, the design today) or `default` (fsync every 2 minutes; safety from the
second server's copy). Reports go to `results/` (Markdown and JSON, not committed).

### Failover

Kill one server with SIGKILL under traffic, start it again 60 s later:

```sh
DIST_PORT=9101 scripts/switch.sh start a 2775 1 b
DIST_PORT=9102 scripts/switch.sh start b 2785 2 a
mix sim.run failover --rate 200 --ports 2775,2785 \
  --kill "scripts/switch.sh kill b" --restore "DIST_PORT=9102 scripts/switch.sh start b 2785 2 a"
```

Cut the link between the two servers instead (both still reach the databases), then heal it:

```sh
mix sim.run failover --rate 200 --ports 2775,2785 \
  --kill "scripts/partition.sh cut 9101 9102" --restore "scripts/partition.sh heal 9101 9102"
```

`scripts/partition.sh` uses `iptables` (sudo). `--kill-after`, `--restore-after` and `--after-restore` set the timing.

### Load from another machine

On a real two-server setup run the vendors on one machine (`mix sim.smsc --port 9100`) and the customers on another
(`mix sim.run ... --no-smsc --host SWITCH_IP`), so the simulator does not take CPU from the switch.

## Development

```sh
mix format --check-formatted && mix compile --warnings-as-errors && mix credo --strict && mix test --cover
```
