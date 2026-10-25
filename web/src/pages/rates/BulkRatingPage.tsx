// Bulk rating workspace (§13.11, rating part): re-price several clients' tables for one or many
// destinations in one job. Step 1 scope (tables × destinations, from the URL when opened from the
// Rate Manager), Step 2 one action (fixed rate, change by % or amount, cost + margin, close, block),
// Step 3 review grid (type over a rate or a formula such as =cost*1.15, exclude rows with one click),
// Step 4 impact on the last 7 days of traffic, Step 5 apply as ONE undoable change (§13.10).
import { useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router";
import { useQuery } from "@tanstack/react-query";
import type {
  MarketMoveDetail,
  NoticeBreach,
  RateBulkAction,
  RateBulkPreview,
  RateBulkScope,
  RateTableRow,
} from "@sms/contract";
import { actOnMove, fetchMarketMove } from "../../api/market";
import { moveLabel } from "./market/marketModel";
import { fetchPickPage } from "../../api/hooks";
import { ApiError } from "../../api/client";
import { previewRateBulk, useApplyRateBulk } from "../../api/records";
import { useNotifySaved } from "../../history/undo";
import { pageForPath } from "../../nav/registry";
import { PageHeader } from "../../page/PageHeader";
import { Icon } from "../../ui/Icon";
import { ListLookup } from "../../records/parts";
import { usePageStatus, useTabNavigate } from "../../shell/tabContext";
import { ask, toast } from "../../ui/feedback";
import { Button, Modal } from "../../ui/primitives";
import { VirtualTable, type VColumn } from "../lookup/VirtualTable";
import {
  applyItems,
  evalCell,
  impact,
  noEdits,
  parseCodes,
  parseScope,
  review,
  scopeUrl,
  visible,
  type Edits,
  type Reviewed,
  type Show,
} from "./bulkModel";
import { formatPct, formatRate, shortDateTime } from "./format";
import { NoticeDialog } from "./RateTableView";
import { SendRnCheck } from "./dialogs";
import { DestinationPickDialog } from "./DestinationTree";
import { todayMidnight, usePlatformTz } from "../../ui/zonedTime";
import { EffectiveFromField, effectiveIso, RnNoteField } from "./EffectiveFrom";

const page = pageForPath("/rates/bulk")!;

const ACTIONS: { value: RateBulkAction["type"]; label: string; valueLabel?: string }[] = [
  { value: "set", label: "Set a fixed rate", valueLabel: "New rate (each table's currency)" },
  { value: "change_pct", label: "Change by %", valueLabel: "Change % (negative lowers)" },
  { value: "change_amount", label: "Change by amount", valueLabel: "Add (table currency, negative lowers)" },
  { value: "cost_plus_pct", label: "Cost + margin %", valueLabel: "Margin % over cost" },
  { value: "cost_plus_amount", label: "Cost + amount", valueLabel: "Amount over cost (table currency)" },
  { value: "close", label: "Close rates" },
  { value: "block", label: "Block rates" },
  { value: "unblock", label: "Unblock rates" },
  { value: "none", label: "Suggested rates only (market move)" },
];
const SHOWS: { value: Show; label: string }[] = [
  { value: "all", label: "All" },
  { value: "changing", label: "Changing" },
  { value: "flagged", label: "Flagged" },
  { value: "excluded", label: "Excluded" },
  { value: "edited", label: "Edited" },
];
const money = (v: number) =>
  `${v > 0 ? "+" : ""}${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const CHANGE_LABEL: Record<string, string> = {
  new: "New",
  increase: "Up",
  decrease: "Down",
  same: "Same",
  close: "Close",
  block: "Block",
  unblock: "Unblock",
  skip: "Skip",
};

/**
 * Clients' rate tables as a searchable checklist (team trial round 4, like the route rule trunk picker): Inclusive =
 * the ticked tables, Exclusive = every client table except the ticked ones. The search also finds a table by its
 * customer trunks and enterprises. `ids` is the resulting scope.
 */
function TableScope({ ids, onChange }: { ids: number[]; onChange: (ids: number[]) => void }) {
  const [mode, setMode] = useState<"inclusive" | "exclusive">("inclusive");
  const [excluded, setExcluded] = useState<number[]>([]);
  const [q, setQ] = useState("");
  const ticked = mode === "inclusive" ? ids : excluded;
  const results = useQuery({
    queryKey: ["list", "bulk-tables", q],
    queryFn: () =>
      fetchPickPage<RateTableRow>("rate_tables", {
        limit: 60,
        withTotal: true,
        ...(q.trim() ? { search: q.trim() } : {}),
        filter: { logic: "and", conditions: [{ field: "kind", op: "in", values: ["customer"] }] },
        sort: [{ field: "name", dir: "asc" }],
      }),
    staleTime: 30_000,
  });
  // Every client table, for Exclusive.
  const all = useQuery({
    queryKey: ["list", "bulk-tables", "all"],
    queryFn: () =>
      fetchPickPage<RateTableRow>("rate_tables", {
        limit: 4000,
        withTotal: false,
        filter: { logic: "and", conditions: [{ field: "kind", op: "in", values: ["customer"] }] },
      }),
    enabled: mode === "exclusive",
    staleTime: 60_000,
  });
  useEffect(() => {
    if (mode === "exclusive" && all.data)
      onChange(all.data.rows.map((r) => r.id).filter((id) => !excluded.includes(id)));
  }, [mode, excluded, all.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const names = useQuery({
    queryKey: ["list", "names", "rate_tables", ticked],
    queryFn: () =>
      fetchPickPage<RateTableRow>("rate_tables", {
        limit: 500,
        withTotal: false,
        filter: { logic: "and", conditions: [{ field: "id", op: "in", values: ticked }] },
      }),
    enabled: ticked.length > 0,
    staleTime: 60_000,
  });
  const byId = new Map(names.data?.rows.map((r) => [r.id, r]));
  const setTicked = (next: number[]) => (mode === "inclusive" ? onChange(next) : setExcluded(next));
  const toggle = (id: number) => setTicked(ticked.includes(id) ? ticked.filter((x) => x !== id) : [...ticked, id]);
  const rows = results.data?.rows ?? [];
  const allShown = rows.length > 0 && rows.every((r) => ticked.includes(r.id));
  return (
    <div className="multi-pick table-scope">
      <div className="table-scope-head">
        <div className="choice-seg" role="radiogroup" aria-label="Clients' rate tables">
          {(["inclusive", "exclusive"] as const).map((m) => (
            <label key={m} className={mode === m ? "on" : ""}>
              <input
                type="radio"
                className="sr-only"
                checked={mode === m}
                onChange={() => {
                  setMode(m);
                  if (m === "inclusive") onChange([]);
                  else setExcluded([]);
                }}
              />
              {m === "inclusive" ? "Inclusive" : "Exclusive"}
            </label>
          ))}
        </div>
        <span className="muted small">
          {mode === "inclusive"
            ? `${ids.length} table${ids.length === 1 ? "" : "s"} chosen`
            : `All client tables except ${excluded.length} · ${ids.length} in scope`}
        </span>
      </div>
      <div className="chips">
        {ticked.map((id) => (
          <span key={id} className="chip" title={byId.get(id)?.enterpriseNames.join(", ")}>
            {byId.get(id)?.name ?? `#${id}`}
            <button type="button" aria-label={`Remove ${byId.get(id)?.name ?? id}`} onClick={() => toggle(id)}>
              <Icon name="x" size={11} />
            </button>
          </span>
        ))}
        {ticked.length === 0 && (
          <span className="muted small">{mode === "inclusive" ? "Nothing chosen yet." : "Nothing excluded."}</span>
        )}
      </div>
      <input
        type="search"
        placeholder="Search tables, customer trunks or enterprises…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        aria-label="Search client rate tables"
      />
      <div className="pick-list">
        {rows.length > 0 && (
          <label className="choice-row select-all">
            <input
              type="checkbox"
              checked={allShown}
              onChange={() =>
                setTicked(
                  allShown
                    ? ticked.filter((id) => !rows.some((r) => r.id === id))
                    : [...new Set([...ticked, ...rows.map((r) => r.id)])],
                )
              }
            />
            <span className="strong">Select all shown</span>
            <span className="muted small">
              {rows.length}
              {results.data?.total && results.data.total > rows.length ? ` of ${results.data.total}` : ""}
            </span>
          </label>
        )}
        {rows.map((r) => (
          <label key={r.id} className="choice-row">
            <input type="checkbox" checked={ticked.includes(r.id)} onChange={() => toggle(r.id)} />
            <span>{r.name}</span>
            <span className="muted small">
              {[r.trunkNames.slice(0, 2).join(", ") || r.enterpriseNames.slice(0, 2).join(", "), r.currency]
                .filter(Boolean)
                .join(" · ")}
            </span>
          </label>
        ))}
        {results.isSuccess && rows.length === 0 && <p className="muted small pad">No matches.</p>}
      </div>
    </div>
  );
}

function PasteDialog({ done }: { done: (v: { mccmncs: string[]; countries: string[] } | null) => void }) {
  const [text, setText] = useState("");
  const parsed = parseCodes(text);
  return (
    <Modal
      title="Paste destinations"
      onClose={() => done(null)}
      footer={
        <>
          <Button onClick={() => done(null)}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!parsed.mccmncs.length && !parsed.countries.length}
            onClick={() => done(parsed)}
          >
            Add {parsed.mccmncs.length + parsed.countries.length}
          </Button>
        </>
      }
    >
      <label className="field">
        <span>MCCMNC codes or country ISO codes, one per line or comma separated (e.g. from Excel)</span>
        <textarea autoFocus rows={8} value={text} onChange={(e) => setText(e.target.value)} />
      </label>
      <p className="muted small">
        {parsed.mccmncs.length} MCCMNC · {parsed.countries.length} countries
        {parsed.invalid.length ? ` · ignored: ${parsed.invalid.slice(0, 5).join(", ")}` : ""}
      </p>
    </Modal>
  );
}

function ApplyDialog({
  count,
  tables,
  done,
}: {
  count: number;
  tables: number;
  done: (v: { note: string; sendRn: boolean; rnNote: string } | null) => void;
}) {
  const [note, setNote] = useState("");
  const [rnNote, setRnNote] = useState("");
  const [sendRn, setSendRn] = useState(true);
  return (
    <Modal
      title={`Apply ${count.toLocaleString("en-US")} change${count === 1 ? "" : "s"}?`}
      onClose={() => done(null)}
      footer={
        <>
          <SendRnCheck checked={sendRn} onChange={setSendRn} />
          <Button onClick={() => done(null)}>Cancel</Button>
          <Button variant="primary" onClick={() => done({ note, sendRn, rnNote })}>
            Apply
          </Button>
        </>
      }
    >
      <p>
        The rates change on {tables} table{tables === 1 ? "" : "s"} as one change in History, undone as one (§13.10).
        New rates open new versions; traffic already sent keeps its rate.
      </p>
      <label className="field">
        <span>Note (optional, shown in History)</span>
        <input autoFocus value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
      </label>
      {sendRn && <RnNoteField value={rnNote} onChange={setRnNote} />}
    </Modal>
  );
}

export function BulkRatingPage() {
  const location = useLocation();
  const navigate = useTabNavigate();
  const initial = useMemo(() => parseScope(location.search), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [tables, setTables] = useState(initial.tables);
  const [mccmncs, setMccmncs] = useState(initial.mccmncs);
  const [countries, setCountries] = useState(initial.countries);
  // Fixed rate is the usual job, so it is the default (team trial round 1).
  const [type, setType] = useState<RateBulkAction["type"]>("set");
  const [value, setValue] = useState("");
  const [costSource, setCostSource] = useState<"best_buy" | "vendor_trunk">("best_buy");
  const [vendorTrunkId, setVendorTrunkId] = useState<number | null>(null);
  const [round, setRound] = useState("4");
  const tz = usePlatformTz();
  // Default start: today 00:00 in the platform time zone; applies from the save (team trial round 2).
  const [from, setFrom] = useState(() => todayMidnight(tz));
  const [respectNotice, setRespectNotice] = useState(true);
  // New destinations are added by default; "Don't add if new" keeps to the rates a table already has (round 4).
  const [skipNew, setSkipNew] = useState(false);
  const [preview, setPreview] = useState<RateBulkPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [edits, setEdits] = useState<Edits>(noEdits);
  const [show, setShow] = useState<Show>("all");
  const [search, setSearch] = useState("");
  const [formula, setFormula] = useState("");
  const apply = useApplyRateBulk();
  const notifySaved = useNotifySaved();
  // Opened from Market moves (§13.14): the chosen clients' suggested rates and dates.
  const [move, setMove] = useState<MarketMoveDetail | null>(null);
  const [overrides, setOverrides] = useState<NonNullable<RateBulkScope["overrides"]>>([]);

  useEffect(() => {
    const id = Number(new URLSearchParams(location.search).get("move")) || null;
    if (!id) return;
    fetchMarketMove(id)
      .then((m) => {
        const ov = m.clients
          .filter((c) => initial.tables.includes(c.rateTableId) && c.suggestedRate !== null)
          .map((c) => ({
            rateTableId: c.rateTableId,
            mccmnc: m.mccmnc,
            rate: c.suggestedRate!,
            effectiveFrom: c.suggestedFrom,
          }));
        setMove(m);
        setOverrides(ov);
        setType("none");
        setMccmncs([m.mccmnc]);
        void previewWith({
          rateTableIds: initial.tables,
          mccmncs: [m.mccmnc],
          onlyExisting: true,
          respectNotice: true,
          effectiveFrom: null,
          action: { type: "none" },
          overrides: ov,
        });
      })
      .catch((err: unknown) => toast({ tone: "error", message: err instanceof ApiError ? err.message : String(err) }));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Opened again from the Rate Manager with another selection: take the new scope.
  useEffect(() => {
    const s = parseScope(location.search);
    if (scopeUrl(s) === scopeUrl({ tables, mccmncs, countries })) return;
    setTables(s.tables);
    setMccmncs(s.mccmncs);
    setCountries(s.countries);
    setPreview(null);
  }, [location.search]); // eslint-disable-line react-hooks/exhaustive-deps

  // The scope stays in the tab URL, so the job can be reopened or shared.
  useEffect(() => {
    const url = scopeUrl({ tables, mccmncs, countries });
    if (url !== `${location.pathname}${location.search}`) navigate(url, { replace: true });
  }, [tables, mccmncs, countries]); // eslint-disable-line react-hooks/exhaustive-deps

  const action = ACTIONS.find((a) => a.value === type)!;
  const costPlus = type === "cost_plus_pct" || type === "cost_plus_amount";
  const reviewed = useMemo(() => (preview ? review(preview.rows, edits) : []), [preview, edits]);
  const totals = useMemo(() => impact(reviewed), [reviewed]);
  const shown = useMemo(() => visible(reviewed, show, search), [reviewed, show, search]);
  const items = useMemo(() => applyItems(reviewed), [reviewed]);
  const currency = preview?.summary.currency ?? "";

  const scope = (): RateBulkScope | null => {
    if (!tables.length) {
      toast({ tone: "warning", message: "Choose at least one client's rate table" });
      return null;
    }
    const needsValue = !!action.valueLabel;
    const v = Number(value.replace(",", "."));
    if (needsValue && (value.trim() === "" || !Number.isFinite(v))) {
      toast({ tone: "warning", message: `Enter the ${action.valueLabel!.toLowerCase()}` });
      return null;
    }
    return {
      rateTableIds: tables,
      ...(mccmncs.length ? { mccmncs } : {}),
      ...(countries.length ? { countryIsos: countries } : {}),
      onlyExisting: skipNew,
      respectNotice,
      effectiveFrom: effectiveIso(from, tz),
      ...(overrides.length ? { overrides } : {}),
      action: {
        type,
        value: needsValue ? v : null,
        round: Number(round),
        ...(costPlus ? { costSource, vendorTrunkId: costSource === "vendor_trunk" ? vendorTrunkId : null } : {}),
      },
    };
  };

  const runPreview = async () => {
    const body = scope();
    if (body) await previewWith(body);
  };
  const previewWith = async (body: RateBulkScope) => {
    setLoading(true);
    try {
      setPreview(await previewRateBulk(body));
      setEdits(noEdits());
      setShow("all");
    } catch (err) {
      toast({ tone: "error", message: err instanceof ApiError ? err.message : String(err) });
    } finally {
      setLoading(false);
    }
  };

  const runApply = async (note: string, sendRn: boolean, acceptNoticeBreach = false, rnNote = ""): Promise<void> => {
    try {
      const r = await apply.mutateAsync({
        items,
        sendNotification: sendRn,
        ...(sendRn && rnNote.trim() ? { notificationNote: rnNote.trim() } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
        ...(acceptNoticeBreach ? { acceptNoticeBreach: true } : {}),
      });
      if (r.change) {
        notifySaved(
          r.change,
          `Applied ${r.applied} change${r.applied === 1 ? "" : "s"} on ${r.tables} tables${r.notificationsSent ? ` · RN sent to ${r.notificationsSent} client${r.notificationsSent === 1 ? "" : "s"}` : ""}`,
        );
        if (move)
          void actOnMove(move.id, {
            action: "handled",
            note: `Rates updated on ${r.tables} client table${r.tables === 1 ? "" : "s"} (change #${r.change.id})`,
          }).catch(() => undefined);
      } else toast({ tone: "info", message: "Nothing changed" });
      setPreview(null);
      setEdits(noEdits());
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        const ok = await ask<boolean>((done) => (
          <NoticeDialog breach={err.problem as unknown as NoticeBreach} done={done} />
        ));
        if (ok) return runApply(note, sendRn, true, rnNote);
        return;
      }
      toast({ tone: "error", message: err instanceof ApiError ? err.message : String(err) });
    }
  };

  const confirmApply = async () => {
    const v = await ask<{ note: string; sendRn: boolean; rnNote: string }>((done) => (
      <ApplyDialog count={items.length} tables={new Set(items.map((i) => i.rateTableId)).size} done={done} />
    ));
    if (v) await runApply(v.note, v.sendRn, false, v.rnNote);
  };

  const setRate = (key: string, v: number | null) => {
    const rates = new Map(edits.rates);
    if (v === null) rates.delete(key);
    else rates.set(key, v);
    setEdits({ ...edits, rates });
  };
  const exclude = (keys: string[], on: boolean) => {
    const excluded = new Set(edits.excluded);
    for (const k of keys) {
      if (on) excluded.add(k);
      else excluded.delete(k);
    }
    setEdits({ ...edits, excluded });
  };
  const applyFormula = () => {
    const rates = new Map(edits.rates);
    let bad = 0;
    for (const r of shown) {
      if (r.edit === "close" || r.edit === "block") continue;
      const v = evalCell(formula, { cost: r.cost, rate: r.currentRate });
      if (v === null) bad++;
      else rates.set(r.key, v);
    }
    setEdits({ ...edits, rates });
    if (bad) toast({ tone: "warning", message: `${bad} row${bad === 1 ? "" : "s"} skipped (no cost or current rate)` });
  };

  usePageStatus({
    rows: preview
      ? `${totals.rows.toLocaleString("en-US")} rates · ${totals.applying.toLocaleString("en-US")} to apply · ${totals.excluded} excluded`
      : `${tables.length} table${tables.length === 1 ? "" : "s"} × ${mccmncs.length + countries.length ? `${mccmncs.length} MCCMNC, ${countries.length} countries` : "all destinations"}`,
    shortcuts:
      "Type a rate or a formula (=cost*1.15, =rate+0.002) in New rate · money in " +
      (currency || "the platform currency"),
  });

  const columns: VColumn<Reviewed>[] = [
    {
      key: "inc",
      header: (
        <input
          type="checkbox"
          aria-label="Include all shown rows"
          checked={shown.length > 0 && shown.every((r) => r.included)}
          onChange={(e) =>
            exclude(
              shown.map((r) => r.key),
              !e.target.checked,
            )
          }
        />
      ),
      width: 36,
      sticky: true,
      align: "center",
      render: (r) => (
        <input
          type="checkbox"
          aria-label={`Include ${r.table} ${r.mccmnc}`}
          checked={r.included}
          onChange={(e) => exclude([r.key], !e.target.checked)}
        />
      ),
    },
    {
      key: "table",
      header: "Table",
      width: 190,
      sticky: true,
      render: (r) => <span title={r.clients}>{r.table}</span>,
    },
    {
      key: "clients",
      header: "Clients",
      width: 170,
      render: (r) => <span title={r.clients}>{r.clients.split(", ").slice(0, 2).join(", ") || "—"}</span>,
    },
    { key: "country", header: "Country", width: 120, render: (r) => r.country ?? "—" },
    { key: "network", header: "Network", width: 150, render: (r) => r.network ?? "—" },
    { key: "mccmnc", header: "MCCMNC", width: 76, align: "right", render: (r) => r.mccmnc },
    { key: "sender", header: "Sender ID", width: 90, render: (r) => r.senderId ?? <span className="muted">—</span> },
    { key: "cur", header: "Current", width: 84, align: "right", render: (r) => formatRate(r.currentRate) },
    {
      key: "new",
      header: "New rate",
      width: 110,
      align: "right",
      cellClass: (r) => (r.edited ? "bulk-edited" : undefined),
      render: (r) =>
        r.edit === "close" || r.edit === "block" ? (
          <span className="muted">{r.edit === "close" ? "closes" : r.newBlocked ? "blocked" : "unblocked"}</span>
        ) : (
          <RateCell row={r} onChange={(v) => setRate(r.key, v)} />
        ),
    },
    {
      key: "change",
      header: "Change",
      width: 92,
      align: "right",
      render: (r) => (
        <span className={r.change === "increase" ? "tone-warning" : r.changePct !== null ? undefined : "muted"}>
          {r.changePct !== null ? formatPct(r.changePct, true) : CHANGE_LABEL[r.change]}
        </span>
      ),
    },
    { key: "cost", header: "Cost", width: 84, align: "right", render: (r) => formatRate(r.cost) },
    {
      key: "vendor",
      header: "Cost vendor",
      width: 120,
      render: (r) => r.costVendor ?? <span className="muted">—</span>,
    },
    { key: "mnow", header: "Margin now", width: 90, align: "right", render: (r) => formatPct(r.currentMarginPct) },
    {
      key: "mnew",
      header: "Margin new",
      width: 90,
      align: "right",
      cellClass: (r) => (r.belowCost ? "tone-error strong" : undefined),
      render: (r) => formatPct(r.newMarginPct),
    },
    {
      key: "from",
      header: "From",
      width: 150,
      render: (r) => (
        <span
          className={r.noticeAdjusted ? "tone-warning" : undefined}
          title={r.noticeAdjusted ? "Moved to the end of the notice period" : undefined}
        >
          {Date.parse(r.effectiveFrom) > Date.now() + 60_000 ? shortDateTime(r.effectiveFrom) : "Now"}
        </span>
      ),
    },
    { key: "n7", header: "Msgs 7d", width: 80, align: "right", render: (r) => r.messages7d.toLocaleString("en-US") },
    {
      key: "d7",
      header: "Revenue Δ 7d",
      width: 104,
      align: "right",
      render: (r) =>
        r.revenueChange7d ? `${money(r.revenueChange7d)} ${r.currency}` : <span className="muted">—</span>,
    },
    { key: "note", header: "Note", width: 260, render: (r) => r.note ?? "" },
  ];

  return (
    <div className="page bulk-page">
      <PageHeader
        page={page}
        actions={
          <Button
            variant="primary"
            icon="check"
            disabled={!items.length || apply.isPending}
            onClick={() => void confirmApply()}
          >
            Apply {items.length ? items.length.toLocaleString("en-US") : ""} change{items.length === 1 ? "" : "s"}
          </Button>
        }
      />
      {move && (
        <div className="rn-banner">
          Suggested rates from the market move on{" "}
          <strong>
            {move.country} · {move.network} ({move.mccmnc})
          </strong>{" "}
          {moveLabel(move)} for {overrides.length} client table{overrides.length === 1 ? "" : "s"}: review, adjust and
          apply. The move is marked handled after applying.
        </div>
      )}
      <div className="bulk-setup">
        <section className="bulk-card" aria-label="Scope">
          <h2>1 · Scope</h2>
          <div className="field">
            <span>Clients' rate tables</span>
            <TableScope ids={tables} onChange={setTables} />
          </div>
          {/* Destinations come from the tree or a pasted list (team trial round 4: no separate MCCMNC / country
              boxes); what is picked shows as a count with Clear. */}
          {mccmncs.length + countries.length > 0 && (
            <div className="bulk-row">
              <span className="small">
                Destinations: <strong>{mccmncs.length}</strong> network{mccmncs.length === 1 ? "" : "s"}
                {countries.length ? (
                  <>
                    {" "}
                    and <strong>{countries.length}</strong> whole countr{countries.length === 1 ? "y" : "ies"}
                  </>
                ) : null}
              </span>
              <button
                type="button"
                className="link small"
                onClick={() => {
                  setMccmncs([]);
                  setCountries([]);
                }}
              >
                Clear
              </button>
            </div>
          )}
          <div className="bulk-row">
            <Button
              small
              icon="globe"
              onClick={async () => {
                const v = await ask<{ mccmncs: string[]; countries: string[] }>((done) => (
                  <DestinationPickDialog done={done} />
                ));
                if (!v) return;
                setMccmncs([...new Set([...mccmncs, ...v.mccmncs])]);
                setCountries([...new Set([...countries, ...v.countries])]);
              }}
            >
              Pick countries and networks…
            </Button>
            <Button
              small
              icon="upload"
              onClick={async () => {
                const v = await ask<{ mccmncs: string[]; countries: string[] }>((done) => <PasteDialog done={done} />);
                if (!v) return;
                setMccmncs([...new Set([...mccmncs, ...v.mccmncs])]);
                setCountries([...new Set([...countries, ...v.countries])]);
              }}
            >
              Paste a list
            </Button>
            <span className="muted small">
              {tables.length} table{tables.length === 1 ? "" : "s"} ×{" "}
              {mccmncs.length + countries.length
                ? `${mccmncs.length} MCCMNC + ${countries.length} countries`
                : "every destination they price"}
              {preview ? ` = ${preview.summary.lines.toLocaleString("en-US")} rates` : ""}
            </span>
          </div>
        </section>
        <section className="bulk-card" aria-label="Action">
          <h2>2 · Action</h2>
          <div className="bulk-grid">
            <label className="field">
              <span>Action</span>
              <select value={type} onChange={(e) => setType(e.target.value as RateBulkAction["type"])}>
                {ACTIONS.map((a) => (
                  <option key={a.value} value={a.value}>
                    {a.label}
                  </option>
                ))}
              </select>
            </label>
            {action.valueLabel && (
              <label className="field">
                <span>{action.valueLabel}</span>
                <input type="number" step="any" value={value} onChange={(e) => setValue(e.target.value)} />
              </label>
            )}
            {costPlus && (
              <label className="field">
                <span>Cost</span>
                <select
                  value={costSource}
                  onChange={(e) => setCostSource(e.target.value as "best_buy" | "vendor_trunk")}
                >
                  <option value="best_buy">Best vendor (best buy)</option>
                  <option value="vendor_trunk">A chosen vendor trunk</option>
                </select>
              </label>
            )}
            {costPlus && costSource === "vendor_trunk" && (
              <div className="field">
                <span>Vendor trunk</span>
                <ListLookup<{ id: number; name: string }>
                  list="vendor_trunks"
                  value={vendorTrunkId}
                  onChange={(r) => setVendorTrunkId(r?.id ?? null)}
                  labelOf={(r) => r.name}
                  placeholder="Choose a vendor trunk…"
                />
              </div>
            )}
            {!["close", "block", "unblock"].includes(type) && (
              <label className="field">
                <span>Round to</span>
                <select value={round} onChange={(e) => setRound(e.target.value)}>
                  {[2, 3, 4, 5, 6].map((n) => (
                    <option key={n} value={n}>
                      {n} decimals
                    </option>
                  ))}
                </select>
              </label>
            )}
            <EffectiveFromField value={from} onChange={setFrom} />
          </div>
          <div className="bulk-row">
            <label className="toggle-inline">
              <input type="checkbox" checked={respectNotice} onChange={(e) => setRespectNotice(e.target.checked)} />
              Respect notice periods (increases start when each client's notice ends)
            </label>
            {(type === "set" || costPlus) && (
              <label className="toggle-inline">
                <input type="checkbox" checked={skipNew} onChange={(e) => setSkipNew(e.target.checked)} />
                Don&apos;t add if new
              </label>
            )}
            <span className="fb-spacer" />
            <Button icon="search" disabled={loading} onClick={() => void runPreview()}>
              {loading ? "Working…" : "Preview"}
            </Button>
          </div>
        </section>
      </div>

      {preview && (
        <>
          <div className="stat-cards" aria-label="Impact">
            <div className="stat-card">
              <span className="stat-label">To apply</span>
              <span className="stat-value">{totals.applying.toLocaleString("en-US")}</span>
              <span className="muted small">
                {totals.up} up · {totals.down} down · {totals.new} new
                {totals.closed ? ` · ${totals.closed} closed` : ""}
                {totals.blocked + totals.unblocked ? ` · ${totals.blocked + totals.unblocked} (un)blocked` : ""}
              </span>
            </div>
            <div className="stat-card">
              <span className="stat-label">Below cost</span>
              <span className={`stat-value${totals.belowCost ? " tone-error" : ""}`}>{totals.belowCost}</span>
              <span className="muted small">
                {totals.unchanged} unchanged · {totals.excluded} excluded
              </span>
            </div>
            <div className="stat-card">
              <span className="stat-label">Notice breaches</span>
              <span className={`stat-value${totals.noticeBreach ? " tone-warning" : ""}`}>{totals.noticeBreach}</span>
              <span className="muted small">{preview.summary.noticeAdjusted} moved to the notice date</span>
            </div>
            <div className="stat-card">
              <span className="stat-label">Revenue change (7 days)</span>
              <span className={`stat-value${totals.revenueChange7d < 0 ? " tone-error" : ""}`}>
                {money(totals.revenueChange7d)}
              </span>
              <span className="muted small">
                {preview.summary.traffic
                  ? `on ${totals.revenue7d.toLocaleString("en-US", { maximumFractionDigits: 2 })} ${currency} · ${preview.summary.messages7d.toLocaleString("en-US")} msgs`
                  : "traffic figures unavailable"}
              </span>
            </div>
            <div className="stat-card">
              <span className="stat-label">Margin change (7 days)</span>
              <span className={`stat-value${totals.marginChange7d < 0 ? " tone-error" : " tone-good"}`}>
                {money(totals.marginChange7d)}
              </span>
              <span className="muted small">{currency}, same traffic at the new rates</span>
            </div>
          </div>
          <section className="rate-grid-card bulk-review" aria-label="Review">
            <div className="rate-toolbar bulk-row">
              <div className="segmented small-seg" role="group" aria-label="Show">
                {SHOWS.map((s) => (
                  <button
                    key={s.value}
                    type="button"
                    className={show === s.value ? "on" : ""}
                    onClick={() => setShow(s.value)}
                  >
                    {s.label}
                    <span className="seg-count">{visible(reviewed, s.value, "").length}</span>
                  </button>
                ))}
              </div>
              <input
                className="bulk-search"
                type="search"
                placeholder="Search table, client, country, network…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <span className="fb-spacer" />
              <input
                className="bulk-formula"
                placeholder="=cost*1.15"
                aria-label="Rate or formula for the shown rows"
                value={formula}
                onChange={(e) => setFormula(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && formula && applyFormula()}
              />
              <Button small disabled={!formula} onClick={applyFormula}>
                Fill shown rows
              </Button>
              <Button
                small
                disabled={!totals.belowCost}
                onClick={() =>
                  exclude(
                    reviewed.filter((r) => r.belowCost).map((r) => r.key),
                    true,
                  )
                }
              >
                Exclude below cost
              </Button>
              <Button
                small
                disabled={!totals.noticeBreach}
                onClick={() =>
                  exclude(
                    reviewed.filter((r) => r.noticeBreach).map((r) => r.key),
                    true,
                  )
                }
              >
                Exclude notice breaches
              </Button>
              <Button
                small
                variant="ghost"
                disabled={!edits.rates.size && !edits.excluded.size}
                onClick={() => setEdits(noEdits())}
              >
                Reset edits
              </Button>
            </div>
            <VirtualTable<Reviewed>
              label="Bulk rating review"
              rows={shown}
              columns={columns}
              rowKey={(r) => r.key}
              rowClass={(r) =>
                [!r.included ? "off" : "", r.belowCost ? "negative" : r.noticeBreach ? "warn" : ""]
                  .filter(Boolean)
                  .join(" ") || undefined
              }
              empty="No rows here"
            />
          </section>
        </>
      )}
      {!preview && (
        <div className="grid-message muted bulk-empty">
          Choose the clients' tables and destinations, pick an action and press Preview. Nothing changes until you
          apply.
        </div>
      )}
    </div>
  );
}

/** New rate cell: type a rate or a formula; Enter or leaving the cell keeps it, Escape undoes. */
function RateCell({ row, onChange }: { row: Reviewed; onChange: (v: number | null) => void }) {
  const [text, setText] = useState<string | null>(null);
  const commit = () => {
    if (text === null) return;
    if (text.trim() === "") onChange(null);
    else {
      const v = evalCell(text, { cost: row.cost, rate: row.currentRate });
      if (v === null) toast({ tone: "warning", message: `Can't use "${text}" here` });
      else onChange(v);
    }
    setText(null);
  };
  return (
    <input
      className="bulk-rate"
      aria-label={`New rate ${row.table} ${row.mccmnc}`}
      value={text ?? (row.newRate === null ? "" : String(row.newRate))}
      placeholder="—"
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") setText(null);
      }}
    />
  );
}
