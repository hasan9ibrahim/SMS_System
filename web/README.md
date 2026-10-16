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
- **MO reference book** (`/rates/mo-book`): add, edit, delete, import, export.

Imports share one dialog (`shared.tsx` `openImport`): choose a CSV, the server checks it (dry run),
the dialog shows the counts, errors by line, rows kept because they are in use, and remarks; Import
is enabled only without errors. "Replace" mode archives what the file leaves out. Templates are
downloadable from the dialog. Every save, delete and import is one undoable change.

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
