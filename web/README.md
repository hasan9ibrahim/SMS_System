# web: the GUI

React + TypeScript + Vite. The GUI talks to the backend only through `contract/` (CLAUDE.md
rule 2): REST through the generated types (`src/api/`), live data over the Phoenix-protocol
socket (`src/live/`).

```bash
npm run dev:mock     # repo root, after npm run db:up && npm run seed:small
npm run dev:web      # http://localhost:5173
npm test -w web      # filter model, tab rules, saved views, form helpers, rate and route rule models
```

## App shell (build step 3)

| Part | Files | Spec |
| --- | --- | --- |
| Top menu bar: sections, Ctrl K, live TPS pill, alert bell, avatar menu (theme, open-in-new-tab) | `src/shell/TopMenu.tsx` | §15.1 |
| Page tabs: Home pinned, reorder by drag, pin, duplicate, close (warns on unsaved changes), middle-click close, open-tabs list, split view; drag a tab out of the window for its own window, drag it back or press Dock back | `src/shell/tabs.ts`, `TabStrip.tsx`, `Popout.tsx`, `channel.ts` | §13.5, §15.1 |
| Each tab renders its own route tree from its own path and stays mounted, so filters, scroll and drafts survive switching; the open set is saved to `/me/workspace` | `src/shell/TabPane.tsx`, `tabContext.tsx` | §13.5 |
| Search or jump to (Ctrl K): pages and records | `src/shell/CommandPalette.tsx` | §15.1 |
| Light and dark themes from the §15.2 tokens, saved as a preference | `src/styles/tokens.css`, `src/shell/theme.ts` | §15.2 |
| Status bar: rows, shortcuts, autosave, server time (UTC) | `src/shell/StatusBar.tsx` | §15.1 |
| Incident pop-up cards and tab alert dots | `src/shell/IncidentPopups.tsx`, `src/live/store.ts` | §13.5, §13.6 |

## Enterprises and trunks (build step 4.1)

| Screen | Path | Files | Spec |
| --- | --- | --- | --- |
| Enterprise list, Customer trunks, Vendor trunks (Show deleted, Undo, History) | `/enterprises`, `/enterprises/customer-trunks`, `/enterprises/vendor-trunks` | `src/pages/EnterprisesPage.tsx`, `TrunksPage.tsx` | §5, §13.29 |
| Enterprise record: "Name – Alias (ID)" picker; General, Docs, Billing, Customer trunks, Vendor trunks, Account managers (Hand over now or scheduled), History | `/enterprises/:id`, `/enterprises/new` | `src/pages/enterprise/` | §5.1–5.3, §13.30 |
| Trunk record: General form, Rules (order, on/off, continue, detach direct rules), History; Clone; write-only password | `/enterprises/customer-trunks/:id`, `/enterprises/vendor-trunks/:id`, `…/new?enterprise=ID`, `…/new?clone=ID` | `src/pages/trunk/` | §5.4, §5.5, §13.1, §13.2, §13.26 |
| Safe delete: dependencies, blockers, admin override with reason; archived banner with Restore | — | `src/records/parts.tsx` | §13.29 |

## Rate Manager (build step 4.2)

`/rates/manager` (`src/pages/rates/`, §13.12). The list of all rate tables fills the page (clients,
trunks, active rates, scheduled changes, negative-margin lines, avg margin and money today from
the EDR store, account manager filter). Opening a table (`?table=ID`, also from trunk pages)
shows the left panel (Customer / Vendor switch, filter, tables by category) and the table:
header with its trunks and last import, summary cards, views Current / Scheduled / Closed /
Change log, and the rate grid with best buy, margin and the next scheduled rate. Click a sell
rate to edit it in place; select rows for the bulk bar (set rate, change by % / amount / best buy
+ margin, effective date, block, close). "Save n changes" sends one batch (`pending.ts`), which is
one change with Undo; increases inside a client's notice period ask for confirmation first.

**Bulk rating** (`/rates/bulk`, `BulkRatingPage.tsx` + `bulkModel.ts`, §13.11): several clients' rate
tables × destinations (MCCMNC, country or a pasted list) with one action (fixed rate, change by % /
amount, cost + margin from best buy or a vendor trunk, round, close, block). Preview fills a review
grid: type over a rate or a formula (`=cost*1.15`), exclude below-cost or short-notice rows, and the
impact cards follow. Apply is one change over all tables, undone as one. It opens pre-filled from the
Rate Manager list (select tables › Bulk edit › Bulk rating), the table bulk bar and Rate Lookup's
"Update rates".

**Incoming RNs** (`/rates/incoming`, `src/pages/rates/incoming/`, §13.13 A, §13.32): the queue of vendor rate
notifications (flags, notice breaches, back-dated lines, status; due-soon rows amber), Add RN (upload a CSV / TSV or
simulate an e-mail), Settings (live window, reminder, auto-accept, reply modes; per vendor overrides, notice days and
the remembered columns). Opening an RN (`?rn=ID`) shows the review: counts, the lines with flagged ones on top and column
filters, Accept / Reject for all or selected lines, Accept + reroute (Route Rules on the trunk), Accept + update
customers (Bulk rating on the affected tables), Re-check, Assign to trunk, and the replies (drafts can be edited and
sent), log and file errors.

**Market moves** (`/rates/market-moves`, `src/pages/rates/market/`, §13.14): moves where leading vendors changed their rate
for a destination (direction and average change, "n of m" top vendors, dates, market cost before and after, urgent),
filtered by account manager. The detail shows a chart of the top vendors' rates over 90 days, the vendors (Reroute…
opens Route Rules on one), the affected clients with margins, notice and a suggested rate (Update rates opens Bulk
rating pre-filled with the chosen suggestions), snooze / dismiss / handled / note and the log. Settings hold the
detection rules, the digest hour and auto-apply rules. The dashboard summary shows a Market moves count.

**LCR** (`/routing/lcr`, `src/pages/routing/lcr/`, §13.23): views in the URL (`?view=table|clients|profiles|changes`).
The LCR table ranks every vendor trunk for a destination (picker, point in time with "Next Monday", profile,
quality-weighted score with weights) with quality, TPS, scheduled changes and current routing. What-if removes vendors
or sets a vendor's cost and shows the routes and 7-day margin that change. The client view compares a client's or
account manager's sell rates with LCR 1–3. Profiles are edited in a dialog; Least cost route rules pick one in their
Vendors section, and Route Rules' Bulk edit can apply one to many rules. Changes lists top-vendor changes and cost moves.

**Visibility policies** (`/admin/visibility`, `src/pages/admin/visibility/`, §13.17): views in the URL
(`?view=policies|assignments|grants`). Policies are edited in a dialog (mask others, team scope, shown / hidden / band per
item for others and own, thresholds; new ones start from a preset). Assignments go to all account managers, a department
or a user, with a check of any user's effective policy; users also show it on their profile. Shares and temporary access
give one user sight of one enterprise. Administrators can "View as user…" from the user menu: every call then carries
`X-View-As` (`src/api/client.ts`), a banner names the user and policy, and grids show withheld values as Hidden, Low /
Normal / High or Above limit (`ListPageMeta.masked`).

## Route Rules (build step 4.3)

`/routing/rules` (`src/pages/routing/`, §15.4) copies the reference screenshot's layout and form.
The header has Undo, History, Export (CSV of the filtered rules), Simulate (Route Simulator dialog)
and New rule. The filter row shows the chips, Clear all and Save as view, and on the right "n selected · X msgs"
and the Bulk edit menu (turn on / off, set or shift priority, replace vendor, delete). The grid
shows a coloured type dot, customer trunks "+N" (hover for all), the vendor split (click it to edit
level 1 in place), and the 24h volume (hover for the per-customer breakdown with a 15m–30d time frame). Margin
turns red when negative. Click the On dot to toggle.
The detail panel has:

- **Conditions:** "#id name", "all must match" (click to switch to any), + Add condition, and
  chips for trunk, category, destination (§13.21 picker), sender / receiver / content, TPS (§13.8),
  revenue (§13.9), time, HLR ported, HLR action (§13.24) and multipart. Click a chip to edit it; its
  × removes it.
- **Vendors:** route type, hunt policy, levels with share, backup and warm-up (§13.27), vendor scope for least cost and QBR,
  limits, number whitelists.
- **Traffic:** an ECharts chart plus per-customer and per-vendor tables.
- **History**, and **Test** (a sample number through the rule).
- **Right side:** the 24h trend.

DLR turns amber below the rule's target (its own, else its destinations'; the tooltip says
which). Destination targets are set on the MCCMNC codes page (`/rates/mccmnc`, `src/pages/destinations/`).
Shortcuts: E edit (rule settings dialog), D duplicate (inactive copy). Each save is one change with
Undo. Charts use `src/ui/Chart.tsx`, which reads the theme tokens and redraws when the theme changes.

## Rate Lookup (build step 4.4)

`/routing/rate-lookup` (`src/pages/lookup/`, §13.16). **Easy** mode has one search box (country,
network, MCCMNC, dial code or phone number, optionally by live HLR). As you type, the best match
loads into two panels: vendor costs (cheapest first, tier, scheduled change, 24h ASR/DLR, routed
marker) and client rates (account manager, 7-day volume, margin against the best vendor and against
the routed vendor, negatives in red). Toggles: my clients, include inactive, scheduled rates,
currency. Rates open Rate Manager and names open the trunk, both in a new tab; each panel copies
to the clipboard or downloads as CSV.

**Advanced** mode looks up many destinations at once: countries, pasted MCCMNCs or numbers, or an
uploaded file. It has filters, an "as of" date, views (vendor costs, client rates, margin matrix,
cheapest N) and highlight filters. The matrix pages on the server and scrolls virtualised
(`VirtualTable.tsx`, sticky header and first columns). Results export to CSV, and lookups can be
saved and shared. The mode, destination and lookup live in the tab URL.

## Enterprise report (build step 4.5)

`/reports/enterprise` (`src/pages/reports/`, §10, §13.31). The settings bar takes:

- customers or vendors;
- a period, with quick choices (today, yesterday, last 7 days, this month, last month);
- the time zone: partner's billing time zone (default), UTC or platform;
- report by: whole period, hour, day, week or month;
- rows by: enterprise, trunk, country, destination and/or account manager;
- filters: enterprises, trunks, destinations, account managers at send time, MT/MO.

Run report applies the settings, which go into the tab URL. The result is the standard grid
(`ListScreen` with `fetchPage`): a filter under every column, server-side sort and paging, Columns to
pick among the 27 metrics, totals above the grid, and Export (CSV with the time zone printed).

## Live dashboard (build step 4.6)

`/dashboard` (`src/pages/dashboard/`, §4, §13.3), loaded on first use. All data is pushed: the page
opens its own Phoenix socket, joins `live:tps` (an hour of history on join, then a tick a second) and
`live:dashboard` with the movers window and threshold as join params (re-joined when they change).
Panels: today's summary bar with rolling counters, traffic movers (started with a "new" badge and
pulse, increasing, decreasing, stopped, each with a sparkline), the live TPS chart (5 / 15 / 60 min,
total on the left axis and the top-10 client trunks on the right, toggled from the legend), TPS per
client and vendor trunk (limit bar amber above 80 %, red at 100 %, queue depth, rows slide when the
order changes), top clients and vendors, top destinations. Window, threshold, chart length and
hidden panels (Panels menu) are saved in `preferences.dashboard`; motion follows the user menu's
"Turn animations off" (and `prefers-reduced-motion`). Rows, chips and chart lines open the Analytics
view in a new tab (`/live/analytics?customer=`, `vendor=`, `customerTrunk=`, `vendorTrunk=` or
`mccmnc=`; the page itself comes in build step 5). The chart buffer and colour rules are pure
functions in `dashboardModel.ts` with tests.

## Product reference data (build step 5.1)

`src/pages/reference/` and `src/pages/destinations/MccmncPage.tsx` (§6.1), all on the standard grid
with a filter under every column:

- **Product categories** (`/rates/categories`): add, rename, delete (blocked while in use; the
  delete dialog lists what uses it), "Show deleted" = Delete History.
- **Countries** (`/rates/countries`): add, edit, export; the region set feeds the destination picker.
- **MCCMNC codes** (`/rates/mccmnc`): the spec's columns (MCC, MNC, Original MNC, MCCMNC, ISO,
  Country, Country Code, network) plus the DLR target cell; add, edit, delete, import, export.
- **Master table** (`/rates/master-table`): profiles; a profile opens its dial codes in the same tab
  (`?profile=<id>`), with add, edit, bulk delete (select rows), import and export.
- **MO reference book** (`/rates/mo-book`): add, edit, delete, import, export. Amounts are in the
  customer trunk's currency (shown read-only in the dialog once a trunk is picked).

Imports share one dialog (`shared.tsx` `openImport`): choose a CSV, the server checks it (dry run),
the dialog shows the counts, errors by line, rows kept because they are in use, and remarks; Import
is enabled only without errors. "Replace" mode archives what the file leaves out. Templates are
downloadable from the dialog. Every save, delete and import is one undoable change.

## Route map, Re-rating, QBR stats (build step 5.2)

- **Route map** (`/routing/map`, `src/pages/routing/RouteMapPage.tsx`, §6.3): pick a customer trunk (kept in the
  URL, `?trunk=`); the grid shows every destination it sells with the route status (routed, blocked, no vendor,
  no rule), the deciding rule (links to Route rules), the vendor, cost and margin. Server-side filter and sort on
  every column; Export.
- **Re-rating** (`/routing/re-rating`, `ReratingPage.tsx`, §6.3, §12.2): requests with Request Status (maker-checker)
  and Reprocess Status. "Request re-rating" opens the §12.2 form with a Preview of the EDRs and amounts per
  enterprise. The detail shows the Re-Rating Summary and, for another user's pending request, Approve and Decline;
  it refreshes itself while the job runs.
- **QBR stats** (`/switch/qbr-stats`, `src/pages/switch/QbrStatsPage.tsx`, §6.3): customer or vendor trunks
  (`?side=`), ASR / DLR / ADD per destination over 24 hours. "Add vendor stat" and Override set a manual stat; the
  detail compares traffic and the figures QBR routing uses; Clear override; undo.

## Live analytics and monitoring alerts (build step 5.12)

- **Live analytics** (`/live/analytics`, `src/pages/live/`, helpers in `analyticsModel.ts`): Report By, period (today live,
  or yesterday / this week / this month from the Master Report), update interval, compare window, search and "only sending
  now". Figures are pushed on `live:analytics`; when rates change, the cells flash green or red. The header and the first
  column stay in place, and column headers sort on the server. Pause / Resume. The URL keeps `?by=&q=&period=`.
- **Alert rules** (`/monitoring/alert-rules`, `src/pages/monitoring/alerts/`): the §13.6 form covers scope with chips,
  metric, condition, window and minimum sample, active hours, severity, notify (users, departments, pop-up, sound,
  e-mail with extra addresses and the partner's contact), repeat, cooldown and recovery. "Test on live traffic" shows
  what would fire now. Detail actions: Enable / Disable, Clone, Incidents, Edit, Delete; undoable.
- **Incidents** (`/monitoring/incidents`): history and live incidents. The detail has Acknowledge, Snooze, Open in
  Analytics and notes; Export to CSV. `?incident=<id>` selects one.
- **Shell**: the bell lists the open incidents from the API; pop-up cards (`src/shell/IncidentPopups.tsx`) acknowledge
  and snooze through the API. Sounds are in `src/live/sounds.ts`; avatar menu › Alert sounds sets mute and a sound per
  severity.

## Admin (build step 5.11)

Pages in `src/pages/admin/` (§11, §12.5, §13.28), hooks in `src/api/admin.ts`, pure helpers in `adminModel.ts`, and
shared pieces (password rules checklist, temporary password dialog, my password dialog) in `parts.tsx`:

- **Users** (`/admin/users`): the §11 grid with the §13.28 Password column (state and days left, filterable), 2FA
  and last login. The form is the §12.5 user edit page; a new user needs a temporary password, checked live against
  the rules. The detail has Profile and Password & 2FA. Change password sets a temporary password (24 h). Force change
  works on one user or, through Bulk edit, on the selected users. QR 2FA is enrolled with a code from the app.
  Delete shows what blocks it (AM of live enterprises).
- **Departments** (`/admin/departments`) and **GUI access groups** (`/admin/access-groups`): the access group form is
  the page × action matrix of every menu page, with "Every page", all / none per section and a page filter. The
  detail shows the matrix read-only; Clone; "Users" opens the Users page filtered to the department or group.
- **Logged-in users** (`/admin/logged-in`): open sessions with Force logout; your own session is marked.
- **Audit trail** (`/admin/audit`): read-only list of every call that changed something.
- **Email templates** (`/admin/email-templates`): the editor has placeholder chips for the chosen type (they insert
  at the caret) and a live preview with fake sample values in a sandboxed frame; Clone.
- **Business companies** (`/admin/business-companies`): the form has five parts (Company, Default templates,
  Address & bank, Mailboxes with Check SMTP Connection, Format files with the variables help). Mailbox passwords and
  secrets are write-only: blank keeps the stored one.
- **Customer portal** (`/admin/customer-portal`): portal logins for customers, with temporary passwords.
- **Change password** in the avatar menu: current password, new password with the rules, and the 2FA code. In this
  phase, user 1's fake password is `demo-password-2026` and its fake TOTP secret is in `docs/BACKEND_TODO.md`.

## Reports (build step 5.10)

Pages in `src/pages/reports/` (§10, §13.15), hooks in `src/api/masterReports.ts`, helpers in `masterModel.ts`:

- **Master report** (`/reports/master`), **Sales report** (`/reports/sales`) and **NOC report** (`/reports/noc`) share
  `ReportScreen.tsx`. It has settings (period, time zone, MO / MT, compare) in the tab URL (`?r=`). Group-by fields
  (ordered chips, up to 5) and metrics (Column Selection) are the grid's visible columns, so the standard grid gives a
  filter under every column (fields before grouping, metrics after), sort, paging and Views. Above the grid: totals
  with deltas and a chart. Each row offers drill-down (keep this row, add a level) and "EDRs behind this row" (EDR
  search with the matching filters). Export goes to Excel / CSV / PDF. Save view keeps the report settings;
  "Report views…" opens one. The Master report adds "Start from…" with the presets. Sales and NOC add their panels
  (collapsible). These three pages load lazily, with ECharts.
- **Billing report** (`/reports/billing`): per enterprise list with the period in the URL.
- **Scheduled reports** (`/reports/scheduled`) and **Daily traffic alerts** (`/reports/daily-traffic`): forms with CRON
  preview and Run now / Send now; undoable.

## Observation Deck (build step 5.9)

Pages in `src/pages/monitoring/` (§9), hooks in `src/api/observation.ts`, pure helpers in `monitorModel.ts`, shared
pieces (view tabs, auto refresh, download list and request dialog) in `parts.tsx`:

- **EDR search** (`/monitoring/edr`): every attempt with both legs from the EDR store; From / To (UTC), Final and
  message ID lists in the filter row; EDR Template sets the columns; Bulk edit Trouble Ticket (preview, columns,
  attachment) and EDR Repush; Export queues an EDR Request. The detail shows the customer leg, vendor leg, outcome,
  money and HLR, and every attempt of the message. EDR rows are keyed by UUID, so the grid uses `uuidKey()`.
- **EDR download** (`/monitoring/edr-download`) and **Failed EDRs** (`/monitoring/failed-edr`, tabs Search and
  Download, `?view=downloads`): background exports with progress, file and cancel; refreshes every 3 s.
- **EDR templates** (`/monitoring/edr-templates`): saved column sets with order; undoable.
- **Network status** (`/monitoring/network-status`, `?side=vendor`): bind status, connections, queue, TPS, per-row
  Start / Stop, CSV / Excel, SMPP sessions in the detail (§13.1); refreshes every 10 s.
- **Signaling deck** (`/monitoring/signaling`): start a capture (filter, max duration, max size), stop, download pcap.
- **Route simulator** (`/routing/simulator`): the full path of a message through a customer trunk, with the live
  message size counter; Test SMS.
- **Network diagnosis** (`/monitoring/diagnosis`): ping, trace route, MTR, telnet; the last ten runs stay on the page.
- **Repush requests** (`/monitoring/repush`): links to the new attempts in EDR search.

## Switch utilities (build step 5.8)

Pages in `src/pages/switch/tools/` (§8), hooks in `src/api/switchTools.ts`, pure helpers in `toolsModel.ts`:

- **Notifications** (`/switch/notifications`): customer trunks; per row or as bulk edit Send Rate (Excel / CSV, Send
  Email with a preview of the e-mail) and Send Tech Info; View Rate downloads the sheet; the detail lists the trunk's
  recent e-mails.
- **Email logs** (`/switch/email-logs`): every e-mail sent, with filters, export and the e-mail itself in the detail.
- **Firewall** (`/switch/firewall`, `?view=banned|trusted|filters`): add an IP or range to a filter, remove (Undo),
  check which rule an IP meets; filters with their listeners.
- **Traffic alerts** (`/switch/traffic-alerts`): alert rules with sample size and thresholds, conditions, recipients;
  clone, Check now, last state.
- **SMS to voice** (`/switch/sms-to-voice`): rules with the test box above the grid.
- **Broadcast** (`/switch/broadcast`): past broadcasts; New broadcast composes (mailbox, contact and enterprise types,
  rich text, one attachment), shows the audience count, and sends after a confirm.

## SOA (build step 5.7)

- **SOA** (`/finance/soa`, `src/pages/finance/SoaPage.tsx`, §7, §13.31, §13.33): Enterprise (multi), Invoice Type,
  From / To Date and the Send SOA e-mail template; Search lists one row per enterprise with opening and closing
  balances, lines, payments left off, disputed invoices, billing contact and the last SOA sent; Check All / Uncheck
  All, Send Email (preview per enterprise, confirm to send) and Queue SOA Export (Excel or PDF). Click a row for the
  statement: per side every line with source (Auto / Manual), status, amount and running balance; Remove or Take
  back by hand (reason logged, Undo); the disputed block with Add to SOA; payments left off with Include; removed
  lines with Put back; Manual entry (SOA only, or Changes the balance: also records a transaction); the difference from the system balance; the net balance. Opened from Send SOA
  on the Enterprise balance and Invoice pages (`?enterprises=`).
- **SOA report** (`/finance/soa-report`, `SoaReportPage.tsx`): exports and sent SOAs with status, error, download and
  per-row Send Email (template picker).

## Invoices and vendor invoices (build step 5.6)

- **Invoices** (`/finance/invoices`, `src/pages/finance/InvoicesPage.tsx`, §7, §12.3): the invoice grid with PDF and
  Charge Details icons, balances with the §7 sign (owed amounts amber) and the due amount; bulk Send Invoice and Mark;
  the detail panel (invoice, linked payments, e-mail, Edit due date / remarks, PDF, Send, Regenerate, delete) and
  Charge Details per MCCMNC and rate. Generate Request (Traffic or Proforma, several enterprises, time zone, usage
  period, due date auto / manual) starts background requests; the page follows them and reports when they finish.
  Invoice requests list: `?view=requests`.
- **Vendor invoices** (`/finance/vendor-invoices`, `VendorInvoicesPage.tsx`, §13.31), three views (`?view=`):
  - **Invoices**: their and our figures, dispute amount and difference %, check result and status, Input From/To
    (the UTC window our figures were counted for; hover for the partner's time zone); Add (with
    optional per-destination lines pasted as text), Import (CSV, dry run first), Export. The result screen shows the
    figures, why it matched or not, the rule used, the e-mail and SOA status, and every check, status change, note and
    e-mail; Accept / Reject / Keep pending / Send acceptance with an e-mail preview, Check again, Note, delete. The
    Destinations section compares per MCCMNC, largest difference first.
  - **Reconciliation rules**: the default rule and per-partner rules (amount and count tolerance, stricter / looser,
    per-destination check, acceptance e-mail at once or after confirmation, disputed invoices in the SOA).
  - **Monthly summary**: invoices per month by result and status, their and our amounts and the difference in the
    platform currency; filters by partner and account manager.
- The mock "receives" weekly vendor invoices for weeks the fake EDRs fully hold, so mismatches and destination
  lines can be tried on fresh data.

## Finance part 1 (build step 5.5)

- **Transactions** (`/finance/transactions`, `src/pages/finance/TransactionsPage.tsx`, §7, §13.33): the grid with
  Confirmation and In SOA columns; the form (Transaction Information, Conversion with the Final Amount in the base
  currency, Send payment confirmation with a preview, Include in SOA with a reason). Bulk include / exclude / send
  confirmations; re-send from the detail panel; delete and restore; export.
- **Currencies** (`/finance/currencies`, `CurrenciesPage.tsx`): Currency (add, edit, export), Currency Exchange (edit a
  rate, Sync Rates) and the exchange history (`?view=`).
- **Billing cycles** (`/finance/billing-cycles`): add, edit, safe delete.
- **Enterprise balance** (`/finance/balances`): customer, vendor and net balances, credit use, export.
- **Charges calculator** (`/finance/charges`): usage charges per enterprise and side for a period.
- Pickers and menus now open above dialogs (`.popover` z-index), so list pickers inside forms work.

## HLR (build step 5.4)

- **HLR** (`/switch/hlr`, `src/pages/switch/hlr/`, §6.5, §13.24): one page with three views (`?view=`).
  - **Providers**: live status (up, slow, down) and the last 24 hours of lookups, success, response time and cost;
    the §6.5 form with request template, credentials (password write-only), headers, POST data and the response
    mapping. **Prices** (`?provider=`): per-destination price per lookup, Set price, Import Rate, Export Rate.
  - **Rules**: provider + DNID pattern (with a "try a number" check) + Applies To customer trunks, enterprises,
    categories or all; Used by; the trunk Rules tab orders them per trunk.
  - **Policies**: per destination (network, country or catch-all) the providers in order or "auto" with a minimum
    success rate, and cache hours for ported and not-ported answers. Test shows which provider a number gets.
- Route Rules' **HLR action** now picks a policy from the list (§13.24).

## Number lists and Translation rules (build step 5.3)

- **Number lists** (`/switch/number-lists`, `src/pages/switch/NumberListsPage.tsx`, §6.4, §12.4): Tag, Random and
  Sender ID Template lists with entry count and Used by. Open a list (`?list=`) for its entries: Add (paste one per
  line), bulk Delete, Import List (dry run, add or replace) and Export. Delete is blocked while rules use a list.
- **Translation rules** (`/switch/translation-rules`, `TranslationRulesPage.tsx`, §6.4, §13.2): the §6.4 grid plus
  Applies To and Used by. The form holds every §6.4 field with Match / Not Match per condition, "+ New list" inside
  the list pickers, and the Applies To block (trunks, enterprises, categories or all trunks per side), so saving
  applies the rule at once. Saving a rule shared by several trunks asks first; Clone makes an inactive copy;
  Duplicate to trunk makes the variant for one trunk and switches the original off there. Detail: Rule, Used by,
  Test, History.
- **Test** (`TranslationTest.tsx`, §13.2): a sample message (sender, receiver, text, TON/NPI, vendor DLR) through
  one rule (saved, or the unsaved form from the editor) or a trunk's whole list (trunk Rules tab, with the HLR
  rule and provider on customer trunks): before → after values and every check per rule.

## Building a record page

- **Form kit** (`src/form/form.tsx`): `useForm(initial)` holds one state object with a dirty flag
  and field errors; `form.fail(err)` maps a `400` answer's `errors[].path` (e.g. `/address/city`)
  to the field. Fields: `TextField`, `NumberField`, `SelectField`, `CheckField`, `ListField`
  (emails, IPs), `MultiCheck`, `TextArea`, `ReadOnly`, laid out in `Section`s. Required fields
  show a red `*`.
- **Record parts** (`src/records/parts.tsx`): `useSectionTab` keeps the section in the tab URL
  (`?tab=billing`); `HeaderAction` puts the active section's main action in the page header as
  the page's one filled button; `ChildGrid` is a server-side grid with a fixed filter (an
  enterprise's trunks); `ListLookup` picks a record from a list by quick search;
  `useDeleteRecord` opens the safe-delete dialog; `ArchivedBanner` shows deleted records with
  Restore (admins).
- **Saves** answer `{record, change}`: reset the form to `record` and pass `change` to
  `useNotifySaved()` for the 10-second Undo toast. Record queries live under `["record", …]`,
  so a save or an undo refreshes every open view of the record. Sections stay mounted once
  opened, so switching sections keeps unsaved edits, and the tab shows the unsaved dot.

## Building a list page

`ListScreen` (`src/page/ListScreen.tsx`) gives a page the whole §15.1 layout: header with
sibling links and one filled button, active-filter chips, quick search, filter builder,
saved views, column chooser, selection with Bulk edit, the grid, a detail panel and the
status-bar text. A page only names its list and overrides what it needs:

```tsx
<ListScreen<Enterprise>
  list="enterprises"                         // POST /enterprises/query + its field catalogue
  page={pageForPath("/enterprises")!}
  columns={{ name: { width: 240, render: (r) => <strong>{r.name}</strong> } }}
  detail={(r) => ({ title: r.name, sections: [...] })}
  historyScope={{ entityTypes: ["route_rule"] }}   // header Undo / History and Ctrl+Z (§13.10)
/>
```

Optional: `actions` (extra header buttons), `onExport`, `selection` (summary text and Bulk edit
menu items), `onKey` (page shortcuts on the grid), `rowClass`, `selectId` (activate a row once
loaded) and `section` (control the open detail section). A column override can set `label` to
rename its header, and a detail section can add `actions` to the title row.

The grid (`src/grid/DataGrid.tsx`) filters, sorts and pages on the server; rows are
virtualised and the next page loads as you scroll. Grid state is kept in the tab's URL
(`?g=…`), so it survives reload, pop-out and restore.

Column filter shorthand (`src/grid/filterModel.ts`):

| Field | Type in the box | Means |
| --- | --- | --- |
| Text | `au` · `re%` · `a_c` · `=ACME` · `!test` · `/^ab/` · `empty` | contains · wildcards · equals · does not contain · regex · empty |
| Prefix / MCCMNC | `505` | starts with |
| Number | `5` · `>=5` · `<0` · `!=4` · `5..10` · `1,2,3` | equals · comparisons · not equal · range · in list |
| Date | `2026-10-16` · `>=2026-10-01` · `2026-10-01..2026-10-16` | that day · from · range |
| Fixed values | dropdown with Select all | in list |

## Undo and history hooks

`src/history/undo.tsx`: `useUndo()` (handles the 409 conflict dialog), `useUndoLast(scope)`
and `useUndoShortcut(scope)` for the header Undo button and Ctrl+Z, `useNotifySaved()` for
the 10-second Undo toast after a save, `<HistoryList>` for a record's History section and
`<HistoryDrawer>` for a page's History button.
