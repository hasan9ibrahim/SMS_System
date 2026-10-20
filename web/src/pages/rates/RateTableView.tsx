// Right side of the Rate Manager (§13.12): table header with its trunks and last import,
// summary cards, view tabs (Current, Scheduled, Closed, Change log) and the rate grid. Sell
// rates edit in place; selected rows get the bulk bar (set rate, change by % or margin,
// effective date, block, close); "Save n changes" sends one batch = one undoable change.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation } from "react-router";
import type { NoticeBreach, RateLineRow, RateTableDetail } from "@sms/contract";
import { ApiError } from "../../api/client";
import { useListFields } from "../../api/hooks";
import { useChangeRateLines, usePlatformCurrency, useRateTable } from "../../api/records";
import { downloadCsv } from "../../api/masterData";
import { DataGrid, type ColumnOverride } from "../../grid/DataGrid";
import { emptyState, toListQuery, type GridState } from "../../grid/filterModel";
import { problemText } from "../routing/dialogs";
import { useNotifySaved } from "../../history/undo";
import { RateChangeLog } from "./RateChangeLog";
import { useDeleteRecord, ArchivedBanner } from "../../records/parts";
import { usePageStatus, useTabDirty, useTabNavigate, useTabTitle } from "../../shell/tabContext";
import { ask, confirmDialog, toast } from "../../ui/feedback";
import { Icon } from "../../ui/Icon";
import { Button, Menu, Modal, Popover } from "../../ui/primitives";
import { scopeUrl } from "./bulkModel";
import { AddRatesDialog, SendRnCheck, RenameTableDialog } from "./dialogs";
import { formatMoney, formatPct, formatRate, formatSigned, shortDate, shortDateTime } from "./format";
import {
  buildItems,
  changeCount,
  changeRate,
  merge,
  round6,
  setRate,
  summarize,
  type ChangeMode,
  type Pending,
} from "./pending";
import { useOpenTable } from "./RateManagerPage";
import { formatZoned, isoToZoned, usePlatformTz } from "../../ui/zonedTime";
import { defaultEffectiveIso, EffectiveFromField, effectiveIso, SaveSummaryDialog } from "./EffectiveFrom";

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
        <Card label="Closed rates" value={s.closedLines.toLocaleString("en-US")} sub="kept in the rate history" />
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

/** One rate for the selection, typed in the table currency or in the platform currency (team trial round 2). */
function SetRateForm({
  onApply,
  currency,
  platformCurrency,
  factor,
}: {
  onApply: (v: number) => void;
  currency: string;
  platformCurrency: string;
  factor: number;
}) {
  const [v, setV] = useState("");
  const [eur, setEur] = useState("");
  const same = currency === platformCurrency;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (v !== "" && Number(v) >= 0) onApply(round6(Number(v)));
      }}
    >
      <label className="field">
        <span>New rate ({currency})</span>
        <input
          autoFocus
          type="number"
          min={0}
          step="0.0001"
          value={v}
          onChange={(e) => {
            setV(e.target.value);
            setEur(e.target.value === "" ? "" : String(round6(Number(e.target.value) * factor)));
          }}
        />
      </label>
      {!same && (
        <label className="field">
          <span>or in {platformCurrency}</span>
          <input
            type="number"
            min={0}
            step="0.0001"
            value={eur}
            onChange={(e) => {
              setEur(e.target.value);
              setV(e.target.value === "" ? "" : String(round6(Number(e.target.value) / factor)));
            }}
          />
        </label>
      )}
      <Button small type="submit">
        Apply to selection
      </Button>
    </form>
  );
}

function ChangeByForm({
  onApply,
  customer,
  currency,
}: {
  onApply: (m: ChangeMode, v: number) => void;
  customer: boolean;
  currency: string;
}) {
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
          {mode === "percent"
            ? "Change %"
            : mode === "amount"
              ? `Add (${currency}, negative to lower)`
              : `Margin over best buy (${currency})`}
        </span>
        <input autoFocus type="number" step="any" value={v} onChange={(e) => setV(e.target.value)} />
      </label>
      <Button small type="submit">
        Apply to selection
      </Button>
    </form>
  );
}

/** The batch's effective date, in the platform time zone (team trial round 2: default next 00:00). */
function DateForm({ value, onApply }: { value: string | null; onApply: (iso: string | null) => void }) {
  const tz = usePlatformTz();
  const [v, setV] = useState(value ? isoToZoned(value, tz) : "");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onApply(effectiveIso(v, tz));
      }}
    >
      <EffectiveFromField label="Effective from for this batch" autoFocus value={v} onChange={setV} />
      <p className="muted small">Rates never start in the past (traffic already sent keeps its rate).</p>
      <Button small type="submit">
        Set date
      </Button>
    </form>
  );
}

export function NoticeDialog({ breach, done }: { breach: NoticeBreach; done: (ok: boolean | null) => void }) {
  const byTable = breach.breaches.some((b) => b.table);
  return (
    <Modal
      title="Changes sooner than the client's notice"
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
            {byTable && <th>Table</th>}
            <th>MCCMNC</th>
            <th>Change</th>
            <th className="num">Now</th>
            <th className="num">New</th>
            <th>From</th>
            <th>Earliest with notice</th>
          </tr>
        </thead>
        <tbody>
          {breach.breaches.slice(0, 12).map((b) => (
            <tr key={`${b.rateTableId ?? ""}-${b.mccmnc}-${b.effectiveFrom}`}>
              {byTable && <td>{b.table}</td>}
              <td className="num">{b.mccmnc}</td>
              <td>
                {b.change === "new" ? "New" : b.change === "decrease" ? "Decrease" : "Increase"} ({b.noticeDays} d)
              </td>
              <td className="num">{b.currentRate === null ? "–" : formatRate(b.currentRate)}</td>
              <td className="num">{formatRate(b.newRate)}</td>
              <td>{shortDateTime(b.effectiveFrom)}</td>
              <td>{shortDate(b.earliestAllowed)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {breach.breaches.length > 12 && <p className="muted small">and {breach.breaches.length - 12} more.</p>}
      <p className="muted small">
        {byTable
          ? 'Or tick "Respect notice periods" and preview again.'
          : "Or set the effective date to the earliest date with notice from the bulk bar."}{" "}
        Applying anyway is logged with the change (§13.14).
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

/** `embedded`: shown inside another record (a vendor trunk's Rates tab), so there is no close button. */
export function RateTableView({ id, embedded = false }: { id: number; embedded?: boolean }) {
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
  const tz = usePlatformTz();
  const platformCurrency = usePlatformCurrency();
  // Chosen batch date (null = now); until one is chosen the batch starts at the next 00:00 (team trial round 2).
  const [chosenFrom, setChosenFrom] = useState<string | null>(null);
  const [fromChosen, setFromChosen] = useState(false);
  const effectiveFrom = fromChosen ? chosenFrom : defaultEffectiveIso(tz);
  const setEffectiveFrom = (v: string | null) => {
    setChosenFrom(v);
    setFromChosen(true);
  };
  const [selected, setSelected] = useState<Set<number>>(new Set());
  // "Send RN" ticked by default on customer tables (team trial round 1).
  const [sendRn, setSendRn] = useState(true);
  const [active, setActive] = useState<RateLineRow | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [editingEur, setEditingEur] = useState(false);
  const [dialog, setDialog] = useState<"add" | "rename" | null>(null);
  const rowsById = useRef(new Map<number, RateLineRow>());
  // What a save would change; the bar, the tab title and the summary all count the same (team trial round 2).
  const changes = changeCount(pending, rowsById.current);
  const onRows = useCallback((rows: RateLineRow[]) => {
    for (const r of rows) rowsById.current.set(r.id, r);
  }, []);
  const editable = !!t && !t.archived && view !== "closed";

  // Inside a vendor trunk the tab keeps the trunk's title.
  useTabTitle(t && !embedded ? `Rates · ${t.name}` : undefined);
  useTabDirty(changes > 0);
  usePageStatus({
    rows: t
      ? `${t.name} · ${t.summary.activeRates.toLocaleString("en-US")} active rates${changes ? ` · ${changes} unsaved` : ""}`
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
          ? ["country", "network", "mccmnc", "senderId", "rate", "sysRate", "changeType", "validFrom"]
          : [
              "country",
              "network",
              "mccmnc",
              "senderId",
              "rate",
              "sysRate",
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

  // The rate in the table currency and in the platform currency (EUR) are both editable; either one sets the
  // other at the latest exchange rate (team trial round 2).
  const factor = t?.platformPerUnit && t.platformPerUnit > 0 ? t.platformPerUnit : 1;
  const commitEdit = (row: RateLineRow, text: string, inPlatform = false) => {
    setEditing(null);
    setEditingEur(false);
    const v = Number(text.replace(",", "."));
    if (text.trim() === "" || !Number.isFinite(v) || v < 0) return;
    // Typing the current rate back (or leaving a cell unchanged) is no change (team trial round 2).
    setPending((p) => setRate(p, row, round6(inPlatform ? v / factor : v)));
  };

  const columns = useMemo<Partial<Record<string, ColumnOverride<RateLineRow>>>>(
    () => ({
      country: { width: 150 },
      network: { width: 170 },
      mccmnc: { width: 90, render: (r) => <span className="muted num">{r.mccmnc}</span> },
      senderId: { width: 100 },
      rate: {
        width: 130,
        label: `${t?.kind === "vendor" ? "Buy" : "Sell"} Rate (${t?.currency ?? ""})`,
        render: (r) => {
          const p = pending.get(r.id);
          if (editing === r.id && !editingEur)
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
                if (editable) {
                  setEditingEur(false);
                  setEditing(r.id);
                }
              }}
            >
              {formatRate(changed ? p!.rate : r.rate)}
              {r.isBlocked || p?.blocked ? <Icon name="lock" size={12} /> : null}
            </button>
          );
        },
      },
      sysRate: {
        width: 120,
        label: `Rate (${platformCurrency})`,
        render: (r) => {
          const p = pending.get(r.id);
          const changed = p?.rate !== undefined && p.rate !== r.rate;
          const value = changed ? round6(p!.rate! * factor) : r.sysRate;
          if (editing === r.id && editingEur)
            return (
              <input
                className="cell-input num"
                autoFocus
                defaultValue={value === null ? "" : String(value)}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter") commitEdit(r, (e.target as HTMLInputElement).value, true);
                  if (e.key === "Escape") {
                    setEditing(null);
                    setEditingEur(false);
                  }
                }}
                onBlur={(e) => commitEdit(r, e.target.value, true)}
                aria-label={`Rate in ${platformCurrency} for ${r.country} ${r.network}`}
              />
            );
          if (t?.currency === platformCurrency) return <span className="num muted">{formatRate(value)}</span>;
          return (
            <button
              type="button"
              className={`cell-edit num${changed ? " changed" : ""}`}
              disabled={!editable}
              title={
                editable
                  ? `Click to edit in ${platformCurrency}; the ${t?.currency} rate follows (1 ${t?.currency} = ${factor.toFixed(6)} ${platformCurrency})`
                  : undefined
              }
              onClick={(e) => {
                e.stopPropagation();
                if (editable) {
                  setEditingEur(true);
                  setEditing(r.id);
                }
              }}
            >
              {formatRate(value)}
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
    [pending, editing, editingEur, editable, view, factor, platformCurrency, t?.currency, t?.kind],
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
        message: `${skipped} rate${skipped === 1 ? "" : "s"} skipped (no best buy or below zero)`,
      });
  };

  /** Customer tables: the summary of the save, with the RN choice and note, comes first (team trial round 2). */
  const confirmSave = async () => {
    if (t?.kind !== "customer") return save();
    const { counts, rows } = summarize(pending, rowsById.current);
    if (!rows.length) return save();
    const v = await ask<{ sendRn: boolean; note: string }>((done) => (
      <SaveSummaryDialog
        table={t.name}
        clients={[...new Set(t.trunks.map((x) => x.enterpriseName))]}
        counts={counts}
        rows={rows}
        effectiveFrom={effectiveFrom}
        scheduledKept={!fromChosen}
        sendRn={sendRn}
        done={done}
      />
    ));
    if (!v) return;
    setSendRn(v.sendRn);
    return save(false, v);
  };

  const save = async (
    acceptNoticeBreach = false,
    rn: { sendRn: boolean; note: string } = { sendRn, note: "" },
  ): Promise<void> => {
    const items = buildItems(pending, rowsById.current, effectiveFrom, Date.now(), fromChosen);
    if (!items.length) {
      setPending(new Map());
      return;
    }
    try {
      const r = await change.mutateAsync({
        items,
        sendNotification: rn.sendRn && t?.kind === "customer",
        ...(rn.note.trim() ? { notificationNote: rn.note.trim() } : {}),
        ...(acceptNoticeBreach ? { acceptNoticeBreach: true } : {}),
      });
      setPending(new Map());
      setSelected(new Set());
      setChosenFrom(null);
      setFromChosen(false);
      if (r.change)
        notifySaved(
          r.change,
          `Saved ${r.applied} change${r.applied === 1 ? "" : "s"}${r.notificationsSent ? ` · RN sent to ${r.notificationsSent} client${r.notificationsSent === 1 ? "" : "s"}` : ""}`,
        );
      else toast({ tone: "info", message: "Nothing changed" });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        const ok = await ask<boolean>((done) => (
          <NoticeDialog breach={err.problem as unknown as NoticeBreach} done={done} />
        ));
        if (ok) return save(true, rn);
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
          {/* Exports the rows the filters show (team trial round 2). */}
          <Button
            icon="download"
            title="Exports the rows as filtered and sorted on screen"
            onClick={() =>
              void downloadCsv(`/rate-tables/${t.id}/export`, toListQuery(gridState)).catch((e) =>
                toast({ tone: "error", message: problemText(e) }),
              )
            }
          >
            Export
          </Button>
          {t.kind === "customer" && (
            <Button icon="send" disabled title="Rate notifications go out on save with Send RN (team trial round 1)">
              Send to client
            </Button>
          )}
          <Button icon="history" onClick={() => setView("log")}>
            History
          </Button>
          <MoreMenu t={t} onRename={() => setDialog("rename")} />
          <Button
            variant={changes ? "default" : "primary"}
            icon="plus"
            disabled={!!t.archived}
            onClick={() => setDialog("add")}
          >
            Add rates
          </Button>
          {embedded ? (
            <Button icon="external" onClick={() => openTable(t.id, { newTab: true, name: t.name })}>
              Rate manager
            </Button>
          ) : (
            <button
              type="button"
              className="icon-btn"
              aria-label="Close the table"
              title="Back to the full list"
              onClick={() => openTable(null)}
            >
              <Icon name="x" />
            </button>
          )}
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
          <RateChangeLog tableId={t.id} />
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
        {(selected.size > 0 || changes > 0) && view !== "log" && (
          <div className="bulk-bar" role="toolbar" aria-label="Bulk actions">
            <strong>{selected.size} selected</strong>
            <BarAction label="Set rate" disabled={!selected.size || !editable}>
              {(close) => (
                <SetRateForm
                  currency={t.currency}
                  platformCurrency={platformCurrency}
                  factor={factor}
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
                  currency={t.currency}
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
              label={
                !fromChosen ? "From next 00:00" : effectiveFrom ? `From ${formatZoned(effectiveFrom, tz)}` : "From now"
              }
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
                    message: `The rates end ${effectiveFrom ? `on ${formatZoned(effectiveFrom, tz)} (${tz})` : "now"} and move to Closed; scheduled ones are withdrawn. Saved with the other changes.`,
                    ok: "Close rates",
                    danger: true,
                  })
                )
                  setPending(merge(pending, selectedRows, { close: true }));
              }}
            >
              Close rate
            </button>
            <button
              type="button"
              className="btn btn-sm bar-btn"
              disabled={!selected.size || t.kind !== "customer"}
              title="Re-price these destinations for this and other clients' tables at once (§13.11)"
              onClick={() =>
                navigate(
                  scopeUrl({
                    tables: [t.id],
                    mccmncs: [...new Set(selectedRows.flatMap((id) => rowsById.current.get(id)?.mccmnc ?? []))],
                  }),
                  { newTab: true, title: "Bulk rating" },
                )
              }
            >
              Bulk rating…
            </button>
            <span className="fb-spacer" />
            {changes > 0 && (
              <>
                <span className="bar-note small">
                  {changes} unsaved · from {effectiveFrom ? formatZoned(effectiveFrom, tz) : "now"}
                </span>
                <button type="button" className="btn btn-sm btn-ghost bar-btn" onClick={() => setPending(new Map())}>
                  Discard
                </button>
                {t.kind === "customer" && <SendRnCheck checked={sendRn} onChange={setSendRn} />}
                <Button small variant="primary" disabled={change.isPending} onClick={() => void confirmSave()}>
                  Save {changes} change{changes === 1 ? "" : "s"}
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
