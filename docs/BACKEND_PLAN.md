# Backend plan, second opinions and open questions

Written 2026-10-24 for the product owner. It covers the backend that replaces the mock server: the SMPP switch, the API
behind the screens, billing, jobs and operations. The switch behaviour is in `docs/SMPP_SCENARIOS.md`, where D1–D11 are
decided. The decisions and change log stay in `docs/BACKEND_TODO.md`.

Each question below has a recommendation. Answer "as recommended" or give your choice. Q numbers are new and do not
reuse the D numbers.

**Decided 2026-10-24** (product owner):

- §3.1 first decided as TypeScript API, then **changed the same day to Elixir for the whole backend** (Q2); spec §14 and CLAUDE.md say Elixir.
- §3.2 receipts as appended rows; §3.3 checks before the resp, HLR after; §3.4 PCAP at OS level; §3.5 witness VM.
- §3.6 vendor submit timeout **stays 30 s** for now (Q11).
- §3.7 detailed EDRs kept **12 months** (6 on the servers, 6 off-site), report figures **for ever** (Q30, revised
  2026-10-27); traffic recording 60 days on the servers and 60 off-site.
- Q1 phase A by 30 November (switch on test traffic, servers ready); Q3 design target **1,000 TPS peak and 50 million
  a day**; Q6 **99 % of customers use SMPP** (HTTP API: see Q6 below); Q7 **no MO traffic today** (MO not in v1);
  Q10 two IPs, under **one host name** (see Q10); Q25 migration by exported files; Q26 same SMPP usernames and
  passwords.

**Decided 2026-10-24, second round** (product owner):

- Q4 **customer portal needed**: customers log in and see only their own balance, their rates per destination and
  their own traffic and message logs; never vendors, costs or margins. Timing open (proposal: after migration, with
  the API's customer-scoped permissions built from the start).
- Q5 the current platform stays as long as needed. Q6 HTTP API skipped for now.
- Q8, Q14, Q16, Q17, Q19, Q27, Q28, Q31 as recommended; Q32 most likely as recommended; Q34 test accounts can be
  arranged; Q35 later.
- Q20 money calculated at 6 decimals, **invoice amounts rounded to 4 decimals** (was cents). *Backend*: invoice,
  payment, SOA and balance columns move from `numeric(14,2)` to 4 decimals (done in step 12, migration 078).
- Q22 alert only, never block. Our balance with a prepaid vendor is the vendor balance (§7): payments we sent minus
  the vendor-billable cost from our EDRs; alert below a threshold, checked against the vendor's invoice (§13.31).
- Q29 alert channels to add later: **Telegram** (groups or people, through a bot) and **WhatsApp** (individual
  numbers only: the official WhatsApp Business API cannot post into groups, and needs approved templates and paid
  messages).
- Q30b no OTP masking for now. Q33 no VPN or office IP allow-list: the portal is reachable from the internet, so 2FA
  for staff is strongly recommended (mandatory at least for admins), with login rate limits and lockout.

**Decided 2026-10-24, third round:**

- §3.1 / Q2 **Elixir for the whole backend** (API included). Timeline above updated: migration February → April 2027.
- Q4 customer portal screens built now on fake data, at **`/portal`** with its own login, separate from the staff
  system.
- Q9 **TLS 1.0 offered** as a legacy option next to TLS 1.2 / 1.3 (SSLv2 / SSLv3 never).
- Q12, Q13 as recommended: vendor connections split between the servers with one shared TPS limit per trunk; one
  shared TPS limit per customer trunk.
- Q18 not in v1. Q21 **no tax** on invoices. Q22 vendor balance alerts as proposed.
- Q23 **auto invoices at the cycle end with what is known then**; receipts that arrive after the invoice do not change
  it or a later invoice.
- Q24 exact atomic credit check per message (all parts), 1-minute grace on the last known balance if the balance
  store is unreachable.
- Q15 **decided**: when every vendor for the route is down **at submit time**, the submit is answered at once with
  **0x45 (submit failed)**, not billed. The queue time (5 min per customer trunk) only covers messages accepted while a
  vendor was up whose vendor then failed.


**Decided 2026-10-24, fourth round** (route rules, trunks, password change):

- R1 destination condition: whichever of the list and the pattern is set is checked; with both, only the list.
- R2 sender / receiver number lists have Match / Not match. R3 Continue routing YES / STOP only act when the matched
  rule has no usable vendor; a matched rule with a working vendor always wins.
- R4 route rule groups and NEXT removed. R5 express margin is a % per message on the express vendor's cost.
- R6 a code is always needed to change a password: the authenticator code with 2FA on, otherwise an e-mailed code.
- Hosting provider and city: still open (does not block the start; machines needed by mid-November).

**Decided 2026-10-24, fifth round** (before the backend build):

- SMPP **3.4** with the common optional parameters (TLVs); no SMPP 5.0.
- Servers run **Ubuntu 24.04 LTS**.
- Database failover with **Patroni**: PostgreSQL primary on one server, streaming standby on the other, etcd on all
  three machines (the 2 servers + the witness VM) holding the leader lease; if the primary stops renewing it, the
  standby is promoted in 10–30 s, and only the side that reaches 2 of 3 machines may be primary (no split brain).
- Every build step is one pull request the product owner reviews before it is merged.
- The 2 servers + the witness VM are needed by about **15 November** (build step 8); steps 0–7 run on dev machines.

**Decided 2026-10-25, go-live** (product owner): go live with the Elixir switch and API in front of the TypeScript service (today's mock), which runs as a production service until its calls are ported group by group; Admin pages for administrators only unless an access group names the page, and a page not given is not reached from another page; the TPS "this rule" scope as the spec words it; per-trunk "Skip certificate check" (Q3); the customer portal's backend as soon as possible (Q4); hosting on hold; Q32 still "most likely"; test accounts and partner quirks (Q34, Q35) once the system is ready.

**Decided 2026-10-25, step 8** (servers not available yet): rehearse step 8 on three local machines first; install natively (systemd) with Ansible; Prometheus + Grafana with alerts to Telegram (Q29); off-site backups to S3-compatible storage, provider chosen later (Q31).

**Build progress:** step 0 (foundations) done: `backend/` umbrella (`sms_core`, `sms_switch`), data store modules,
event bus on NATS JetStream with an in-memory test adapter, health check, `mix check` quality gates and the CI job
`backend` (see `backend/README.md`). Step 1 (SMPP 3.4 PDUs) done: every 3.4 command and TLV, strict framing
(S-1.8, S-1.9), a precise status for every malformed PDU and the same sequence in the answer (S-1.10), fuzzed. Step 2
(customer side) done: binds with every check in S-1.1–S-1.4 and TLS 1.0–1.3 (S-1.17), Max Connections across both
servers, keep-alive, windows with backpressure, one shared TPS limit per trunk and per business company in Redis (Q13),
answers only on the arriving session and receipts by DLR Session Affinity (§13.1), drain and graceful unbind on stop. Decided with it:
ports 2775 plain / 2776 TLS; failed binds handled by the Firewall screen's filters and Banned / Trusted lists (§8);
trunk passwords stored encrypted (reversible, staff still see and change them) before real data. Step 3 (vendor
side) done: each vendor trunk's connections split between the servers and taken over when one stops (Q12), bind by
bind type with the trunk's credentials and bind address, TLS 1.0–1.3 with certificate checks, reconnect schedule and
Auth Fail Retry, Bind Down Alert events, keep-alive, Window Size, Submit Interval and Submit Timeout with late answers
published for the possible-duplicate flag (D4), one shared TPS limit per vendor trunk, MsgID Type normalisation (S-5.6)
and receipts handed to the pipeline (Q7). Step 4 (message pipeline) done: routing configuration in memory from
PostgreSQL, ports of the mock's translation engine, route evaluator and LCR, message checks and encodings, the
submit_sm_resp only once the message is stored on the bus, egress translation and re-routing across vendors (D2–D4),
receipts matched, aggregated per message and forwarded by DLR Session Affinity with store-and-forward, the customer
overflow buffer (S-2.4) and EDRs appended to ClickHouse (`edr`, `edr_receipt`) through the bus. Step 5 (switch rules)
done: DLR timeouts with late receipts matched from the EDRs (D5), customer multipart reassembly (D1) and vendor
multipart formats, re-route on a failed receipt (D2), possible duplicates (D4), duplicate filter and loop detection
(D6), query_sm / cancel_sm (D8), Delayed Submit (D11) and live TPS in routing (§13.8, §13.23). Step 6 (billing at
send time) done: revenue, cost and billable flags per Billing Type (outcome rows for receipt-based billing, ClickHouse
005), live balances with the per-message credit check (balance + credit limit, prepaid stops at 0, 0x45; migration
072), credit alerts and prepaid vendor alerts (Q22), and accumulated revenue conditions (§13.9). Step 7 (load tests) done on a 4-vCPU dev VM: SMPP simulator `tools/smpp-sim`, steady, ramp-to-break, spike, soak and failover (server killed, link cut) scenarios, 11 problems found and fixed (overload guard, start-up order after a restart, receipts across a crash, faster Redis/NATS I/O); results and the projection to the real servers in `docs/LOAD_TEST_RESULTS.md`. 1,000 TPS is to be confirmed on the real servers in step 8. Step 7b done: HLR/MNP lookups before the resp (routed by their network, master table on a timeout) and per-trunk overflow buffers for customer and vendor trunks. Step 8 (operations) built and rehearsed on three local machines while the servers are not available (product owner 2026-10-25): `deploy/ansible` sets up the two servers and the witness natively (etcd, Patroni + HAProxy, Redis + Sentinel, NATS on three, ClickHouse + Keeper, switch service, firewall, Prometheus/Alertmanager/Grafana with Telegram alerts and runbooks, pgBackRest and ClickHouse backups to S3 with a monthly timed restore test, dumpcap recording) and deploys the switch one machine at a time with migrations from the release; the witness decides vendor connections and which server steps back when the servers lose each other. Drills (link cut, server off, witness off, server isolated, deploy and switchover under traffic) and the 12 problems they found: `docs/FAILOVER_DRILLS.md`. Left for the real servers: run the same playbooks, the 1,000 TPS test and the drills there. Step 9 (API foundations) done: the Phoenix API (`backend/apps/sms_api`) in front of the mock (product owner 2026-10-25), staff sign-in with a 2FA code at every login and 8 h / 24 h sessions (contract v0.96.0, migration 074), the access-group check on the server for every call (changes checked, reads open, Admin pages closed), the password gate and audit trail, the list engine (§13.25) with the Audit Trail and Logged In Users ported and proven identical to the mock, and saved changes pushed to every switch at once. Step 10 (access lockdown) done: every call checked on the server, reads too; Admin pages for administrators or a group that names them; a page not given is not reached from another page (names-only lookups for pickers, filtered search and history, hidden sections); the TPS "this rule" scope as the spec words it; per-trunk "Skip certificate check" for vendor TLS (contract v0.97.0, migration 075). Step 11 (production service) done: the TypeScript service runs in production behind the API (`SMS_MODE=production`) with its jobs on one server at a time; the live screens, bind status and credit alerts come from the switch's NATS events; real e-mail through an outbox with retries and attachments (the API's sign-in codes too); Auto Invoicing; Incoming RNs read from the Rates mailbox over IMAP; RN reminders; real exchange-rate sources; nothing invented in production (actions that need a switch command answer "not available yet"). Step 11b done: reports, invoices and screens read the switch's outcome rows through the ClickHouse view `edr_all` (attempts once, deliveries, delays and money from either row), and EDR search, details, downloads and the portal merge each attempt's outcome. Step 11c done: the screens' switch actions go to the switch as NATS request/reply commands (`smscmd.*`, outside the JetStream stream): Network Status Stop/Start (closes and refuses the trunk's binds until Start), Test SMS and EDR Repush (sent as internal messages: no customer billing or DLR, a chosen vendor never fails over, repush progress from the new attempts' outcomes), live captures, Extract Recording, PCAP Trace downloads from the servers' real recording files, and Network Diagnosis on the server that has the source address. A switch that does not answer is shown as such (503), never as done. Step 12 (gaps) done: money keeps 4 decimals (Q20; migration 078), the Master report PDF has every row, the Sales report filters by product category, authenticator secrets are encrypted at rest (read by the API with the same key), alert rules on a country, MCCMNC, sender ID or category watch that traffic only, alert baselines come from the same hour yesterday and last week, and the API on the servers runs in production mode (sign-in codes e-mailed). Step 13 (customer portal backend) done: the portal never shows the platform's own Test SMS and repushed messages (EDR `internal_kind`), portal users get a code e-mailed at every sign-in (staff can turn it off per user), one address cannot keep trying to sign in, and a portal session ends 24 hours after sign-in. Step 14 (deployment) done: the Ansible roles install the TypeScript service and nginx (HTTPS, the screens, `/api` to the API, the live socket to the service) on both servers, the API serves the screens in front of the service, one release holds the switch, the service and the screens and is rolled out one server at a time, and a bootstrap command fills an empty production database with the real reference data and creates the first administrator; `docs/GO_LIVE.md` is the checklist from empty machines to the first test partners. Step 15 (full test pass) done: every screen in a browser as four kinds of user through the API, department access, an empty production database, SMPP end to end; one bug fixed (Bulk workspace picker); `docs/TEST_PASS.md`. Next: the real servers (`docs/GO_LIVE.md`).

## 1. Where we stand

- **GUI:** every screen in spec §3–13 works on fake data.
- **Mock server:** implements the API contract with 544 operations, about 60,000 lines of TypeScript and 44 test files.
  It already runs on the real PostgreSQL schema (66 migrations) and the ClickHouse EDR store, so the business rules for
  rates, routing evaluation, billing, invoices, SOA, reports, RNs, market moves, LCR and admin already exist as working
  code.
- **Not built:** the SMPP switch (binds, PDUs, queues, vendor sessions, receipts), real authentication and sessions,
  background jobs on real events (auto invoices, RN e-mail intake, scheduled reports), and operations (deployment,
  failover, monitoring, backups).
- **Team:** one engineer. **Deadline:** end of November 2026, about 5 weeks from now.
- **Hosting decided:** 2 dedicated servers plus 1 small witness VM, with NATS JetStream for events behind one internal
  event-bus module, so Kafka can replace it later without touching the switch or billing.

## 2. Honest timeline

The whole spec in Elixir, meaning the switch plus rewriting all 544 API operations, cannot be done by one engineer in
5 weeks at "zero margin for error". A rough estimate for one experienced engineer with AI help is **9–12 months**.
Testing time cannot be compressed much: load tests, crash tests, interop with every real vendor and customer, and a
parallel run.

**Decided 2026-10-24: Elixir for the whole backend** (§3.1). The rough plan is:

| Phase | When | Result |
| --- | --- | --- |
| **A. Core build** | now → 30 Nov 2026 | <ul><li>Elixir switch on test traffic: binds on both sides, submit_sm and submit_sm_resp, multipart, routing, translation and rating from the same PostgreSQL config, durable queue, vendor sessions with windows and TPS, receipts mapped back, EDRs into ClickHouse, D1–D11.</li><li>Phoenix API foundations: login, 2FA, permissions, audit, the generic list engine (filters, paging, search), config change pushed to the switch.</li><li>Servers installed, with monitoring and backups.</li><li>Load test at 1,000 TPS against the SMPP simulator.</li></ul> **Not on live traffic yet.** |
| **B. Pilot API** | December 2026 → January 2027 | <ul><li>The endpoints a pilot needs, ported to Elixir in this order: enterprises and trunks, rates, route / translation / HLR rules, EDR search, Live dashboard, enterprise report, finance and invoices.</li><li>Each ported endpoint must pass the mock server's own HTTP tests, run against Elixir, before the screens switch to it.</li><li>Pilot: 1–2 friendly customers and 2–3 vendors, with the current platform in parallel.</li></ul> |
| **C. Migration in waves** | February → April 2027 | <ul><li>Partners move in groups; each group stays 2 weeks before the next moves.</li><li>The rest of the API is ported in parallel.</li><li>The current platform stays as fallback until the last group is stable.</li></ul> |
| **D. The rest** | after go-live | Advanced features that don't block traffic, where they're not already done in the mock: market moves on real data, cleanup center scans, team activity, and so on |

These figures are estimates, re-checked at the end of each phase. See **Q1** for what must be true on 30 November.

## 3. Where I would change the current plan (second opinions)

### 3.1 Keep the API in TypeScript; write only the switch in Elixir *(not adopted: on 2026-10-24 the product owner chose Elixir for the whole backend; kept here for the record)*

Spec §14 says Elixir for the whole backend. The mock already holds the business logic as tested TypeScript on the real
schema. Rewriting it in Elixir is months of work that adds risk and no features.

Proposal:

- **Elixir:** the SMPP switch and everything on the message path: sessions, routing, translation, HLR, rating at send
  time, balances and credit checks, receipts, EDR writing. This is where Elixir's strengths matter: one process per
  bind, crash isolation, clustering, live upgrades.
- **TypeScript (Fastify, the mock turned into production):** the API behind the screens, reports, invoices, SOA,
  e-mail automation, imports and exports, admin.
- **Shared:** both use the same PostgreSQL schema and ClickHouse tables. Config changes saved through the API are
  pushed to the switch over NATS (S-6.6).
- **One routing engine:** the route simulator, route map and rate lookup must give the same answer as the switch. The
  TypeScript screens call the switch's evaluator over an internal API instead of keeping a second copy of the logic. A
  shared set of test cases runs against both until the TypeScript evaluator is removed.

The risk is two languages for one engineer. The gain is months saved and code that has already been through three
trial rounds.

### 3.2 Delivery receipts are written as new rows, not updates

`docs/BACKEND_TODO.md` currently says receipts are "written as updates to the same EDR". In ClickHouse, updating rows is
heavy work and can't keep up at 50 million a day, and summary tables would count updated rows twice.

Proposal: append only.

- One row is written when the message is sent (submit leg).
- One row is written when its receipt arrives, or when the DLR timeout ends.
- EDR search and the EDR download join the two by message.
- Summary tables (counts, ASR, DLR %, revenue) are filled from both streams separately, so nothing is counted twice.

The screens don't change.

As built (step 11b): the receipt-time row is the attempt's `edr_receipt` row of kind `outcome`, carrying the final
status, delay, money billed on the receipt and the attempt's report columns. Reports and invoices read the view
`edr_all` (both rows under the same columns: attempts counted on attempt rows, deliveries and money summed over both);
EDR search, details, downloads and the portal merge each attempt's outcome into its row.

### 3.3 Most checks run before submit_sm_resp; HLR never does

To give customers an immediate error in the resp (S-6.2 "no customer rate", S-2.10 bad address, credit limit,
firewall block), these run in memory **before** the resp:

- validation;
- customer rate lookup;
- route choice;
- credit check.

Together they take under 1 ms. Then the message is stored durably, then the resp is sent.

~~HLR lookups take 100 ms to seconds, so they always run **after** the resp.~~ **Changed by the product owner
2026-10-25:** on traffic with HLR/MNP on, the lookup runs before the resp with the checks above, and the destination
and network come from its result instead of the master table; when the provider does not answer within its timeout
(or fails), the master table is used (S-6.5). The resp of such traffic waits for the lookup, up to the provider's
timeout, so the timeout should stay well under the customers' own (a few hundred ms is typical). Built in backend
step 7b; a timeout goes straight to the master table, a provider error to the policy's next provider.

### 3.4 Traffic recording (PCAP) at the operating-system level

Spec §9.2 asks for 60 days of recorded SMPP traffic. Writing packet files inside the switch adds load and risk to the
message path.

Proposal: a standard capture tool (`dumpcap` ring buffer) records the SMPP ports into 15-minute files. The extract job
reads those files. The screens stay the same.

### 3.5 Three nodes for every vote

NATS JetStream, PostgreSQL automatic failover (Patroni with etcd), ClickHouse replication (ClickHouse Keeper) and
Redis (Sentinel) all need 3 voters. The witness VM runs one voter for each, and carries no traffic and no data apart
from the third NATS copy.

### 3.6 Vendor submit timeout default *(Q11, decided: stays 30 s for now)*

With D4 (re-route on a vendor timeout), a 30-second timeout delays every re-routed message by 30 s, and it is longer
than many clients wait when a Delayed Submit trunk (D11) is used. A healthy vendor answers in well under 1 s.

### 3.7 Retention: detailed EDRs 12 months, report figures for ever *(Q30, decided 2026-10-27)*

At 10 million messages a day (product owner 2026-10-27) the servers hold:

* **Detailed EDRs, 12 months.** The last `edr_hot_months` (6) on the servers' NVMe; the 6 before on the off-site
  bucket through ClickHouse tiered storage (policy `edr_tiered`, a local cache in front; deploy/ansible
  `roles/clickhouse`), still searched, downloaded and reported from, a little slower; deleted after `edr_keep_months`
  (12). `Sms.Core.Release` sets both on `edr` and `edr_receipt` (applied only when a table's TTL differs). This replaces
  the earlier "text 1 year, other fields 7 years": nothing of a message is kept past 12 months.
* **Report figures, for ever.** ClickHouse 008: `edr_totals` sums `edr_all` per 15 minutes (both arrival and submit
  quarter) and per every column a report groups, filters or multiplies by (partners, trunks, AMs, destinations,
  route, rate tables, rates, currencies and exchange rates, statuses, cause codes, billable flags, HLR); and
  `edr_sender_daily` the same per UTC day with both Sender IDs. A report whose period starts before the detailed
  months reads them (mock/src/reports/source.ts) and gives the same figures, proven by `mock/test/longTermTotals.test.ts`
  on every report, invoice line and usage figure. Past 12 months: no EDR search, download, repush or re-rating; no
  grouping by second, minute or IP; no TPS peak or TPS now; Sender IDs by UTC day only (refused with the reason).
* **Traffic recording**, 60 days on the servers (gzipped every 15 minutes) and 60 more on the bucket (`roles/pcap`,
  `sms-pcap-archive`); the PCAP screens list and fetch the off-site files (`sms-pcap-fetch`).

Sizes per server (both hold every EDR): EDRs 0.45–0.8 TB, recording 0.2–0.4 TB, event bus ~0.2 TB, the rest ~0.2 TB:
about 1.1–1.6 TB of the 3.84 TB mirror. Off-site: each server's own copy of EDR months 7–12, its recording days 61–120,
and the backups.

## 4. Other risk areas the build must test

These come on top of the switch scenarios in `docs/SMPP_SCENARIOS.md`. Each gets automated tests.

- **Money:**
  - rounding (6 decimals on traffic, cents on invoices: Q20);
  - FX rate used at send time;
  - month boundaries in each partner's time zone, including daylight-saving changes;
  - re-rating that never touches traffic already sent (§13.32);
  - balances equal to the sum of their transactions.
- **Jobs** (invoices, SOA, scheduled reports, RN intake, imports):
  - safe to run twice, so a retry never creates a second invoice or payment;
  - resume after a restart;
  - one owner when both servers are up.
- **Config to switch:**
  - every node applies a saved change within seconds, all at once (S-6.6);
  - an invalid config is refused, never half-applied;
  - a node that was down catches up before it takes traffic.
- **Clocks:** NTP on every server; receipt times, DLR timeouts and billing cut-offs must not depend on which node
  handled the message.
- **Split brain:** if the 2 servers lose contact, only the side that still has a majority (with the witness) keeps
  accepting traffic for shared limits (credit, TPS).
- **E-mail:** a failed SMTP send is retried and logged; RN intake never processes the same e-mail twice.
- **Upgrades:**
  - rolling deploys, one server at a time;
  - database migrations compatible with the old and new code (spec §14.1);
  - a rollback plan for every release.
- **Restore:** the backups are restored onto a test server every month, and the time it takes is measured.

## 5. Questions

### Scope and timeline

| # | Question | Recommendation |
| --- | --- | --- |
| Q1 | **Decided: (a).** What must be true on **30 November**? (a) the switch working on test traffic and the servers ready; (b) some real partners live; (c) full cutover | **(a)**, with real partners in December (pilot) and migration in January–February. (c) isn't achievable safely |
| Q2 | Second opinion §3.1: keep the API in TypeScript? **Decided: no, Elixir for the whole backend** (2026-10-24) | — |
| Q3 | **Decided: 50 million a day.** Volume target: you said **10 million a day**; the decision of 19 Oct (§14.3) says **50 million a day** at 1,000 TPS peak. Which is right? | Design and load-test for **1,000 TPS peak and 50 million a day** (headroom for growth); size disks for today's 10 million plus growth |
| Q4 | Customer portal (spec §1, "optional"): in v1? | **Later**, after migration |
| Q5 | How long can the current platform keep running in parallel during migration? | Until the last group has been stable for 2 weeks (about February) |

### Traffic and protocol

| # | Question | Recommendation |
| --- | --- | --- |
| Q6 | HTTP API for customers in v1? **Answered:** 99 % of customers use SMPP. Still open: do the remaining HTTP customers need it on day one? | Build it in **phase B (December)** in the current platform's format, so the few HTTP customers move in a later migration group. I need its documentation then (format only) |
| Q7 | Two-way traffic (MO)? **Decided:** no MO traffic today, so MO is **not in v1**. The switch answers an unexpected MO deliver_sm with OK and logs it, so a vendor never retries forever | — |
| Q8 | Do any vendors send receipts or messages using **data_sm** instead of deliver_sm? | Accept data_sm on both sides; send only submit_sm to vendors |
| Q9 | Does any partner still need old encryption (SSLv3, TLS 1.0)? | **No**: plain or TLS 1.2/1.3 only (spec §16) |
| Q10 | Two servers mean **two IPs**. **Decided:** yes, under one host name | One name (e.g. `smpp.<your-domain>`) with **both IPs** in DNS, plus `smpp1` / `smpp2` for clients that need two fixed binds. Short DNS lifetime (60 s) so a dead server can be taken out quickly. TLS certificate for those names. Vendors still need **both source IPs** whitelisted, because a host name doesn't help on outgoing connections |
| Q11 | Vendor submit timeout default (§3.6)? **Decided:** stays 30 s for now | — |
| Q12 | A vendor trunk's Max Connections and TPS across 2 servers: split the connections between the servers, with the TPS limit shared? | **Split the connections**, with **one shared TPS limit** per trunk (Redis counter) |
| Q13 | A customer's TPS limit when they bind to both servers: one shared limit? | **One shared limit per trunk**, with a tolerance of at most 1 second of traffic |
| Q14 | Receipts for a customer with no receive bind up (TX only, or their RX is down): keep them how long? | Keep and deliver when an RX/TRX bind comes up, for up to **72 hours**, then drop and log |
| Q15 | A message we can't send (every vendor down or busy, no other route): how long does it wait in our queue? | Up to **1 hour** by default (set per customer trunk, capped by the message's own validity), then EXPIRED |
| Q16 | No rate or route for a destination: answer the submit with an error at once? | **Yes**: 0x45 with the reason in the EDR (as S-6.2), no billing |
| Q17 | A number that matches no destination in the numbering plan? | Reject at once with 0x0B (invalid destination) |
| Q18 | Country rules beyond the spec firewall and translation blocks (sender ID registration, quiet hours for promotions, blocked content)? | **Not in v1**; the firewall (§8) and translation blocks cover it. Revisit per country |
| Q19 | Opt-out (STOP) handling? | **Not ours**: in wholesale, opt-out is the customer's job |

### Billing and money

| # | Question | Recommendation |
| --- | --- | --- |
| Q20 | Already open: invoice usage lines at 6 decimals, or cents? | **6 decimals on the lines**, invoice total rounded to cents |
| Q21 | VAT or tax on invoices: which business companies charge VAT, and at what rates? | A VAT rate per business company (0 % allowed), with a "reverse charge" note for cross-border business customers. Tell me which companies charge VAT |
| Q22 | Prepaid vendors: stop sending to a vendor when our balance with them reaches 0? | **Alert only**, never block traffic automatically |
| Q23 | Invoice timing with Reported or Delivery billing, when receipts arrive after the month ends | Generate auto invoices **after the longest DLR timeout** has passed (for example 3 days after the cycle ends). Anything later goes on the next invoice as an adjustment |
| Q24 | Credit limit reached mid-message (a multipart message, or several sessions at once)? | Check once per message (all its parts) before the resp. Allow at most 1 second of overshoot across servers, then reject with 0x58 or the credit error code chosen per trunk |

### Migration and cutover

| # | Question | Recommendation |
| --- | --- | --- |
| Q25 | **Decided: exported files.** Data from the current platform: the rule so far is never to connect to it. For cutover we need trunks, rates, rules and balances. How? | **You export files** (Excel or CSV) from the current platform at migration time. We import them through the Migration Center with a dry run first (§13.22). We never connect to it |
| Q26 | **Decided: yes.** Keep partners' SMPP usernames and passwords the same? | **Yes**, so customers change only the IP. Imported encrypted, admin-only (§13.22) |
| Q27 | Historical EDRs from the current platform: import them? | **No.** Keep the current platform read-only for disputes for a few months; import monthly totals if reports need them |
| Q28 | Balances at cutover? | One opening balance per partner on its cutover date, taken from the current platform's SOA |

### Operations and security

| # | Question | Recommendation |
| --- | --- | --- |
| Q29 | With one engineer, who receives alerts at night? | Alerts go to your phone (Telegram or SMS) and the NOC team. Each alert comes with a written runbook (what to check, what to do) |
| Q30 | Retention (§3.7)? **Decided 2026-10-27:** detailed EDRs **12 months** (6 on the servers, 6 off-site), then deleted; report figures **for ever** (15-minute totals, Sender IDs per day); recording 60 days here and 60 off-site (earlier: text 1 year, other fields 7 years) | Mask OTP-like codes for roles without permission (open) |
| Q31 | Where do off-site backups go? | S3-compatible object storage at another provider: nightly full backup, continuous database log shipping, restore tested monthly |
| Q32 | The 2 servers: same data centre, or 2 data centres in the same city? | **2 data centres of the same provider in the same city**, with under 2 ms between them, so the 50 ms resp target holds. Witness VM at another provider |
| Q33 | Staff access to the portal | Over **VPN or an office IP allow-list**, plus 2FA. SMPP ports open only to whitelisted partner IPs |
| Q34 | Real-world testing: can you get test accounts on 2–3 real vendors and one friendly customer for December? | **Yes, needed for the pilot.** A list of the SMPP software your top partners use (no names needed) helps too |
| Q35 | Are there known quirks of current partners or past incidents (a vendor sending odd IDs, a customer that resends on reconnect)? | Send whatever you remember; each becomes a numbered scenario with a test |
