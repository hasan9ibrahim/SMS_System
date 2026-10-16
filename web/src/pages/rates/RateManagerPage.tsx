// Rate Manager (§13.12): all rate tables in one workspace. The list fills the page; opening
// a table (its name or details icon) shrinks the list into a left panel and shows the
// table's rates on the right, in the same tab. The open table lives in the tab URL
// (?table=ID), so links from trunks, rules and alerts open it directly.
import { useLocation } from "react-router";
import type { RateTableRow } from "@sms/contract";
import { useReference } from "../../api/records";
import { formatMoney, formatPct } from "./format";
import { pageForPath } from "../../nav/registry";
import { ListScreen } from "../../page/ListScreen";
import { useTabNavigate } from "../../shell/tabContext";
import { ask } from "../../ui/feedback";
import { Icon } from "../../ui/Icon";
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

function AmFilter({ value, onChange }: { value: number | null; onChange: (id: number | null) => void }) {
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

function FullList() {
  const open = useOpenTable();
  const names = (list: string[], more: number) =>
    list.length ? (
      <span title={list.join(", ")}>
        {list.slice(0, 2).join(", ")}
        {more > 2 ? <span className="muted"> +{more - 2}</span> : null}
      </span>
    ) : (
      <span className="muted">—</span>
    );
  return (
    <ListScreen<RateTableRow>
      list="rate_tables"
      page={page}
      historyScope={{ entityTypes: ["rate_table"] }}
      primary={{ label: "New rate table", onClick: () => void newRateTable((id) => open(id)) }}
      toolbar={(state, setState) => {
        const c = state.columns.accountManagerId;
        return (
          <AmFilter
            value={c ? Number(c.value) : null}
            onChange={(id) => {
              const columns = { ...state.columns };
              if (id === null) delete columns.accountManagerId;
              else columns.accountManagerId = { field: "accountManagerId", op: "eq", value: id };
              setState({ ...state, columns });
            }}
          />
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
        enterpriseNames: { width: 200, render: (r) => names(r.enterpriseNames, r.enterpriseNames.length) },
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
