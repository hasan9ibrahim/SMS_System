# Full system audit (team trial round 12, 2026-10-30)

The team asked for a full test of the frontend (every page, button, add and delete), the backend (logic, engine, API)
and security, with findings fixed and recommendations listed. Everything ran on the development machine on fake data
at full generated volume (about 1.4 million rate lines, 3,100 route rules, 550 rate tables, millions of EDRs).

## What was tested

| Area | How | Result |
| --- | --- | --- |
| Security | Code review of the Elixir API, the TypeScript service, the switch, nginx and Ansible; findings checked against the running service (curl, `X-View-As` as a restricted account manager) | 10 findings, 1 critical. All 10 fixed (below); hardening items left are under Recommendations |
| Backend logic | Review of routing, translation, rating, billing, invoicing, re-rating, time zones and the list engine; findings checked against the dev database and the running service | 8 groups of findings. The ones that change money or routing are fixed; the rest are under Recommendations |
| Frontend | Playwright on every menu page (79 routes) at 1600×900, 1366×768, 390 and 360 px; every Add/New dialog (31); history drawers, Views and Columns menus; tabs (31 open), right-click close, middle-click, split view; console errors and failed calls | 15 findings; all fixed except the minor ones listed under Recommendations |
| Live feed | Socket dropped and restored; socket silently stalled (frames muted by the test) | Reconnects in about 4 s after a drop; a stalled socket is now dropped and reconnected after 75–105 s (before: it showed frozen numbers as live) |
| Phones | Every page and every Add/New dialog at 390 and 360 px | 0 pages wider than the screen; card titles, stacked cells, dashboard tables and the rate table view fixed |
| Automated suites | Mock suite (458), web (174), Elixir switch (507 with integration), API (62 with integration), `mix check` (format, Credo strict, Dialyzer), contract lint and generated types | All pass except three mock tests that need more local EDR history than the dev data has (long-term totals, Master report hours); they pass on CI's fresh data |

## Fixed

| Finding | Severity | Fix | Commit |
| --- | --- | --- | --- |
| A percent-encoded path (`/api/v1/%75sers/1`) skipped the access-group check: any signed-in user could give themselves every Admin page | Critical | The API answers 404 to any path that is not a known operation; encoded, dot and unknown paths are never forwarded; the service checks the operation the API checked (`X-Sms-Op`) | 9505062 |
| A zip bomb in an e-mailed rate notice could exhaust memory on the server | High | Size limits on inflating sheets and on mail attachments; a bad message is skipped, never read again | 9505062 |
| AM visibility (§13.17) did not reach EDR search, EDR downloads, the route rules export or the live socket | High | Masking and hiding on all of them; downloads are built as the user who asked and only they can fetch them | 556d5ae |
| An HLR provider URL could point at local services (ClickHouse, Patroni) | Medium-high | Provider URLs must be http(s) to public addresses, checked after DNS, in the screens and in the switch | 9505062 |
| A user manager could take over or remove an administrator's 2FA | Medium | Admin guard on 2FA setup, confirm, disable and forced password change | 9505062 |
| Check SMTP sent the stored mailbox password to any host named in the request | Medium | The stored password is used only for the same host, port and login; Edit needed | 9505062 |
| The 2FA code could be brute-forced by someone with the password | Medium-low | Code and resend counted in the rate limit; failed codes lock the user; resend keeps the try count | 9505062 |
| CSV formula injection in every export (message text and sender IDs come from outside) | Low-medium | Every CSV writer neutralises a leading `= + - @` | 9505062 |
| Sign-in timing told which usernames exist | Low | A decoy password check for unknown usernames (API, staff and portal sign-in) | 9505062, 4df29e8 |
| The live socket was not checked again after connecting, and took any Origin | Low | Session re-checked every minute; foreign Origin refused | 556d5ae |
| Saved rates, costs and rules did not show in Rate lookup, Route rules and Route map until a cache expired; an undo of a vendor change never showed | High (daily use) | Every routing write clears the route caches; the web refreshes those screens; vendor-cost country fallback; scheduled-only lines in Rate lookup | f434a87 |
| The Route Rules simulator skipped the customer trunk's ingress translation | High | Ingress translation runs first, as in the switch | f434a87 |
| A receipt-only translation rule set to Stop ended the chain for every message, so later rules never ran | High | A rule stops the chain only for the kind of message it changes (screens and switch) | f434a87 |
| **The switch never applied Sender ID rates**: traffic was billed at the general rate, while Rate Lookup and Re-rating used the sender's rate | High (billing) | The switch loads Sender ID lines and prices with them first (sender's network, then country, then generic) | 113d910 |
| An invoice run stopped by a restart failed as "Already invoiced" and left that invoice Inprogress at zero (a proforma made a second invoice) | Medium (billing) | The run carries on with the invoice it made | 4df29e8 |
| Midnight in a partner's time zone was an hour off on daylight-saving change days east of UTC | Medium (billing) | The offset is read at local midnight | 4df29e8 |
| Least-cost ties went to a different vendor on the screens than in the switch; the screens offered vendors the switch skips (inactive enterprise, stopped bind) | Medium | Same tie-break (lower vendor trunk id) and the same "routable" rule as the switch | 4df29e8 |
| MCCMNC import (replace) timed out at full volume | Medium | The "codes in use" check reads each table once (2.5 s to 0.3 s) | df1f354 |
| Tall dialogs inside a tab could not reach Save; route rule drafts were left behind when a tab closed | High | Dialogs scroll inside the tab; a draft is discarded when its dialog goes away | 9505062 |
| Incidents Export always failed (limit above the contract's 4,000) | High | Exports up to 4,000 rows | 9505062 |
| Sales and NOC reports showed no grid rows at 1600×900; Route simulator settings were cut off at 1366×768 | High | A list page keeps about six rows of its grid and scrolls when the top area is tall | this round |
| Phones: rate table view squeezed beside the list; dashboard top lists cut (client names squeezed to nothing); card badges clipped; enterprise History tab unreachable; dialog footers below the screen | Medium | Each fixed; 0 overflow at 390 and 360 px on every page and dialog | 9505062, 3d06770, 60d987b, this round |
| Rate Manager table view and LCR showed few rows on a laptop | Medium | Compact summary, toolbar and filter card | 0933398 |
| A stalled live socket kept showing "Live" with frozen numbers | Low | Dropped and reconnected after 75 s without a frame | 4df29e8 |
| Audit rows could be lost when the service stopped | Low | The service waits for them when it closes | 4df29e8 |

## Recommendations (not changed)

Security hardening, most useful first:

1. **Trial VM:** set `TEAM_PASSWORD` in its `.env`. With it empty the trial is open to anyone who can reach port 8080
   (fake data, but still).
2. **Secrets at rest:** trunk SMPP passwords and HLR provider passwords are stored in plain text in PostgreSQL (TOTP
   secrets and mailbox passwords are encrypted). Encrypting them needs the switch to decrypt at load; worth doing before
   real partner credentials go in.
3. **ClickHouse `default` user:** local-only with an empty password. The HLR path to it is closed, but give it a password
   or remove it (`deploy/ansible/roles/clickhouse/templates/users.xml.j2`).
4. **Content-Security-Policy** in nginx. Needs a test pass because e-mail previews use iframes and charts use inline
   styles.
5. **TOTP replay:** the same code works again within its 30-second window. Store the last used time step per user.
6. **Ansible** passes the ClickHouse password on the `clickhouse-client` command line (visible in `ps` while it runs).
7. **Sign-in cost:** each sign-in spends about 0.4 s of CPU on the password hash and the IP limit is per server; add a
   global limit if the sign-in page is reachable from the internet.
8. **Lab secrets** in `deploy/lab` are fake; never reuse them on the real servers.

Business logic to decide (the screens and the switch agree today; these are choices):

- **Vendor Sender ID rates:** decided 2026-10-30: matched on the sender the vendor receives, after its egress
  translation (EDR `v_src_addr`); the customer side keeps the sender as the customer sent it.
- **A blocked rate line:** decided 2026-10-30: blocked means blocked in the switch, the screens and Re-rating. No
  fallback to the country line or a later table; the customer is refused, the vendor passed over.
- **Re-rating** prices each hour at the rate valid at half past, uses UTC days, and a start of "Today 00:00" counts as
  back-dated. Fine for whole-day rate changes; a mid-hour change is priced to the hour.
- **Currency without an exchange rate** converts 1:1 to EUR silently; consider an alert instead. The conversion factor
  is kept to 8 decimals, which is up to about 0.2 % off for currencies with very large units (IRR-sized).
- **Vendor TPS skip:** the switch skips a vendor at its TPS-percentage limit; the screens' route test does not show
  that (it depends on live load).
- **Quality routing without destination statistics:** the screens fall back to the vendor's 7-day DLR, the switch
  leaves it empty, so the order can differ until statistics exist.
- **Non-text codings** (8-bit binary): content translation rules see empty text and never change them.

Smaller frontend points:

- With 30+ tabs open, inactive tabs shrink to an icon (titles on hover and in the tab list).
- Date fields use the browser's date picker, which shows the browser's own format.
- Uploaded format files (rate sheet, SOA, invoice layout) are stored but the files are not yet laid out from them.
- Slowest pages at full volume on the 4-CPU dev machine: Rate lookup 6.5 s, Sales report 5.7 s, Billing 4.4 s.
- "Online now" on the Dashboard opens Logged-in users in the same tab, as the per-user "open in new tab" setting says.
- Two server errors seen once during the audit (Team report, the first Rate tables load) did not happen again on
  retry; no cause found.
- The browser console shows `ERR_ABORTED` for answers with no body through the development proxy; the calls succeed.

## Checked and found sound

The PostgreSQL list engine (parameterised; field and sort names checked against the catalogue), ClickHouse escaping,
the §13.25 filter grammar (case-insensitive, `%` and `_`, regex, AND/OR), set-password links (hashed, single use, end
sessions), migration export (admin and 2FA), e-mail previews (sandboxed), document downloads (attachments only), ports
bound to loopback (nftables), session cookies (HttpOnly, SameSite=Lax, Secure in production), page access and masking
on search and lookups, portal data scoped to the user's enterprise, `X-View-As` for administrators only, and safe
delete blocking on open billing.
