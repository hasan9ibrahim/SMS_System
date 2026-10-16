# web: the GUI

React + TypeScript + Vite. The GUI talks to the backend only through `contract/` (CLAUDE.md
rule 2): REST through the generated types (`src/api/`), live data over the Phoenix-protocol
socket (`src/live/`).

```bash
npm run dev:mock     # repo root, after npm run db:up && npm run seed:small
npm run dev:web      # http://localhost:5173
npm test -w web      # filter model, tab rules, saved views, form helpers
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
