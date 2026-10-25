# SMPP switch: scenarios the backend must handle

The switch carries live traffic, so every case below needs a defined behaviour and an automated acceptance test
before go-live. This catalogue extends spec §2, §6 and §13.1. Where the spec is silent, the **Required behaviour** is
a proposal and the item is marked **Decision** and listed in [Decisions needed](#decisions-needed). Proposals are
not final until the product owner confirms them.

Each scenario has an ID (S-x.y) for test names, tickets and commits. Every test runs against the SMPP simulator
(`tools/smpp-sim/`). Each test asserts three things:

- what the client sees: PDUs, status codes, message IDs, receipts;
- what the vendor sees;
- what the EDR and billing record.

Terms:
- **Customer side**: the switch is the SMSC (server).
- **Vendor side**: the switch is the ESME (client).
- **Part**: one SMPP submit_sm carrying one segment.
- **Message**: the full text the subscriber reads.

---

## 1. Sessions and binds

| ID | Scenario | Required behaviour | Test |
| --- | --- | --- | --- |
| S-1.1 | Bind with wrong password, unknown system_id, or IP not on the whitelist | bind_resp with 0x0E (invalid password), 0x0F (invalid system_id) or 0x0D (bind failed). No session is created. Every failure is audited. After N failures in M minutes from one IP, block that IP temporarily | Each case returns the right code; the IP block lifts after the cool-down |
| S-1.2 | More binds than Max Connections | Extra bind gets 0x05 (already bound) or 0x0D; existing sessions are untouched | Bind max+1: the last one is refused |
| S-1.3 | Bind type not allowed for the trunk (e.g. RX on a TX-only trunk) | 0x0D; AUTO accepts TX, RX and TRX | Matrix of trunk setting × bind type |
| S-1.4 | interface_version 0x33, 0x34 or 0x50 | 3.4 behaviour for all. TLVs only when version ≥ 0x34. Reply with sc_interface_version | One bind per version |
| S-1.5 | Client stops answering enquire_link | After EnquireLinkRespTimeOutSec, close the session. In-flight receipts follow §13.1 hold rules | Simulator stops replying: session closes on time |
| S-1.6 | Half-open TCP (client vanished, no FIN) | Detected by enquire_link or TCP keepalive; same as S-1.5 | Drop packets at the network level |
| S-1.7 | unbind while messages are in flight | Answer unbind_resp after sending the submit_sm_resps already decided. Receipts are held per §13.1 | Unbind mid-burst: no resp lost, no message lost |
| S-1.8 | Several PDUs in one TCP read, or one PDU split across reads | Frame strictly by command_length; never assume one read is one PDU | Fuzz with random splits and merges |
| S-1.9 | command_length below 16 or above the maximum (e.g. 64 KB) | generic_nack 0x02, then close the session if the stream can't be resynced | Fuzzed lengths |
| S-1.10 | Unknown command_id | generic_nack 0x03 with the same sequence_number; session stays up | Send command_id 0x0000FFFF |
| S-1.11 | PDU sent before bind (e.g. submit_sm while unbound) | Error 0x04 (incorrect bind status) | — |
| S-1.12 | submit_sm on an RX-only bind | 0x04 | — |
| S-1.13 | Duplicate sequence_number from the client while the first is still open | Answer each PDU on its own; never merge them. Log a warning | Two submits with the same sequence number get two resps |
| S-1.14 | Sequence number wraps (0x7FFFFFFF → 1) on our vendor-side sessions | Wrap safely; never reuse a number still waiting for a resp | Long soak test |
| S-1.15 | Client behind NAT or a load balancer | PROXY protocol gives the real IP; a TCP connection stays on one node (§13.1 rule 7) | Bind through the test load balancer: whitelist and affinity both use the real IP |
| S-1.16 | Switch node restarts or is upgraded | Live code upgrade keeps binds. A node that stops drains first: it stops accepting new submits (0x58) and finishes in-flight work | Rolling deploy under load: no lost message |
| S-1.17 | TLS bind | TLS 1.2/1.3; no SSLv2/3 (spec §2 lists them as legacy) | Bind with each version; old ones refused |
| S-1.18 | Customer reads deliver_sm too slowly (slow reader) | Per-session window and backpressure; receipts wait in a durable queue, never in unbounded memory | Simulator reads slowly: memory flat, receipts arrive later |

## 2. submit_sm and submit_sm_resp

| ID | Scenario | Required behaviour | Test |
| --- | --- | --- | --- |
| S-2.1 | **Which session gets submit_sm_resp** | Always the session the submit arrived on, with the same sequence_number (§13.1 rule 1). If that session died, drop the resp, never send it on another session. The message is still accepted and processed (see S-2.6) | Two TRX binds from two IPs, interleaved submits: each gets only its own resps |
| S-2.2 | **When the resp is sent** | After the message is safely stored (durable queue / JetStream ack), **never** after the vendor answers. Target under 50 ms p99 (§14). The vendor leg is fully asynchronous | Vendor that takes 30 s to answer: customer resps still under 50 ms |
| S-2.3 | **Client submit timeout while we queue** (vendor slow, down, or window full) | Covered by S-2.2: the resp never waits for the vendor. If we can't store the message (queue full, overload), answer at once with 0x58 (throttled) or 0x14 (message queue full). Never stay silent | Fill the vendor window and the overflow buffer: client gets 0x58/0x14 within 50 ms, never a timeout |
| S-2.4 | Customer TPS exceeded | No overflow buffer: 0x58. With a buffer: accept and queue up to the buffer size, then 0x58. Business-company TPS limit applies on top | Send 2× TPS: measure accepted vs 0x58 |
| S-2.5 | message_id format | Unique across all nodes and restarts (time-ordered ID). Decimal or hex per trunk (MsgID Type). Fits in 64 characters | 10 M IDs: no duplicates; format per trunk |
| S-2.6 | **Resp lost** (session dropped after we stored the message, before the resp went out) | The message is still processed. The client may re-send it → see S-2.7 | Kill the TCP connection between store and resp |
| S-2.7 | **Duplicate submit** (client re-sends after a lost resp, its own timeout or a reconnect; many SMPP client libraries re-queue every un-answered submit on reconnect) | **Decided 2026-10-24 (D6):** per customer trunk duplicate filter, key = trunk + source + destination + text hash (+ UDH reference for parts), window 60 s (set per trunk). A duplicate gets a resp with the **original** message_id and is not sent again. Shares the fingerprint store with Loop Detection (S-5.16), which catches the same message coming back on a *different* trunk | Resend within and outside the window |
| S-2.8 | sm_length doesn't match short_message, or both short_message and message_payload are set | 0x01 (invalid message length) or 0xC4 (invalid optional parameter) | — |
| S-2.9 | Empty message (sm_length 0, no payload) | **Decided 2026-10-24:** reject with 0x01 (invalid message length), not billed; a customer trunk can allow it. A blank SMS is nearly always a client bug (an empty template variable) and still costs a part | Empty submit → 0x01; trunk allowing empty → accepted |
| S-2.10 | Invalid source address (too long, alphanumeric over 11 characters, bad TON/NPI) | 0x0A; destination problems 0x0B | Matrix of TON/NPI × address |
| S-2.11 | data_coding the trunk does not allow | 0x45 (submit failed) or 0x0A per config, or convert the coding when possible (e.g. 3 → 0 when every character is in GSM) | — |
| S-2.12 | schedule_delivery_time set | Hold the message until that time (relative or absolute format). Validity is checked against it | Schedule +5 min: the vendor sees it at +5 min |
| S-2.13 | validity_period set; message still queued when it expires | Do not send. Generate an EXPIRED receipt if one was requested. Customer billing per billing type | Expire while the vendor is down |
| S-2.14 | registered_delivery variants (none, final, failure only, intermediate) | Customer gets exactly what they asked for. The vendor leg can force receipts on for our own tracking, with receipts filtered back to the customer's choice | Each value × vendor receipt outcome |
| S-2.15 | replace_if_present, query_sm, cancel_sm, replace_sm | **Decided 2026-10-24:** **query_sm** answered from our records (EDR). **cancel_sm** only while the message is still queued with us, otherwise 0x11 (cancel failed). **replace_sm** not supported: 0x03 (invalid command). replace_if_present in submit_sm is ignored (sent as a new message) and logged | query a delivered ID; cancel a queued and a sent message; replace_sm → 0x03 |
| S-2.16 | esm_class message mode (datagram, transaction, store-and-forward) | **Decided 2026-10-24:** every submit is handled as store-and-forward (resp at once, receipt later) whatever mode it asks for; the requested mode is logged per trunk. The per-trunk **Delayed Submit** setting is separate (S-2.18) | Datagram and transaction submits get an immediate resp |
| S-2.17 | priority_flag | Priority messages go ahead in our queues; otherwise passed through | Burst with mixed priorities |
| S-2.18 | **Delayed Submit** customer trunk setting (§5: "respond submit_sm_resp only after vendor accepts") | **Decided 2026-10-24:** (D11) kept exactly as the spec says, the one exception to S-2.2: the resp waits for the vendor's submit_sm_resp and carries the final outcome (after any re-route). No cap of our own: if the vendor submit timeout ends first, the customer gets an error resp (0x45). Setup note: the vendor Submit Timeout should be shorter than the client's own timeout, or the client times out first | Delayed Submit trunk: vendor answers in 2 s → OK after 2 s; vendor rejects → error resp; vendor silent → 0x45 at the Submit Timeout |

## 3. Multipart and concatenated messages

Formats seen from clients and vendors:

| Format | How the parts are linked |
| --- | --- |
| UDH 8-bit reference | esm_class UDHI bit + IEI 0x00: ref (1 byte), total, seq |
| UDH 16-bit reference | IEI 0x08: ref (2 bytes), total, seq |
| SAR TLVs | sar_msg_ref_num, sar_total_segments, sar_segment_seqnum |
| message_payload | The whole long message in one PDU (up to 64 KB) |
| Long short_message without UDH | Client sends more than 160 GSM / 70 UCS-2 characters in one short_message (up to 254 octets) |

| ID | Scenario | Required behaviour | Test |
| --- | --- | --- | --- |
| S-3.1 | **Client sends a long message as one part** (message_payload, or an oversized short_message) | Accept it as **one message**: one submit_sm_resp, one message_id. Split it ourselves for the vendor, in the vendor's preferred format and size (S-3.10). The customer gets one receipt for its one message_id (aggregated, S-5.9). Billing counts the parts the message needs (153/67/134 per part) on both sides | 300 GSM characters in message_payload → vendor gets 2 parts, customer gets 1 resp and 1 receipt, billed 2 parts |
| S-3.2 | **Wait for all parts** (UDH or SAR) | Every part gets its own submit_sm_resp and message_id **at once** (never hold a resp until the last part arrives, or the client times out). The parts are held as a group until all have arrived or the reassembly timeout ends (default 120 s, set per trunk). Routing, translation and HLR run **once per message** on the full text. Then the parts are sent | Parts arrive 1, 3, 2 within the timeout: all forwarded, same vendor, order kept |
| S-3.3 | Group key | trunk + source + destination + reference + total parts. **Not** per session: a client may send parts over several binds. References repeat (8-bit ones wrap every 256), so a key is closed once its group is complete or timed out | Parts 1 and 2 on TRX-A, part 3 on TRX-B: reassembled |
| S-3.4 | **A part never arrives** (timeout) | **Decided 2026-10-24:** fail the parts we have, never send them: a REJECTD receipt per part with the error *incomplete multipart*, not billed to the customer or the vendor, EDR flagged, alert when a trunk does it often | Send parts 1 and 2 of 3, wait 120 s: 2 REJECTD receipts, nothing sent to the vendor |
| S-3.5 | The same part arrives twice | Answer the second with a resp carrying the **same message_id** as the first; forward only once | Resend part 2 |
| S-3.6 | Inconsistent parts (seq > total, totals differ within a group, total = 1 with UDH) | Reject the bad part with 0x01 (invalid message length) or 0xC1 (invalid optional parameter value), or forward as a single message per config | Fuzz the UDH fields |
| S-3.7 | Parts arrive after their group timed out | Treat each as a new incomplete group (S-3.4 rules). Never attach it to a closed group | — |
| S-3.8 | All parts go to the same vendor | One routing decision per message. Every part uses the same vendor trunk, and the same vendor **session** where possible (some SMSCs reassemble per bind). With **Part Wise Routing** on the rule, each part is routed separately (spec §6) | 3 parts, vendor with 2 binds: all on one bind |
| S-3.9 | Vendor trunk doesn't support multipart, or has a max length | Skip that vendor for multipart messages (try the next level) or reject per trunk settings (Support Multipart / Max Msg Len / Deny Multipart) | Route with a no-multipart vendor first: goes to the next vendor |
| S-3.10 | Vendor needs a different multipart format than the client sent | Convert per vendor trunk setting: UDH 8-bit, UDH 16-bit, SAR or message_payload. New reference numbers per vendor session (unique while open) | Client SAR → vendor UDH; client UDH → vendor payload |
| S-3.11 | **One part fails at the vendor**, others accepted | **Decided 2026-10-24:** (D2) a handset can't join parts sent through two different SMSCs, so parts only move together. By how the part failed: **(1) temporary error** (0x58 throttled, 0x14 queue full, 0x08 system error) → retry that part on the **same vendor with the same reference**, up to 3 times within about 10 s; **(2) rejected in submit_sm_resp** (permanent error, never vendor-billable) → resend **all** parts via the next vendor with a new concatenation reference; parts the first vendor accepted stay as that attempt's cost; **(3) accepted, then a failed receipt** → resend all parts via the next vendor only when the vendor trunk's Re-Route on list includes that status, **no part was delivered**, and the failed part is not vendor-billable under the vendor trunk's Billing Type; otherwise the whole message fails. The customer always gets one message_id and one aggregated receipt (S-5.9) and is billed once, by the customer trunk's Billing Type on the final attempt | Part 2 gets 0x58 → retried on vendor A, joins normally. Part 2 rejected 0x45 → all 3 parts via vendor B, new reference. Delivery-billed A: part 2 UNDELIV, parts 1 and 3 still unknown → all via B. Part 2 UNDELIV after part 1 DELIVRD → message fails |
| S-3.12 | Splitting rules | Never split a GSM escape character (€ [ ] { } ~ \| ^) across parts. Never split a UCS-2 surrogate pair (emoji). The UDH takes 6 or 7 octets of the 140 (153 GSM / 67 UCS-2 / 134 8-bit per part). National language shift tables: **Decided 2026-10-24:** not in v1 — never created by us; a client's already-encoded parts (UDH IE 0x24 / 0x25) pass through unchanged; letter replacement (ş → s) is done with translation rules | Text with € at position 153; emoji at the boundary |
| S-3.13 | Receipts for parts | Vendor sends one receipt per part. With UDH/SAR input, the customer gets one receipt per part, each on that part's own message_id. With single-message input (S-3.1), one aggregated receipt (S-5.9) | Mixed outcomes per part |
| S-3.14 | Message with too many parts (e.g. over 10) | Configurable per trunk; above it, 0x01 | — |

## 4. Translation, content and coding

| ID | Scenario | Required behaviour | Test |
| --- | --- | --- | --- |
| S-4.1 | **Translation grows the part count** (1 → 2 parts: added text, sender template, a non-GSM character forcing UCS-2) | **Decided (D3): block.** Part count is recalculated after every translation; if it is higher than what the customer sent, nothing goes to the vendor. The customer gets a REJECTD receipt with a defined error code (*translation grows part count*), the EDR is rejected with that reason and is **not billable** to the customer (nor to a vendor, nothing was sent). Shown in reports and alerted per translation rule so the team can fix the rule. Route simulator and translation test show the warning before saving | 155-character GSM text + a 10-character suffix rule → REJECTD receipt, nothing sent, not billed, EDR reason set |
| S-4.2 | Translation turns 2 parts into 1 | Send 1 part. The customer's 2 message_ids each get a receipt copied from the single vendor receipt. Billing per the customer's parts | Remove a URL from a 2-part message |
| S-4.3 | Translation on a multipart message | Applied once to the **reassembled** full text (S-3.2), then re-segmented. Never per part (a regex could match across a part boundary) | Pattern spanning the boundary of parts 1 and 2 |
| S-4.4 | Coding changes after translation (GSM ↔ UCS-2) | Recalculate coding and part count after **all** translations. If the vendor doesn't allow the new coding, transliterate per rule or skip the vendor | Add "é€" to GSM text; vendor allows only coding 0 |
| S-4.5 | GSM 7-bit packing | Some vendors want packed septets, others unpacked bytes. Set per vendor trunk; tested both ways | — |
| S-4.6 | Latin-1 (3) vs GSM (0) mapping | Characters outside the target alphabet are replaced by a defined character, never silently dropped. Warn in the EDR | — |
| S-4.7 | Sender becomes invalid after translation (too long, wrong TON/NPI) | Fix TON/NPI automatically when the trunk is set to *auto*; otherwise fail with 0x0A before sending to the vendor | — |
| S-4.8 | Several translation rules in sequence | Applied in the trunk's order. Ingress (customer) before routing; egress (vendor) after vendor selection. Routing and customer rate use the message **after ingress, before egress** (spec §6) | Chain of 3 rules; route simulator shows the same result |
| S-4.9 | Egress rule blocks the message | Skip that vendor, try the next one (decided 2026-10-18) | — |

## 5. Vendor leg, queues and receipts

| ID | Scenario | Required behaviour | Test |
| --- | --- | --- | --- |
| S-5.1 | Vendor window full (VendorWindowSize outstanding) | Queue (up to VendorOverflowBufferSize) in a durable queue; past that, the message re-routes to the next level after N seconds | Vendor stops answering: queue grows, then re-routes |
| S-5.2 | **Vendor submit timeout** (no submit_sm_resp within Submit Timeout, default 30 s) | **Decided 2026-10-24:** (D4) re-route automatically to the next vendor. The first attempt is marked *timeout, possibly sent* and kept for the vendor invoice check. If a late resp from that vendor says it was accepted, the message is flagged *possible duplicate*. Alert on vendor trunks that time out often. Manual Repush from EDR search (§9) is still available | Vendor that never answers: re-routed after the Submit Timeout; late OK from the first vendor → *possible duplicate* flag |
| S-5.3 | Vendor error codes | Classified per vendor (editable table): **permanent** (invalid destination, barred → fail, UNDELIV receipt); **temporary** (system error, queue full → retry or re-route); **throttled** 0x58 (slow down, retry the same vendor, not counted as a failure) | Each class |
| S-5.4 | Vendor bind down | Messages for it move to the next route level after a short grace period; queued messages are not lost. Bind-down alert (§13.6) | Kill the vendor simulator mid-burst |
| S-5.5 | **Receipt arrives before the vendor's submit_sm_resp** (race) | Hold receipts with an unknown vendor message_id for a short time (e.g. 30 s), then match. Never drop them at once | Simulator sends the receipt first |
| S-5.6 | Vendor message_id in hex in the resp but decimal in the receipt (or the other way round, or with leading zeros) | Normalise per vendor (MsgID Type); match on the normalised value | — |
| S-5.7 | Receipt text and TLVs disagree | Trust TLVs (receipted_message_id, message_state, network_error_code) over the text; log the mismatch | — |
| S-5.8 | Duplicate receipts; a final status after a final; intermediate statuses | Forward each final status to the customer only once. Intermediates only if the customer asked for them. The first final status wins | — |
| S-5.9 | **Aggregated receipt** (one customer message_id, several vendor parts) | Delivered only when **all** parts are delivered. Failed if any part failed (that part's error). The receipt is sent when the last part's outcome is known or the DLR timeout ends | 2 parts: DELIVRD + UNDELIV → customer gets UNDELIV |
| S-5.10 | DLR timeout passes, then the real receipt arrives | **Decided 2026-10-24:** no second receipt to the customer. The EDR is corrected to the real outcome and marked *late receipt*, for vendor invoice checks; the customer's billing stays as reported to them | Generated EXPIRED, then real DELIVRD on day 3: customer sees EXPIRED only, EDR shows DELIVRD (late) |
| S-5.11 | Re-route on receipt failure (EXPIRED, UNDELIV…) | Submit again to the next level. The customer sees **one** final receipt, from the last attempt. EDR keeps every attempt and its cost | Vendor A UNDELIV → B DELIVRD: customer gets one DELIVRD |
| S-5.12 | Receipt for an unknown or very old message_id | deliver_sm_resp OK (never make the vendor retry forever); log it as orphan | — |
| S-5.13 | Customer session gone when the receipt is ready | §13.1 rules: hold per DLR Session Affinity (strict session, same IP, same trunk), up to the hold time | §13.1 acceptance tests a–d |
| S-5.14 | Customer doesn't answer deliver_sm (resp timeout) | Retry on the same session with backoff; if the session dies, hold per S-5.13. Never deliver twice to a session that did ack | — |
| S-5.15 | MO messages (deliver_sm without the receipt bit) | Route to the customer trunk that owns the number (MO book), same affinity rules | — |
| S-5.16 | **Loop** (vendor routes back into our own platform) | Customer trunk setting **Loop Detection** (§5, Active / Inactive). Detect by a header or by the same fingerprint as S-2.7 (source + destination + text hash) arriving on a *different* trunk while our own copy is still in flight; stop and fail with a defined error, not billed | Route vendor A back into customer trunk B: second copy rejected |

## 6. Routing, rating and billing at send time

| ID | Scenario | Required behaviour | Test |
| --- | --- | --- | --- |
| S-6.1 | Rate changes while a message is in flight | Customer rate and vendor cost are the ones effective at **submit time**, stored on the EDR. Never re-rated by a later RN (§13.32) | Change the rate between submit and receipt |
| S-6.2 | No customer rate for the destination | Reject with a defined code (proposal 0x0B or 0x45, chosen per trunk); EDR reason "no customer rate" | — |
| S-6.3 | Credit limit reached during a burst on several nodes | Atomic balance counters (Redis); at most a small, configured overshoot. Reject with the credit error code | 10 parallel sessions hitting the limit |
| S-6.4 | Billing type submit vs delivered, multipart | Per part. Delivered billing counts only the delivered parts | — |
| S-6.5 | HLR timeout or error | **Changed by the product owner 2026-10-25:** on traffic with HLR/MNP on, the lookup runs **before** the resp, with the other checks: the destination and network (and so the rate and the route) come from the HLR/MNP result instead of the master table. Only when the provider does not answer within its timeout (provider Timeout, 100 ms–30 s) or fails does the switch fall back to the master table and carry on. Cache per the provider and policy | Slow HLR provider: resp after the provider timeout, routed by the master table; fast HLR: routed on the ported network |
| S-6.6 | Config change (route rule or rate saved) | Active on every node within N seconds, all at once per change (no half-applied rule). Messages already routed keep their decision | Save a rule under load |
| S-6.7 | Exchange rate snapshot | The rate used for EUR is stored with the EDR at send time | — |
| S-6.8 | Account Manager attribution | Taken at send time (§13.30) | — |

## 7. Reliability

| ID | Scenario | Required behaviour | Test |
| --- | --- | --- | --- |
| S-7.1 | Node crash with messages in flight | Every accepted message is in the durable queue; another node resumes. Delivery is **at least once** to the vendor; the dedupe in S-5.2 and S-2.7 keeps duplicates rare | Kill -9 a node under load: compare accepted vs sent counts |
| S-7.2 | Postgres down | Switch keeps routing from its in-memory config; EDRs buffer in the queue. No new config while it's down | Stop Postgres for 10 min under load |
| S-7.3 | ClickHouse down | EDRs buffer and are written once when it returns (idempotent insert key) | — |
| S-7.4 | Redis down | TPS and credit fall back to local per-node limits (stricter); alert | — |
| S-7.5 | Network split between nodes | No message sent twice. A node that loses quorum stops taking new submits (0x58) | Chaos test |
| S-7.6 | Counts reconcile | Every hour: accepted = sent + rejected + expired + queued, per trunk; any gap raises an alert | Automated job |
| S-7.7 | Time | All servers on NTP; receipts carry UTC; DST never touches billing | — |

## 8. Security and abuse

| ID | Scenario | Required behaviour |
| --- | --- | --- |
| S-8.1 | Bind brute force | Rate limit and block per IP (S-1.1) |
| S-8.2 | Malformed or oversized PDUs | Fuzz test in CI; never crash a node, only the one session process |
| S-8.3 | Artificial traffic / SMS pumping | Firewall rules (§8) and traffic alerts (§13.4) |
| S-8.4 | Credentials | Stored hashed or encrypted; exported only per §13.22 |

## 9. HTTP API ingress

The same rules apply: one response per request, never waiting for the vendor; idempotency key header instead of the
SMPP duplicate filter; receipts to the callback URL with retries and signing.

---

## Decisions needed

Each needs the product owner's answer before the backend implements it (also listed in `docs/BACKEND_TODO.md`
under Open questions).

| # | Scenario | Question | Proposal |
| --- | --- | --- | --- |
| D1 | S-3.4 | A multipart group never completes: send the parts we have, or fail them? | **Decided 2026-10-24:** fail them (REJECTD, not billed), flag *incomplete* |
| D2 | S-3.11 | One part fails at the vendor: resend all parts via the next vendor? Who pays the first attempt? | **Decided 2026-10-24:** temporary error → retry the part on the same vendor; submit rejection → all parts via the next vendor; failed receipt → all parts via the next vendor only if no part was delivered and the failed part is not vendor-billable; otherwise fail |
| D3 | S-4.1 | Translation grows the part count: re-segment (margin loss) or block? Bill the customer on sent or delivered parts? | **Decided 2026-10-24:** block, REJECTD receipt, customer not billed |
| D4 | S-5.2 | Vendor submit timeout: resend (risk double delivery) or wait for a late resp/receipt? | **Decided 2026-10-24:** re-route automatically; mark *timeout, possibly sent*; late OK → *possible duplicate* flag; alert on frequent timeouts |
| D5 | S-5.10 | Real receipt after a generated timeout receipt: send a correction to the customer? | **Decided 2026-10-24:** no second receipt; correct the EDR, mark *late receipt* |
| D6 | S-2.7 | Duplicate-submit filter: wanted, and what window? | **Decided 2026-10-24:** per customer trunk, 60 s, sharing the fingerprint store with Loop Detection (S-5.16) |
| D7 | S-2.16 | Support transaction mode (resp waits for vendor)? | **Decided 2026-10-24:** treat every mode as store-and-forward, log the requested mode |
| D8 | S-2.15 | query_sm / cancel_sm / replace_sm support? | **Decided 2026-10-24:** query_sm yes; cancel_sm while queued; replace_sm no (0x03) |
| D9 | S-3.12 | National language shift tables (Turkish, Spanish, Portuguese…)? | **Decided 2026-10-24:** not in v1; pass through when a client sends them |
| D10 | S-2.9 | Accept empty messages? | **Decided 2026-10-24:** reject (0x01) unless the customer trunk allows |
| D11 | S-2.18 | Delayed Submit trunks: how long to wait for the vendor before answering, and answer what? | **Decided 2026-10-24:** as the spec: wait for the vendor's answer, no cap of our own; vendor timeout → 0x45 |
