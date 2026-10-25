# Failover drills (backend step 8)

Run 2026-10-25 in the rehearsal lab (`deploy/lab`): three Ubuntu 24.04 machines (srv-a, srv-b, the witness) set up
by `deploy/ansible/site.yml` exactly as the real servers will be, the switch installed by `deploy.yml`, traffic from
`tools/smpp-sim` (100 msg/s over 10 customer trunks bound to both servers, 10 fake vendor trunks with 4 connections
each, a receipt for every message). Fake data only.

**The lab is one 4-vCPU development machine** running all three machines, the simulator and the dev databases (about
90 % CPU at 100 msg/s), so the figures show **behaviour**, not capacity. Capacity (1,000 TPS) is measured on the real
servers when they arrive.

## Results

| Drill | What happened | Lost | Duplicates at vendors |
| --- | --- | --- | --- |
| **Link between the servers cut** (both still reach the witness) | srv-a (no PostgreSQL primary) stepped back after 18 s: its customers reconnected to srv-b, srv-b opened all 40 vendor connections (never more than 40 in total), every primary moved to srv-b. 90 msg/s carried during the cut; errors only in the first ~20 s. Link healed: srv-a resumed, 20/20 again, phase passed. | 0 accepted without a receipt | 6 (messages srv-a was sending in the 18 s before it stepped back) |
| **Server with every primary powered off** (srv-b: PostgreSQL and Redis primary) | srv-a took all 40 vendor connections in ~25 s and was not fenced (the witness lost srv-b too); PostgreSQL promoted on srv-a after 23 s, Sentinel promoted srv-a's Redis. srv-b powered on: rejoined as standby, 20/20 again, phase passed. | 0 | 1 |
| **Witness powered off, then on** | No effect on traffic: both servers kept their 20 connections, every phase passed, no error. | 0 | 0 |
| **Server with every primary cut off from both others** (srv-b isolated) | ~16 s of errors, then full rate on srv-a for the rest of the cut; srv-b stepped back (minority); PostgreSQL failed over to srv-a. Healed: srv-b resumed, phase passed. | 49 accepted messages got no receipt (see limits) | 0 |
| **Rolling deploy under traffic** (`deploy.yml`) | 62 s for the three machines; each stopped cleanly while the other carried its customers and vendors. | 0 | 0 (2 submits refused, 49 resent by the customers after their session closed) |
| **Planned PostgreSQL switchover under traffic** | No error at all. | 0 | 0 |
| **Backups and restore test** | pgBackRest full and differential, ClickHouse full and incremental to S3; the restore test restored both into scratch space on the standby and checked them. | – | – |

## Problems found and fixed

Each was found by a drill, fixed in this step and the drill run again.

| # | Found by | Problem | Fix |
| --- | --- | --- | --- |
| 1 | link cut | Vendors saw twice Max Connections while the servers could not see each other (step 7, decision 5) | The witness decides: a server takes over the other's connections only once the witness has lost it too (`Sms.Switch.Vendor.Quorum`) |
| 2 | link cut | With only the link cut, **neither** server carried traffic: each lost a primary that lived on the other (PostgreSQL on one, Redis or a NATS leader on the other) | The server without the PostgreSQL primary **steps back** (`Sms.Switch.Fence`): unbinds customers, closes vendor connections, stops its NATS, Redis and ClickHouse so every primary moves to the active server; resumes when the link is back |
| 3 | link cut | After the cut every NATS leader sat on the witness: every message would cross providers | The witness hands its leaderships to a server every minute (`sms-nats-leaders`) |
| 4 | link cut | The overload guard kept refusing every submit when the only messages left were in flight on a dead connection (nothing taken, so the wait never updated) | The refusal ends when nothing waits for the sender (`Sms.Core.Bus.waiting/1`) |
| 5 | link cut | Messages taken by a sender whose connection died waited 5 minutes (the ack wait) before another took them | Ack wait 30 s, with "in progress" sent every 10 s while a message is being sent |
| 6 | link cut | A server's NATS connections to the other server's node hung for the whole cut | Each switch talks to its own server's NATS node only |
| 7 | link cut | A stepped-back server was still counted by the witness, so the other kept only half the vendor connections | It leaves the vendor group while stepped back |
| 8 | isolation | Redis connections to the old primary (packets dropped, never closed) kept timing out although Sentinel had promoted the other Redis | A connection that times out 10 times in a row reconnects and asks the sentinels again |
| 9 | every drill | Credit alerts sent `MGET` with no key when nothing is watched | Skipped |
| 10 | (lab disk) | A full disk turns NATS JetStream off until NATS is restarted; ClickHouse's own logs grew without limit | DiskAlmostFull alert and runbook; ClickHouse logs kept 30 days |
| 11 | setup | Plain MergeTree tables in the Replicated EDR database did not replicate | The release creates `Replicated*MergeTree` there (dev and CI keep the plain files) |
| 12 | setup | pgBackRest's asynchronous archiver held the lock the first backup set-up needs | Synchronous archiving (ample for the configuration database) |

## Known limits

- **The first 15–20 seconds of a failure:** a lost link is noticed in 10 s (`net_ticktime`) and stepping back needs two
  checks 2 s apart. Messages a cut-off server sends in that window may be sent again by the other server (possible
  duplicates, D4), and submits on its sessions may get errors (customers resend).
- **Redis replicates asynchronously:** when the Redis primary's server is lost, the last moment of in-flight state
  (which vendor message id belongs to which message) may not have reached the replica, so receipts for those few
  messages are not matched (49 of 21,839 in the isolation drill). Proposed follow-up: wait for the replica on those
  writes (`WAIT 1 <ms>`), at the cost of the round trip between the data centres on every message.
- **About a minute after a server failure** the surviving server refused new submits with 0x58 for ~20 s while the
  messages the lost server had in flight were handed out again on top of new traffic (customers slow down and retry;
  nothing accepted was lost).
- The witness holds a full copy of the bus: its disk must be sized like a server's NATS disk (~1.2 TB).

## Reproducing

```sh
deploy/lab/lab.sh up                                       # LAB_CA_FILE / LAB_HTTPS_PROXY behind an inspecting proxy
cd deploy/ansible && ansible-playbook site.yml && ansible-playbook deploy.yml -e release=$(./build-release.sh)
deploy/lab/seed.sh                                         # reference data + load-test trunks
cd tools/smpp-sim && mix sim.run failover --rate 100 --host 10.88.0.11,10.88.0.12 --ports 2775 \
  --config run/loadtest-lab.json --kill "../../deploy/lab/lab.sh cut srv-a srv-b" --restore "../../deploy/lab/lab.sh heal"
```

`deploy/lab/sample.sh` prints each machine's vendor connections, sharing and stepped-back state every 2 s during a
drill. Reports go to `tools/smpp-sim/results/`.
