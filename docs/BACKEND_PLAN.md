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
- §3.7 message text kept **1 year**, then blanked (Q30).
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
  payment, SOA and balance columns move from `numeric(14,2)` to 4 decimals.
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

### 3.3 Most checks run before submit_sm_resp; HLR never does

To give customers an immediate error in the resp (S-6.2 "no customer rate", S-2.10 bad address, credit limit,
firewall block), these run in memory **before** the resp:

- validation;
- customer rate lookup;
- route choice;
- credit check.

Together they take under 1 ms. Then the message is stored durably, then the resp is sent.

HLR lookups take 100 ms to seconds, so they always run **after** the resp. When an HLR-based route fails, the
customer gets a failed receipt instead.

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

### 3.7 Message text is not kept for 7 years *(Q30, decided: 1 year)*

EDRs hold the full message text: OTP codes, personal messages. Keeping it for 7 years (the billing retention) is a
privacy and data-protection risk, and is likely a problem under GDPR for EU traffic.

Proposal: keep the text for a short period (for example 30 days) for troubleshooting, then blank it. All other EDR
fields stay for the full retention. OTP-like codes are masked for roles without permission.

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
| Q30 | Message text retention (§3.7)? **Decided:** text kept **1 year**, then blanked; all other fields for the full retention | Mask OTP-like codes for roles without permission (open) |
| Q31 | Where do off-site backups go? | S3-compatible object storage at another provider: nightly full backup, continuous database log shipping, restore tested monthly |
| Q32 | The 2 servers: same data centre, or 2 data centres in the same city? | **2 data centres of the same provider in the same city**, with under 2 ms between them, so the 50 ms resp target holds. Witness VM at another provider |
| Q33 | Staff access to the portal | Over **VPN or an office IP allow-list**, plus 2FA. SMPP ports open only to whitelisted partner IPs |
| Q34 | Real-world testing: can you get test accounts on 2–3 real vendors and one friendly customer for December? | **Yes, needed for the pilot.** A list of the SMPP software your top partners use (no names needed) helps too |
| Q35 | Are there known quirks of current partners or past incidents (a vendor sending odd IDs, a customer that resends on reconnect)? | Send whatever you remember; each becomes a numbered scenario with a test |
