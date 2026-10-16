// Right side of the Rate Manager (§13.12): table header with its trunks and last import,
// summary cards, view tabs (Current, Scheduled, Closed, Change log) and the rate grid. Sell
// rates edit in place; selected rows get the bulk bar (set rate, change by % or margin,
// effective date, block, close); "Save n changes" sends one batch = one undoable change.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation } from "react-router";
import type { NoticeBreach, RateLineRow, RateTableDetail } from "@sms/contract";
import { ApiError } from "../../api/client";
import { useListFields } from "../../api/hooks";
import { rateExportUrl, useChangeRateLines, useRateTable } from "../../api/records";
import { DataGrid, type ColumnOverride } from "../../grid/DataGrid";
import { emptyState, type GridState } from "../../grid/filterModel";
import { HistoryList, useNotifySaved } from "../../history/undo";
import { useDeleteRecord, ArchivedBanner } from "../../records/parts";
import { usePageStatus, useTabDirty, useTabNavigate, useTabTitle } from "../../shell/tabContext";
import { ask, confirmDialog, toast } from "../../ui/feedback";
import { Icon } from "../../ui/Icon";
import { Button, Menu, Modal, Popover } from "../../ui/primitives";
import { AddRatesDialog, RenameTableDialog } from "./dialogs";
import { formatMoney, formatPct, formatRate, formatSigned, shortDate, shortDateTime } from "./format";
import { buildItems, changeRate, merge, round6, type ChangeMode, type Pending } from "./pending";
import { useOpenTable } from "./RateManagerPage";

type View = "current" | "scheduled" | "closed" | "log";
const VIEWS: View[] = ["current", "scheduled", "closed", "log"];

function useView(): [View, (v: View) => void] {
  const location = useLocation();
  const navigate = useTabNavigate();
  const raw = new URLSearchParams(location.search).get("view") as View | null;
  const view = raw && VIEWS.includes(raw) ? raw : "current";
  const set = (v: View) => {
    const p = new URLSearchParams(location.search);
    if (v === "current") p.delete("view");
    else p.set("view", v);
    navigate(`${location.pathname}?${p.toString()}`, { replace: true });
  };
  return [view, set];
}

function Card({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: ReactNode;
  sub: ReactNode;
  tone?: string | undefined;
}) {
  return (
    <div className="stat-card">
      <span className="stat-label">{label}</span>
      <span className={`stat-value num${tone ? ` tone-${tone}` : ""}`}>{value}</span>
      <span className="muted small">{sub}</span>
    </div>
  );
}

function Summary({ t }: { t: RateTableDetail }) {
  const s = t.summary;
  const customer = t.kind === "customer";
  return (
    <div className="stat-cards">
      <Card
        label="Active rates"
        value={s.activeRates.toLocaleString("en-US")}
        sub={`across ${s.countries} countries`}
      />
      <Card
        label="Scheduled changes"
        value={s.scheduledChanges.toLocaleString("en-US")}
        tone={s.scheduledIncreases > 0 ? "warning" : undefined}
        sub={s.nextChangeAt ? `next ${shortDate(s.nextChangeAt)} · ${s.scheduledIncreases} increases` : "none planned"}
      />
      {customer ? (
        <Card
          label="Negative margin"
          value={s.negativeMarginLines ?? "—"}
          tone={s.negativeMarginLines ? "error" : undefined}
          sub="sell below best buy today"
        />
      ) : (
        <Card label="Closed lines" value={s.closedLines.toLocaleString("en-US")} sub="kept in the rate history" />
      )}
      <Card
        label="Avg margin"
        value={formatPct(s.avgMarginPct)}
        tone={s.avgMarginPct === null ? undefined : s.avgMarginPct < 0 ? "error" : "good"}
        sub="weighted by today's volume"
      />
      <Card
        label={customer ? "Revenue today" : "Cost today"}
        value={formatMoney(s.moneyToday, t.currency)}
        sub={s.messagesToday === null ? "EDR store unavailable" : `${s.messagesToday.toLocaleString("en-US")} messages`}
      />
    </div>
  );
}

/** Small popover form in the bulk bar. */
function BarAction({
  label,
  disabled,
  children,
}: {
  label: string;
  disabled?: boolean;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={ref}
        type="button"
        className="btn btn-sm bar-btn"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        {label}
      </button>
      <Popover anchor={ref} open={open} onClose={() => setOpen(false)} className="bar-pop">
        {children(() => setOpen(false))}
      </Popover>
    </>
  );
}

function SetRateForm({ onApply }: { onApply: (v: number) => void }) {
  const [v, setV] = useState("");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (v !== "" && Number(v) >= 0) onApply(round6(Number(v)));
      }}
    >
      <label className="field">
        <span>New sell rate</span>
        <input autoFocus type="number" min={0} step="0.0001" value={v} onChange={(e) => setV(e.target.value)} />
      </label>
      <Button small type="submit">
        Apply to selection
      </Button>
    </form>
  );
}

function ChangeByForm({ onApply, customer }: { onApply: (m: ChangeMode, v: number) => void; customer: boolean }) {
  const [mode, setMode] = useState<ChangeMode>("percent");
  const [v, setV] = useState("");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (v !== "" && Number.isFinite(Number(v))) onApply(mode, Number(v));
      }}
    >
      <div className="segmented small-seg">
        {(["percent", "amount", ...(customer ? ["margin"] : [])] as ChangeMode[]).map((m) => (
          <button key={m} type="button" className={mode === m ? "on" : ""} onClick={() => setMode(m)}>
            {m === "percent" ? "By %" : m === "amount" ? "By amount" : "Best buy + margin"}
          </button>
        ))}
      </div>
      <label className="field">
        <span>
          {mode === "percent" ? "Change %" : mode === "amount" ? "Add (negative to lower)" : "Margin over best buy"}
        </span>
        <input autoFocus type="number" step="any" value={v} onChange={(e) => setV(e.target.value)} />
      </label>
      <Button small type="submit">
        Apply to selection
      </Button>
    </form>
  );
}

function DateForm({ value, onApply }: { value: string | null; onApply: (iso: string | null) => void }) {
  const [v, setV] = useState(value ? value.slice(0, 16) : "");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onApply(v ? new Date(`${v}:00Z`).toISOString() : null);
      }}
    >
      <label className="field">
        <span>Effective from (UTC) for this batch</span>
        <input
          autoFocus
          type="datetime-local"
          value={v}
          min={new Date().toISOString().slice(0, 16)}
          onChange={(e) => setV(e.target.value)}
        />
      </label>
      <p className="muted small">Empty = now. Rates never start in the past (traffic already sent keeps its rate).</p>
      <Button small type="submit">
        Set date
      </Button>
    </form>
  );
}

function NoticeDialog({ breach, done }: { breach: NoticeBreach; done: (ok: boolean | null) => void }) {
  return (
    <Modal
      title="Increases sooner than the client's notice"
      width={600}
      onClose={() => done(null)}
      footer={
        <>
          <Button onClick={() => done(null)}>Cancel</Button>
          <Button variant="danger" onClick={() => done(true)}>
            Apply anyway
          </Button>
        </>
      }
    >
      <p>{breach.detail}</p>
      <table className="rtable">
        <thead>
          <tr>
            <th>MCCMNC</th>
            <th className="num">Now</th>
            <th className="num">New</th>
            <th>From</th>
            <th>Earliest with notice</th>
          </tr>
        </thead>
        <tbody>
          {breach.breaches.slice(0, 12).map((b) => (
            <tr key={`${b.mccmnc}-${b.effectiveFrom}`}>
              <td className="num">{b.mccmnc}</td>
              <td className="num">{formatRate(b.currentRate)}</td>
              <td className="num">{formatRate(b.newRate)}</td>
              <td>{shortDateTime(b.effectiveFrom)}</td>
              <td>{shortDate(b.earliestAllowed)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {breach.breaches.length > 12 && <p className="muted small">and {breach.breaches.length - 12} more.</p>}
      <p className="muted small">
        Or set the effective date to the earliest date with notice from the bulk bar. Applying anyway is logged with the
        change (§13.14).
      </p>
    </Modal>
  );
}

function MoreMenu({ t, onRename }: { t: RateTableDetail; onRename: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const deleteRecord = useDeleteRecord();
  const openTable = useOpenTable();
  return (
    <>
      <button
        ref={ref}
        type="button"
        className="btn btn-ghost"
        aria-label="More actions"
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="more" size={15} />
      </button>
      <Popover anchor={ref} open={open} onClose={() => setOpen(false)} align="end">
        <Menu
          onClose={() => setOpen(false)}
          items={[
            { label: "Rename…", icon: "tag", disabled: !!t.archived, onSelect: onRename },
            {
              label: "Delete table…",
              icon: "trash",
              danger: true,
              disabled: t.kind === "vendor" || !!t.archived,
              onSelect: async () => {
                const r = await deleteRecord("rate_table", t.id, t.name);
                if (r) openTable(null);
              },
            },
          ]}
        />
      </Popover>
    </>
  );
}

export function RateTableView({ id }: { id: number }) {
  const q = useRateTable(id);
  const t = q.data;
  const [view, setView] = useView();
  const fields = useListFields("rate_lines");
  const openTable = useOpenTable();
  const navigate = useTabNavigate();
  const notifySaved = useNotifySaved();
  const change = useChangeRateLines(id);
  const [grid, setGrid] = useState<GridState>(emptyState);
  const [pending, setPending] = useState<Pending>(new Map());
  const [effectiveFrom, setEffectiveFrom] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [active, setActive] = useState<RateLineRow | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [dialog, setDialog] = useState<"add" | "rename" | null>(null);
  const rowsById = useRef(new Map<number, RateLineRow>());
  const onRows = useCallback((rows: RateLineRow[]) => {
    for (const r of rows) rowsById.current.set(r.id, r);
  }, []);
  const editable = !!t && !t.archived && view !== "closed";

  useTabTitle(t ? `Rates · ${t.name}` : undefined);
  useTabDirty(pending.size > 0);
  usePageStatus({
    rows: t
      ? `${t.name} · ${t.summary.activeRates.toLocaleString("en-US")} active rates${pending.size ? ` · ${pending.size} unsaved` : ""}`
      : "",
    shortcuts: "Click a sell rate to edit · Space select · Enter keeps the edit · Esc cancels",
  });
  // A new view or filter shows other rows: the selection follows what is visible.
  useEffect(() => setSelected(new Set()), [view, grid.columns, grid.search]);

  const gridState: GridState = useMemo(
    () => ({
      ...grid,
      columns: {
        ...grid.columns,
        rateTableId: { field: "rateTableId", op: "eq", value: id },
        view: { field: "view", op: "eq", value: view === "log" ? "current" : view },
      },
      visible:
        grid.visible ??
        (t?.kind === "vendor"
          ? ["country", "network", "mccmnc", "senderId", "rate", "changeType", "validFrom"]
          : [
              "country",
              "network",
              "mccmnc",
              "senderId",
              "rate",
              "bestBuy",
              "bestVendor",
              "margin",
              "marginPct",
              "changeType",
              "validFrom",
            ]),
    }),
    [grid, id, view, t?.kind],
  );

  const commitEdit = (row: RateLineRow, text: string) => {
    setEditing(null);
    const v = Number(text);
    if (text.trim() === "" || !Number.isFinite(v) || v < 0) return;
    setPending((p) => merge(p, [row.id], { rate: round6(v) }));
  };

  const columns = useMemo<Partial<Record<string, ColumnOverride<RateLineRow>>>>(
    () => ({
      country: { width: 150 },
      network: { width: 170 },
      mccmnc: { width: 90, render: (r) => <span className="muted num">{r.mccmnc}</span> },
      senderId: { width: 100 },
      rate: {
        width: 110,
        render: (r) => {
          const p = pending.get(r.id);
          if (editing === r.id)
            return (
              <input
                className="cell-input num"
                autoFocus
                defaultValue={String(p?.rate ?? r.rate)}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter") commitEdit(r, (e.target as HTMLInputElement).value);
                  if (e.key === "Escape") setEditing(null);
                }}
                onBlur={(e) => commitEdit(r, e.target.value)}
                aria-label={`Sell rate for ${r.country} ${r.network}`}
              />
            );
          const changed = p?.rate !== undefined && p.rate !== r.rate;
          return (
            <button
              type="button"
              className={`cell-edit num${changed ? " changed" : ""}${p?.close ? " closing" : ""}`}
              disabled={!editable}
              title={editable ? "Click to edit" : undefined}
              onClick={(e) => {
                e.stopPropagation();
                if (editable) setEditing(r.id);
              }}
            >
              {formatRate(changed ? p!.rate : r.rate)}
              {r.isBlocked || p?.blocked ? <Icon name="lock" size={12} /> : null}
            </button>
          );
        },
      },
      bestBuy: { render: (r) => formatRate(r.bestBuy) },
      bestVendor: { width: 140 },
      margin: {
        render: (r) => {
          const p = pending.get(r.id)?.rate;
          const m = p !== undefined && r.bestBuy !== null ? round6(p - r.bestBuy) : r.margin;
          return <span className={m === null ? "muted" : m < 0 ? "tone-error" : "tone-good"}>{formatSigned(m)}</span>;
        },
      },
      marginPct: {
        render: (r) => {
          const p = pending.get(r.id)?.rate;
          const pct = p !== undefined && r.bestBuy !== null && p > 0 ? ((p - r.bestBuy) / p) * 100 : r.marginPct;
          return <span className={pct !== null && pct < 0 ? "tone-error" : ""}>{formatPct(pct)}</span>;
        },
      },
      changeType: {
        width: 100,
        render: (r) =>
          r.changeType === "increase" || r.changeType === "decrease" ? (
            <span className="tag num">
              {r.changeType === "increase" ? "↑" : "↓"} {formatPct(r.changePct, true)}
            </span>
          ) : (
            <span className={`tag${r.changeType === "new" ? " tag-accent" : ""}`}>{r.changeType.toUpperCase()}</span>
          ),
      },
      validFrom: {
        width: 170,
        render: (r) =>
          r.nextRate !== null && view === "current" ? (
            <span className="next-rate">
              → {formatRate(r.nextRate)} from {shortDate(r.nextFrom)}
            </span>
          ) : view === "closed" ? (
            <span className="muted">
              {shortDate(r.validFrom)} – {shortDate(r.validTo)}
            </span>
          ) : (
            <span className="muted">{shortDate(r.validFrom)}</span>
          ),
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pending, editing, editable, view],
  );

  const applyToSelection = (fn: (r: RateLineRow) => number | null) => {
    let skipped = 0;
    let next = new Map(pending);
    for (const lineId of selected) {
      const row = rowsById.current.get(lineId);
      const v = row ? fn(row) : null;
      if (v === null) skipped++;
      else next = merge(next, [lineId], { rate: v });
    }
    setPending(next);
    if (skipped)
      toast({
        tone: "warning",
        message: `${skipped} line${skipped === 1 ? "" : "s"} skipped (no best buy or below zero)`,
      });
  };

  const save = async (acceptNoticeBreach = false): Promise<void> => {
    const items = buildItems(pending, rowsById.current, effectiveFrom);
    if (!items.length) {
      setPending(new Map());
      return;
    }
    try {
      const r = await change.mutateAsync({ items, ...(acceptNoticeBreach ? { acceptNoticeBreach: true } : {}) });
      setPending(new Map());
      setSelected(new Set());
      setEffectiveFrom(null);
      if (r.change) notifySaved(r.change, `Saved ${r.applied} change${r.applied === 1 ? "" : "s"}`);
      else toast({ tone: "info", message: "Nothing changed" });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        const ok = await ask<boolean>((done) => (
          <NoticeDialog breach={err.problem as unknown as NoticeBreach} done={done} />
        ));
        if (ok) return save(true);
        return;
      }
      toast({ tone: "error", message: err instanceof ApiError ? err.message : String(err) });
    }
  };

  if (q.isError)
    return (
      <section className="rate-detail">
        <div className="grid-message error">
          <Icon name="alert" /> {(q.error as Error).message}
          <Button small onClick={() => openTable(null)}>
            Back to the list
          </Button>
        </div>
      </section>
    );
  if (!t || !fields.data)
    return (
      <section className="rate-detail">
        <div className="grid-message muted">Loading…</div>
      </section>
    );

  const kindLabel = t.kind === "customer" ? "Customer rate table" : "Vendor rate table";
  const counts = {
    current: t.summary.activeRates,
    scheduled: t.summary.scheduledChanges,
    closed: t.summary.closedLines,
  };
  const changeFilter = grid.columns.changeType?.values?.[0] as string | undefined;
  const senderFilter = grid.columns.senderId ? (grid.columns.senderId.op === "empty" ? "none" : "with") : "any";
  const setColumn = (field: string, cond: GridState["columns"][string] | null) => {
    const columns = { ...grid.columns };
    if (cond) columns[field] = cond;
    else delete columns[field];
    setGrid({ ...grid, columns });
  };
  const selectedRows = [...selected];

  return (
    <section className="rate-detail" aria-label={t.name}>
      <div className="page-header">
        <div className="rate-title">
          <h1>{t.name}</h1>
          <div className="muted small" title={t.trunks.map((x) => x.name).join(", ")}>
            {kindLabel} · {t.currency} · {t.category} ·{" "}
            {t.trunks.length ? (
              <>
                used by{" "}
                {t.trunks.slice(0, 4).map((tr, i) => (
                  <span key={tr.id}>
                    {i > 0 && ", "}
                    <button
                      type="button"
                      className="link"
                      onClick={() => navigate(`/enterprises/${tr.kind}-trunks/${tr.id}`, { newTab: true })}
                    >
                      {tr.name}
                    </button>
                  </span>
                ))}
                {t.trunks.length > 4 && ` +${t.trunks.length - 4}`}
              </>
            ) : (
              "not used by any trunk"
            )}
            {t.lastImport &&
              ` · last import ${shortDateTime(t.lastImport.at)}${t.lastImport.by ? ` by ${t.lastImport.by}` : ""}`}
          </div>
        </div>
        <div className="page-actions">
          <Button icon="upload" disabled title="Rate import arrives with the import wizard (§12.1, §13.22)">
            Import
          </Button>
          <a className="btn" href={rateExportUrl(t.id, view === "log" ? "current" : view)} download>
            <Icon name="download" size={15} /> Export
          </a>
          <Button icon="send" disabled title="Sending rate sheets arrives with rate notices (§13.13)">
            Send to client
          </Button>
          <Button icon="history" onClick={() => setView("log")}>
            History
          </Button>
          <MoreMenu t={t} onRename={() => setDialog("rename")} />
          <Button
            variant={pending.size ? "default" : "primary"}
            icon="plus"
            disabled={!!t.archived}
            onClick={() => setDialog("add")}
          >
            Add rates
          </Button>
          <button
            type="button"
            className="icon-btn"
            aria-label="Close the table"
            title="Back to the full list"
            onClick={() => openTable(null)}
          >
            <Icon name="x" />
          </button>
        </div>
      </div>
      <ArchivedBanner kind="rate_table" id={t.id} archived={t.archived} what="rate table" />
      <Summary t={t} />
      <div className="rate-grid-card">
        <div className="filter-row rate-toolbar">
          <div className="segmented" role="tablist">
            {VIEWS.map((v) => (
              <button
                key={v}
                type="button"
                role="tab"
                aria-selected={view === v}
                className={view === v ? "on" : ""}
                onClick={() => setView(v)}
              >
                {v === "log" ? "Change log" : v[0]!.toUpperCase() + v.slice(1)}
                {v !== "log" && <span className="num seg-count">{counts[v].toLocaleString("en-US")}</span>}
              </button>
            ))}
          </div>
          {view !== "log" && (
            <>
              <label className="toggle-inline">
                Change
                <select
                  value={changeFilter ?? ""}
                  onChange={(e) =>
                    setColumn(
                      "changeType",
                      e.target.value ? { field: "changeType", op: "in", values: [e.target.value] } : null,
                    )
                  }
                >
                  <option value="">All</option>
                  <option value="new">New</option>
                  <option value="increase">Increase</option>
                  <option value="decrease">Decrease</option>
                  <option value="same">Same</option>
                </select>
              </label>
              <label className="toggle-inline">
                Sender ID
                <select
                  value={senderFilter}
                  onChange={(e) =>
                    setColumn(
                      "senderId",
                      e.target.value === "any"
                        ? null
                        : { field: "senderId", op: e.target.value === "none" ? "empty" : "not_empty" },
                    )
                  }
                >
                  <option value="any">Any</option>
                  <option value="with">With sender ID</option>
                  <option value="none">Without</option>
                </select>
              </label>
              {t.kind === "customer" && (
                <label className={`toggle-inline${grid.columns.negativeMargin ? " tone-error" : ""}`}>
                  <input
                    type="checkbox"
                    checked={!!grid.columns.negativeMargin}
                    onChange={(e) =>
                      setColumn(
                        "negativeMargin",
                        e.target.checked ? { field: "negativeMargin", op: "eq", value: true } : null,
                      )
                    }
                  />
                  Negative margin only
                </label>
              )}
              <span className="fb-spacer" />
              <div className="quick-search">
                <Icon name="search" size={13} />
                <input
                  placeholder="Search MCCMNC, network…"
                  aria-label="Search rates"
                  defaultValue={grid.search}
                  onKeyDown={(e) =>
                    e.key === "Enter" && setGrid({ ...grid, search: (e.target as HTMLInputElement).value })
                  }
                  onBlur={(e) => e.target.value !== grid.search && setGrid({ ...grid, search: e.target.value })}
                />
              </div>
            </>
          )}
        </div>
        {view === "log" ? (
          <div className="rate-log">
            <HistoryList scope={{ entityTypes: ["rate_table"], entityId: t.id }} />
          </div>
        ) : (
          <DataGrid<RateLineRow>
            list="rate_lines"
            fields={fields.data}
            state={gridState}
            onStateChange={(s) => setGrid({ ...s, visible: s.visible })}
            columns={columns}
            activeId={active?.id ?? null}
            onActiveChange={setActive}
            selected={selected}
            onSelectedChange={setSelected}
            onRows={onRows}
            rowClass={(r) => {
              const p = pending.get(r.id)?.rate;
              const negative =
                p !== undefined && r.bestBuy !== null ? p < r.bestBuy : r.margin !== null && r.margin < 0;
              return negative ? "negative" : undefined;
            }}
          />
        )}
        {(selected.size > 0 || pending.size > 0) && view !== "log" && (
          <div className="bulk-bar" role="toolbar" aria-label="Bulk actions">
            <strong>{selected.size} selected</strong>
            <BarAction label="Set rate" disabled={!selected.size || !editable}>
              {(close) => (
                <SetRateForm
                  onApply={(v) => {
                    applyToSelection(() => v);
                    close();
                  }}
                />
              )}
            </BarAction>
            <BarAction label="Change by % / margin" disabled={!selected.size || !editable}>
              {(close) => (
                <ChangeByForm
                  customer={t.kind === "customer"}
                  onApply={(mode, v) => {
                    applyToSelection((r) =>
                      changeRate({ rate: pending.get(r.id)?.rate ?? r.rate, bestBuy: r.bestBuy }, mode, v),
                    );
                    close();
                  }}
                />
              )}
            </BarAction>
            <BarAction
              label={effectiveFrom ? `From ${shortDateTime(effectiveFrom)}` : "Effective date…"}
              disabled={!editable}
            >
              {(close) => (
                <DateForm
                  value={effectiveFrom}
                  onApply={(v) => {
                    setEffectiveFrom(v);
                    close();
                  }}
                />
              )}
            </BarAction>
            <button
              type="button"
              className="btn btn-sm bar-btn"
              disabled={!selected.size || !editable}
              onClick={() => {
                const all = selectedRows.every((id) => pending.get(id)?.blocked ?? rowsById.current.get(id)?.isBlocked);
                setPending(merge(pending, selectedRows, { blocked: !all }));
              }}
            >
              Block
            </button>
            <button
              type="button"
              className="btn btn-sm bar-btn"
              disabled={!selected.size || !editable}
              onClick={async () => {
                if (
                  await confirmDialog({
                    title: `Close ${selected.size} rate${selected.size === 1 ? "" : "s"}?`,
                    message: `The lines end ${effectiveFrom ? `on ${shortDateTime(effectiveFrom)}` : "now"} and move to Closed; scheduled ones are withdrawn. Saved with the other changes.`,
                    ok: "Close rates",
                    danger: true,
                  })
                )
                  setPending(merge(pending, selectedRows, { close: true }));
              }}
            >
              Close rate
            </button>
            <span className="fb-spacer" />
            {pending.size > 0 && (
              <>
                <span className="bar-note small">
                  {pending.size} unsaved{effectiveFrom ? ` · from ${shortDateTime(effectiveFrom)}` : ""}
                </span>
                <button type="button" className="btn btn-sm btn-ghost bar-btn" onClick={() => setPending(new Map())}>
                  Discard
                </button>
                <Button small variant="primary" disabled={change.isPending} onClick={() => void save()}>
                  Save {pending.size} change{pending.size === 1 ? "" : "s"}
                </Button>
              </>
            )}
          </div>
        )}
      </div>
      {dialog === "add" && <AddRatesDialog table={t} done={() => setDialog(null)} />}
      {dialog === "rename" && <RenameTableDialog table={t} done={() => setDialog(null)} />}
    </section>
  );
}
