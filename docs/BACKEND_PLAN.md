# Backend plan, second opinions and open questions

Written 2026-10-24 for the product owner. It covers the backend that replaces the mock server: the SMPP switch, the API
behind the screens, billing, jobs and operations. The switch behaviour is in `docs/SMPP_SCENARIOS.md`, where D1–D11 are
decided. The decisions and change log stay in `docs/BACKEND_TODO.md`.

Each question below has a recommendation. Answer "as recommended" or give your choice. Q numbers are new and do not
reuse the D numbers.

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

With the second opinion in §3.1 (keep the TypeScript API and write only the switch in Elixir), the rough plan is:

| Phase | When | Result |
| --- | --- | --- |
| **A. Core build** | now → 30 Nov 2026 | <ul><li>Elixir switch on test traffic: binds on both sides, submit_sm and submit_sm_resp, multipart, routing, translation and rating from the same PostgreSQL config, durable queue, vendor sessions with windows and TPS, receipts mapped back, EDRs into ClickHouse, D1–D11.</li><li>TypeScript API hardened for production: real login, 2FA, permissions, audit, config change pushed to the switch.</li><li>Servers installed, with monitoring and backups.</li><li>Load test at 1,000 TPS against the SMPP simulator.</li></ul> **Not on live traffic yet.** |
| **B. Pilot** | December 2026 | <ul><li>1–2 friendly customers and 2–3 vendors on the new platform, with the current platform running in parallel.</li><li>HLR, re-route, credit limits, auto invoices, alerts on real traffic.</li><li>Crash and failover tests on the real servers.</li></ul> |
| **C. Migration in waves** | January → February 2027 | <ul><li>Partners move in groups.</li><li>Each group stays on the new platform for 2 weeks before the next moves.</li><li>The current platform stays as fallback until the last group is stable.</li></ul> |
| **D. The rest** | after go-live | Advanced features that don't block traffic, where they're not already done in the mock: market moves on real data, cleanup center scans, team activity, and so on |

These figures are estimates, re-checked at the end of each phase. See **Q1** for what must be true on 30 November.

## 3. Where I would change the current plan (second opinions)

### 3.1 Keep the API in TypeScript; write only the switch in Elixir *(biggest change, needs your OK: Q2)*

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

### 3.6 The vendor submit timeout default goes from 30 s to 10 s *(Q11)*

With D4 (re-route on a vendor timeout), a 30-second timeout delays every re-routed message by 30 s, and it is longer
than many clients wait when a Delayed Submit trunk (D11) is used. A healthy vendor answers in well under 1 s.

### 3.7 Message text is not kept for 7 years *(Q30)*

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
| Q1 | What must be true on **30 November**? (a) the switch working on test traffic and the servers ready; (b) some real partners live; (c) full cutover | **(a)**, with real partners in December (pilot) and migration in January–February. (c) isn't achievable safely |
| Q2 | Second opinion §3.1: keep the API in TypeScript, Elixir only for the switch and message path? | **Yes** |
| Q3 | Volume target: you said **10 million a day**; the decision of 19 Oct (§14.3) says **50 million a day** at 1,000 TPS peak. Which is right? | Design and load-test for **1,000 TPS peak and 50 million a day** (headroom for growth); size disks for today's 10 million plus growth |
| Q4 | Customer portal (spec §1, "optional"): in v1? | **Later**, after migration |
| Q5 | How long can the current platform keep running in parallel during migration? | Until the last group has been stable for 2 weeks (about February) |

### Traffic and protocol

| # | Question | Recommendation |
| --- | --- | --- |
| Q6 | HTTP API for customers in v1? If yes, which format? | **Yes, in the same format as the current platform**, so customers don't change code. I need its documentation (format only, no credentials or real data) |
| Q7 | Two-way traffic (MO): do vendors send you inbound messages to forward to customers? How is the customer chosen: by the number in the MO book (§6.1)? | Route MO by the MO book number to the customer trunk that owns it; MO billed per the MO book rates |
| Q8 | Do any vendors send receipts or messages using **data_sm** instead of deliver_sm? | Accept data_sm on both sides; send only submit_sm to vendors |
| Q9 | Does any partner still need old encryption (SSLv3, TLS 1.0)? | **No**: plain or TLS 1.2/1.3 only (spec §16) |
| Q10 | Two servers mean **two IPs**. Can customers bind to both, and can vendors whitelist both of our source IPs? | Yes to both, announced to partners 2–4 weeks before their migration group |
| Q11 | Vendor submit timeout default 10 s instead of 30 s (§3.6)? | **10 s** |
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
| Q25 | Data from the current platform: the rule so far is never to connect to it. For cutover we need trunks, rates, rules and balances. How? | **You export files** (Excel or CSV) from the current platform at migration time. We import them through the Migration Center with a dry run first (§13.22). We never connect to it |
| Q26 | Keep partners' SMPP usernames and passwords the same? | **Yes**, so customers change only the IP. Imported encrypted, admin-only (§13.22) |
| Q27 | Historical EDRs from the current platform: import them? | **No.** Keep the current platform read-only for disputes for a few months; import monthly totals if reports need them |
| Q28 | Balances at cutover? | One opening balance per partner on its cutover date, taken from the current platform's SOA |

### Operations and security

| # | Question | Recommendation |
| --- | --- | --- |
| Q29 | With one engineer, who receives alerts at night? | Alerts go to your phone (Telegram or SMS) and the NOC team. Each alert comes with a written runbook (what to check, what to do) |
| Q30 | Message text retention (§3.7)? | Keep the text **30 days**, then blank it; all other fields for the full retention. Mask OTP-like codes for roles without permission |
| Q31 | Where do off-site backups go? | S3-compatible object storage at another provider: nightly full backup, continuous database log shipping, restore tested monthly |
| Q32 | The 2 servers: same data centre, or 2 data centres in the same city? | **2 data centres of the same provider in the same city**, with under 2 ms between them, so the 50 ms resp target holds. Witness VM at another provider |
| Q33 | Staff access to the portal | Over **VPN or an office IP allow-list**, plus 2FA. SMPP ports open only to whitelisted partner IPs |
| Q34 | Real-world testing: can you get test accounts on 2–3 real vendors and one friendly customer for December? | **Yes, needed for the pilot.** A list of the SMPP software your top partners use (no names needed) helps too |
| Q35 | Are there known quirks of current partners or past incidents (a vendor sending odd IDs, a customer that resends on reconnect)? | Send whatever you remember; each becomes a numbered scenario with a test |
