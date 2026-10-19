// Rate Manager (§13.12): all rate tables in one workspace. The list fills the page; opening
// a table (its name or details icon) shrinks the list into a left panel and shows the
// table's rates on the right, in the same tab. The open table lives in the tab URL
// (?table=ID), so links from trunks, rules and alerts open it directly.
import { HoverList } from "../../ui/HoverList";
import { useLocation } from "react-router";
import type { RateTableRow } from "@sms/contract";
import type { GridState } from "../../grid/filterModel";
import { useMe } from "../../api/hooks";
import { useReference, useRestore } from "../../api/records";
import { useNotifySaved } from "../../history/undo";
import { formatMoney, formatPct } from "./format";
import { pageForPath } from "../../nav/registry";
import { ListScreen } from "../../page/ListScreen";
import { useTabNavigate } from "../../shell/tabContext";
import { isAdminUser, useDeleteRecord } from "../../records/parts";
import { ask, toast } from "../../ui/feedback";
import { problemText } from "../routing/dialogs";
import { Icon } from "../../ui/Icon";
import { scopeUrl } from "./bulkModel";
import { NewRateTableDialog } from "./dialogs";
import { RateTablePanel } from "./RateTablePanel";
import { RateTableView } from "./RateTableView";

const page = pageForPath("/rates/manager")!;

/** Opens a table in this tab (or a new one), keeping the list's filters in the URL. */
export function useOpenTable() {
  const location = useLocation();
  const navigate = useTabNavigate();
  return (id: number | null, opts: { newTab?: boolean; name?: string } = {}) => {
    if (opts.newTab && id !== null) {
      navigate(`/rates/manager?table=${id}`, { forceNew: true, title: `Rates · ${opts.name ?? id}` });
      return;
    }
    const p = new URLSearchParams(location.search);
    if (id === null) {
      p.delete("table");
      p.delete("view");
    } else p.set("table", String(id));
    const qs = p.toString();
    navigate(`/rates/manager${qs ? `?${qs}` : ""}`, { replace: true });
  };
}

export async function newRateTable(open: (id: number) => void) {
  const created = await ask<number>((done) => <NewRateTableDialog done={done} />);
  if (created) open(created);
}

export function AmFilter({ value, onChange }: { value: number | null; onChange: (id: number | null) => void }) {
  const ref = useReference();
  return (
    <label className="toggle-inline">
      Account manager
      <select
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}
        aria-label="Account manager"
      >
        <option value="">All</option>
        {ref.data?.accountManagers.map((u) => (
          <option key={u.id} value={u.id}>
            {u.displayName}
          </option>
        ))}
      </select>
    </label>
  );
}

type Kind = "customer" | "vendor";
// No "All": the switch is Customer or Vendor (team trial round 1).
const KINDS: { value: Kind; label: string }[] = [
  { value: "customer", label: "Customer" },
  { value: "vendor", label: "Vendor" },
];

/**
 * Customer (sell) tables by default; vendor tables are also shown in each vendor trunk (team trial
 * round 1). The switch sets the Type column filter, so it travels in the URL like any filter.
 */
function KindSwitch({ state, setState }: { state: GridState; setState: (s: GridState) => void }) {
  const c = state.columns.kind;
  const list = c?.values ?? (c?.value !== undefined ? [c.value] : []);
  // Neither is lit when the Type filter was cleared or set to both from the filter bar.
  const kind: Kind | null = list.length === 1 ? (list[0] as Kind) : null;
  return (
    <div className="segmented" role="group" aria-label="Rate table type">
      {KINDS.map((k) => (
        <button
          key={k.value}
          type="button"
          className={kind === k.value ? "on" : ""}
          aria-pressed={kind === k.value}
          onClick={() => {
            setState({ ...state, columns: { ...state.columns, kind: { field: "kind", op: "in", values: [k.value] } } });
          }}
        >
          {k.label}
        </button>
      ))}
    </div>
  );
}

function FullList() {
  const open = useOpenTable();
  const navigate = useTabNavigate();
  const deleteOne = useDeleteRecord();
  const { data: me } = useMe();
  const restore = useRestore("rate_table");
  const notifySaved = useNotifySaved();
  const isAdmin = isAdminUser(me?.permissions);
  // The first two names in bold, then "+N"; pointing at the cell lists them all (team trial round 1).
  const names = (list: string[], total: number) =>
    list.length ? (
      <HoverList items={list} more={Math.max(0, total - list.length)}>
        <span className="rr-strong rr-label">
          <span className="rr-main">{list.slice(0, 2).join(", ")}</span>
          {total > 2 ? <span className="muted">+{total - 2}</span> : null}
        </span>
      </HoverList>
    ) : (
      <span className="muted">—</span>
    );
  return (
    <ListScreen<RateTableRow>
      list="rate_tables"
      page={page}
      historyScope={{ entityTypes: ["rate_table"] }}
      rowActions={(r) => [
        // Editing the rates opens the table beside the list (§13.12).
        { label: "Edit", icon: "file", main: true, onSelect: () => open(r.id, { name: r.name }) },
        {
          label: "Edit in new tab",
          icon: "external",
          onSelect: () => open(r.id, { newTab: true, name: r.name }),
        },
        {
          label: "Bulk rating…",
          icon: "layers",
          disabled: r.kind !== "customer" || r.archived,
          hint: r.archived ? "Deleted table" : r.kind !== "customer" ? "Customer tables only" : undefined,
          onSelect: () => navigate(scopeUrl({ tables: [r.id] }), { newTab: true, title: "Bulk rating" }),
        },
        "separator",
        r.archived
          ? {
              label: "Restore",
              icon: "undo",
              disabled: !isAdmin || restore.isPending,
              hint: isAdmin ? undefined : "Deleted. An administrator can restore it.",
              onSelect: () =>
                restore.mutate(r.id, {
                  onSuccess: (res) => res.change && notifySaved(res.change, `Restored ${r.name}`),
                  onError: (e) => toast({ tone: "error", message: problemText(e) }),
                }),
            }
          : {
              label: "Delete",
              icon: "trash",
              danger: true,
              onSelect: () => void deleteOne("rate_table", r.id, r.name),
            },
      ]}
      // Several clients' tables at once open the bulk rating workspace (§13.11, §13.12).
      selection={{
        summary: (_rows, ids) => `${ids.size} table${ids.size === 1 ? "" : "s"} selected`,
        bulk: (ids, clear) => [
          {
            label: `Bulk rating (${ids.length} table${ids.length === 1 ? "" : "s"})…`,
            icon: "layers",
            onSelect: () => {
              navigate(scopeUrl({ tables: ids }), { newTab: true, title: "Bulk rating" });
              clear();
            },
          },
        ],
      }}
      primary={{ label: "New rate table", onClick: () => void newRateTable((id) => open(id)) }}
      initialState={{ columns: { kind: { field: "kind", op: "in", values: ["customer"] } } }}
      toolbar={(state, setState) => {
        const c = state.columns.accountManagerId;
        return (
          <>
            <KindSwitch state={state} setState={setState} />
            <AmFilter
              value={c ? Number(c.value) : null}
              onChange={(id) => {
                const columns = { ...state.columns };
                if (id === null) delete columns.accountManagerId;
                else columns.accountManagerId = { field: "accountManagerId", op: "eq", value: id };
                setState({ ...state, columns });
              }}
            />
          </>
        );
      }}
      columns={{
        name: {
          width: 240,
          render: (r) => (
            <button
              type="button"
              className="link strong"
              onClick={(e) => {
                e.stopPropagation();
                open(r.id, { newTab: e.ctrlKey || e.metaKey, name: r.name });
              }}
            >
              {r.name}
            </button>
          ),
        },
        enterpriseNames: {
          width: 200,
          render: (r) => names(r.enterpriseNames, r.enterpriseCount || r.enterpriseNames.length),
        },
        trunkNames: { width: 200, render: (r) => names(r.trunkNames, r.trunkCount || r.trunkNames.length) },
        scheduledChanges: {
          render: (r) =>
            r.scheduledChanges ? <span className="tag">{r.scheduledChanges.toLocaleString("en-US")}</span> : "0",
        },
        negativeMarginLines: {
          render: (r) =>
            r.negativeMarginLines === null ? (
              <span className="muted">—</span>
            ) : r.negativeMarginLines > 0 ? (
              <span className="tone-error strong">{r.negativeMarginLines}</span>
            ) : (
              "0"
            ),
        },
        avgMarginPct: { render: (r) => formatPct(r.avgMarginPct) },
        moneyToday: { render: (r) => formatMoney(r.moneyToday, r.currency) },
      }}
      trailing={{
        header: "",
        width: 44,
        render: (r) => (
          <button
            type="button"
            className="icon-btn"
            aria-label={`Open ${r.name}`}
            title="Open the table (Ctrl-click: new tab)"
            onClick={(e) => open(r.id, { newTab: e.ctrlKey || e.metaKey, name: r.name })}
          >
            <Icon name="chevronRight" size={14} />
          </button>
        ),
      }}
      onOpen={(row, e) => open(row.id, { newTab: e.ctrlKey || e.metaKey, name: row.name })}
      shortcuts="↑↓ move · Enter open the table · Ctrl-click a name: new tab · Space select for bulk rating"
    />
  );
}

export function RateManagerPage() {
  const location = useLocation();
  const raw = new URLSearchParams(location.search).get("table");
  const tableId = raw && /^\d+$/.test(raw) ? Number(raw) : null;
  if (tableId === null) return <FullList />;
  return (
    <div className="page rate-split">
      <RateTablePanel openId={tableId} />
      <RateTableView key={tableId} id={tableId} />
    </div>
  );
}
