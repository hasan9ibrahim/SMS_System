# Load test results (backend step 7)

Run 2026-10-25 with `tools/smpp-sim` (how to run it: `tools/smpp-sim/README.md`). Fake data only: fake customers,
fake vendors, the seeded development config with 10 load-test customer trunks and 10 vendor trunks on every MCC/MNC.

**The machine is not the production server.** Everything ran on one development VM with 4 vCPUs (Xeon at 2.1 GHz)
and 16 GB: both switch nodes, PostgreSQL, ClickHouse, Redis, NATS and the simulator itself, which uses about one core
at the top rates. The figures are a floor. The capacity numbers for the real servers come from running the same
scenarios on them in step 8.

The targets (Q3): **1,000 TPS peak, 50 million a day** (580/s on average).

## 1. Summary

| Question | Answer on this VM |
| --- | --- |
| Highest rate one node keeps up with, end to end | **400 msg/s** (submit_sm_resp p99 158 ms, machine CPU 94 %); falls behind at 500/s |
| Highest rate within the 50 ms p99 answer target | 200 msg/s (one node) |
| With NATS writing to disk on every event (`always`) | half of that: 200/s end to end, 100/s within 50 ms |
| A burst to 1,000/s for 20 s (two nodes at 150/s) | **absorbed, nothing lost**: every message accepted and delivered, back to normal in about 60 s |
| Past capacity (600/s with `always`) | the new overload guard answers 0x58 (throttled) so the customer's platform slows down; every accepted message still got its receipt and EDR |
| One server killed (`kill -9`) under traffic | **no message lost**: every accepted message delivered with an EDR. 1 duplicate receipt; 3 submits that were in flight on the dead server got no answer (the customer's platform resends them) |
| The link between the two servers cut | **no message lost, no duplicate sent to a vendor**; 3–5 duplicate receipts; receipts up to 21 s late while the link was down (p99 about 9 s) |
| 30-minute soak at 200/s on two nodes | **383,071 messages, none lost**: a receipt and an EDR for every one, no duplicates, memory flat (375 + 404 MB), no drift; answer p99 128–274 ms (the VM at 85–88 % CPU) |

**What this means for 1,000 TPS.** The switch costs about 4–7 ms of CPU per message on this vCPU (it does about
20 Redis round trips and 20 NATS messages for each message: routing, TPS limits, credit check, store, send, receipt,
EDR, charges). So 1,000/s needs about 5–7 cores of this kind for the switch alone, plus NATS, Redis and ClickHouse.
A current dedicated server (16 or more cores, faster per core than this VM) should carry 1,000/s on one server with
the other as standby, but without much headroom; the CPU work below (§6) would add it. The NATS disk setting decided
on 2026-10-25 (the default) is the one these figures use; writing every event first would have halved them.

## 2. Problems found and fixed

Each was found by a scenario, fixed in this step and the scenario run again.

| # | Found by | Problem | Fix |
| --- | --- | --- | --- |
| 1 | steady | submit_sm_resp took 44 ms at low traffic: the Redis and NATS connections waited up to 40 ms to batch small writes (Nagle) | `nodelay` on both: **3.7 ms** |
| 2 | ramp | one NATS connection per node was the limit | 4 connections per node |
| 3 | ramp | the EDR writer fetched one event per request from NATS | 256 per request; charges with 4 workers |
| 4 | ramp | docker's port proxy took a third of a core for NATS | host networking for NATS (test setup; production runs NATS natively) |
| 5 | overload | past capacity the switch kept accepting while the sender fell behind: messages left minutes late although accepted | **overload guard**: while accepted messages wait longer than 10 s for the sender (`SWITCH_MAX_WAIT_MS`), new submits get 0x58 until the wait is under 80 %; a cap of 100,000 unfinished messages as a safety net |
| 6 | failover | a restarted server took queued messages before its routing config was loaded; they failed and some were dropped | the pipeline starts only once the config is loaded; the other server carries the work meanwhile |
| 7 | failover | a restarted server bound to vendors and got receipts it could not match yet: lost receipts | vendor connections open only when receipts can be handled; a receipt that comes too early is refused (0x08) so the vendor sends it again |
| 8 | failover | a server killed between claiming a receipt and queuing it: the customer never got that receipt | the vendor's repeated receipt now forwards it (one stored copy even if both send) |
| 9 | failover | a freshly started server refused events from the other one (atoms not loaded yet) | every module loaded at start |
| 10 | partition | a cut link took 60 s to notice | 10 s (`net_ticktime`), and the nodes reconnect every 5 s (`SWITCH_PEERS`) |
| 11 | profile | credit alerts read two keys per account, every second, for every partner | one read for all accounts; a write only when a level changes |

## 3. Capacity (one node, NATS `default`)

Ramp, 60 s per step, 5 % two-part messages, receipts on every message, EDRs checked in ClickHouse:

| Rate | resp p50 | resp p95 | resp p99 | Receipts/s (parts) | Machine CPU | Switch CPU (1 core = 100 %) | Result |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 100/s | 3 ms | 7 ms | 11 ms | 105 (all) | 46 % | 104 % | within 50 ms |
| 200/s | 4 ms | 18 ms | 33 ms | 207 (all) | 69 % | 159 % | within 50 ms |
| 300/s | 14 ms | 46 ms | 81 ms | 313 (all) | 86 % | 196 % | keeps up, p99 over 50 ms |
| 400/s | 49 ms | 110 ms | 158 ms | 411 (all) | 94 % | 217 % | keeps up, p99 over 50 ms |
| 500/s | 83 ms | 182 ms | 248 ms | 213 of 523 | 95 % | 224 % | **behind**: messages wait on the bus |

With NATS `always` (every event written to disk before the answer, about 0.5 ms per write on this disk) every figure
halves: 100/s within 50 ms, 200/s end to end, behind at 300/s.

## 4. Failures

**Kill a server** (two nodes at 150/s, `kill -9` on one after 60 s, started again 90 s later): its customers and
vendor connections moved to the other node within seconds; the restarted node took its share back. 35,747 parts, an
EDR for every one, every receipt delivered, 1 duplicate receipt, 3 unanswered submits (in flight on the killed node).

**Cut the link between the servers** (both keep reaching the databases): no loss, no duplicate at the vendors,
3–5 duplicate receipts, and each server opened the vendor connections it thought the other had lost, so vendors saw
twice the connections while the link was down. With the witness VM (step 8) only the side that reaches 2 of 3 machines
keeps them (§7, decision 5).

**Spike** 150 → 1,000 → 150/s (20 s): every message accepted (resp p99 760 ms during the spike), receipts caught up
in about 60 s, nothing lost.

## 5. Soak

Two nodes, 200 msg/s for 30 minutes (NATS `default`, 5 % two-part messages, receipts on every message), measured
in 5-minute chunks:

| Chunk | resp p50 | resp p99 | Receipts/s | Machine CPU | Switch RSS (node a + b) |
| --- | ---: | ---: | ---: | ---: | ---: |
| 0–5 min | 19 ms | 274 ms | 209.7 | 88 % | 383 + 417 MB |
| 5–10 | 17 ms | 207 ms | 210.3 | 87 % | 374 + 402 MB |
| 10–15 | 20 ms | 182 ms | 210.0 | 88 % | 374 + 406 MB |
| 15–20 | 15 ms | 162 ms | 209.8 | 86 % | 375 + 404 MB |
| 20–25 | 12 ms | 124 ms | 209.9 | 84 % | 375 + 404 MB |
| 25–30 | 12 ms | 128 ms | 210.2 | 84 % | 374 + 401 MB |

- **Nothing lost:** 383,071 parts accepted, 383,206 receipts delivered, 0 accepted messages without a receipt, 0
  duplicate receipts, 0 duplicate vendor submits; ClickHouse holds an EDR for every one of the 385,174 parts accepted
  (warm-up included) and an outcome row for every vendor attempt.
- **No leak, no drift:** memory flat after the first minutes, latency falling, not rising (the first 15 minutes
  shared the VM with test builds). Submit to receipt p99 1.3 s.
- The 100 ms answer target failed only because two nodes, the databases and the simulator share 4 vCPUs at 85 % CPU.

## 5b. Overflow buffer next to normal traffic (backend step 7b)

Two nodes, 300 msg/s spread over 10 customer trunks (30/s each) for 5 minutes. Trunk 1 was limited to **10 TPS with
an overflow buffer of 100,000**, so about 20 msg/s of its traffic went to its buffer while the other nine trunks sent
normally.

- **Every submit accepted:** 94,894 parts, 0 throttled, 0 refused; trunk 1's excess went to its buffer, none refused.
- **The buffer drains at exactly the trunk's TPS:** about 7,050 messages buffered; the queue released 301 messages
  every 30 s (10/s) during and after the run, until empty.
- **Other trunks not held back:** the shared sending queue stayed empty (nothing waiting) the whole run; submit to
  receipt p50 1.0 s (the buffered messages make the p99 minutes, as intended: they wait for their trunk's TPS).
- **Consistent:** the ~2,900 parts without an EDR or receipt at the end of the drain were exactly those still in trunk
  1's buffer; every message sent had its EDR, no duplicates at the vendors.
- The answer time (p99 365 ms) reflects the VM at 96 % CPU with two nodes, the databases and the simulator on 4 vCPUs.

## 6. Follow-ups (not in this step)

- **CPU per message:** fewer Redis round trips (one script for TPS + credit + store), fewer bus events per message
  (attempt and outcome EDRs together), a faster encoding than `term_to_binary` with compression. Likely 2× on the
  same hardware.
- **Run the same scenarios on the real servers** in step 8, with the simulator on a third machine, and the network cut
  with the witness VM.
- **Throttle by time, not count:** refuse when the oldest waiting message is older than N seconds, which does not
  depend on the traffic rate.

## 7. Decisions (product owner, 2026-10-25)

1. **NATS disk writes:** the NATS default (every 2 minutes) instead of every event; each event is held by more than
   one server, so one server crashing loses nothing. Done in `deploy/nats/nats.conf`.
2. **Bus retention:** 2 days instead of 7 (about 1 TB per server at 50 M/day). Done (`max_age_days`).
3. **Max Msg Len:** the whole message; empty (any length) is the usual setting. The fake data now seeds it empty.
4. **Overload answer:** 0x58, when accepted messages wait over 10 s for the sender (`SWITCH_MAX_WAIT_MS`); messages in a customer trunk's overflow buffer do not count.
5. **Vendor connections during a cut link:** fixed in step 8 with the witness VM.
