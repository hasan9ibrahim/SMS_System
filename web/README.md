# web: the GUI

React + TypeScript + Vite. The GUI talks to the backend only through `contract/` (CLAUDE.md
rule 2): REST through the generated types (`src/api/`), live data over the Phoenix-protocol
socket (`src/live/`).

```bash
npm run dev:mock     # repo root, after npm run db:up && npm run seed:small
npm run dev:web      # http://localhost:5173
npm test -w web      # filter model, tab rules, saved views
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
the 10-second Undo toast after a save, and `<HistoryDrawer>` for a record's History tab.
