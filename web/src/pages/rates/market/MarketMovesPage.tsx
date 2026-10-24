// Market moves (§13.14): destinations where leading vendors moved their rates. Each move shows the
// direction and average change, how many top vendors moved, the dates and a line chart of each top
// vendor's rate; under it the affected clients with today's sell rate, margins now and at the new
// cost, 7-day volume, notice period and a suggested rate. "Update rates" opens Bulk rating pre-filled
// with the chosen clients' suggestions; reroute, snooze, dismiss and handled are logged on the move.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type {
  Enterprise,
  FilterCondition,
  MarketAutoRule,
  MarketMoveDetail,
  MarketMoveRow,
  MarketMoveSettings,
} from "@sms/contract";
import { fetchListPage } from "../../../api/hooks";
import {
  useActOnMove,
  useArchiveAutoRule,
  useAutoRules,
  useMarketMove,
  useMarketSettings,
  useMarketSummary,
  useSaveAutoRule,
  useSaveMarketSettings,
  useScanMoves,
  useSendDigest,
} from "../../../api/market";
import { pageForPath } from "../../../nav/registry";
import { ListScreen } from "../../../page/ListScreen";
import { useTabNavigate } from "../../../shell/tabContext";
import { Chart, useChartColors } from "../../../ui/Chart";
import { ChecklistChip } from "../../../ui/ChecklistChip";
import { ask, toast } from "../../../ui/feedback";
import { Button, Modal, StatusDot } from "../../../ui/primitives";
import { problemText } from "../../routing/dialogs";
import { fmtWhen } from "../../reference/shared";
import { Kv } from "../../admin/parts";
import { formatPct, formatRate, relDays, shortDate } from "../format";
import { AmFilter } from "../RateManagerPage";
import { editTopVendorsFor, openTopVendors } from "./TopVendors";
import { moveLabel, routeRulesFor, STATE_LABEL, STATE_TONE, updateRatesUrl, vendorChart } from "./marketModel";

const page = pageForPath("/rates/market-moves")!;
const fail = (e: unknown) => toast({ tone: "error", message: problemText(e) });
const arrow = (r: Pick<MarketMoveRow, "direction" | "avgChangePct">) => (
  <span className={r.direction === "up" ? "tone-error strong" : "tone-good strong"}>{moveLabel(r)}</span>
);

function NoteDialog({
  title,
  required,
  done,
}: {
  title: string;
  required: boolean;
  done: (note: string | null) => void;
}) {
  const [note, setNote] = useState("");
  return (
    <Modal
      title={title}
      onClose={() => done(null)}
      footer={
        <>
          <Button onClick={() => done(null)}>Cancel</Button>
          <Button variant="primary" disabled={required && !note.trim()} onClick={() => done(note.trim())}>
            Save
          </Button>
        </>
      }
    >
      <label className="field">
        <span>Note{required ? " (required)" : " (optional)"}</span>
        <textarea autoFocus rows={3} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
    </Modal>
  );
}

function MoveCard({ r }: { r: MarketMoveRow }) {
  const q = useMarketMove(r.id);
  const colors = useChartColors();
  const act = useActOnMove();
  const navigate = useTabNavigate();
  const d = q.data;
  const run = async (action: "dismiss" | "handled" | "note" | "reopen" | "snooze", days?: number) => {
    let note: string | null = null;
    if (action === "dismiss" || action === "handled" || action === "note") {
      note = await ask<string>((done) => (
        <NoteDialog
          title={{ dismiss: "Dismiss this move", handled: "Mark handled", note: "Add a note" }[action]}
          required={action !== "handled"}
          done={done}
        />
      ));
      if (note === null) return;
    }
    act.mutate(
      { id: r.id, body: { action, ...(days ? { days } : {}), ...(note ? { note } : {}) } },
      { onSuccess: () => toast({ tone: "good", message: "Saved on the move" }), onError: fail },
    );
  };
  const notMoved = d?.vendors.filter((v) => !v.moved) ?? [];
  return (
    <div className="mm-card">
      <div className="bulk-row">
        <span className="mm-big">{arrow(r)}</span>
        <span>
          <strong>
            {r.movedCount} of {r.topCount}
          </strong>{" "}
          top vendors moved · from {shortDate(r.firstEffective)}
          {r.lastEffective !== r.firstEffective ? ` to ${shortDate(r.lastEffective)}` : ""}
        </span>
        <span className="muted">
          market cost (average of the vendors that moved) {formatRate(r.oldCost)} → {formatRate(r.newCost)} {r.currency}
          {r.oldCost && r.newCost !== null
            ? ` (${formatPct(Math.round((r.newCost / r.oldCost - 1) * 10000) / 100, true)})`
            : ""}
        </span>
        {r.urgent && <span className="chip-mini tone-error">Urgent</span>}
        <span className="fb-spacer" />
        <Button
          small
          title="Pick the vendor trunks that count for this destination (team trial round 5)"
          onClick={() => void editTopVendorsFor(r.mccmnc)}
        >
          Top vendors…
        </Button>
        {r.state === "open" ? (
          <>
            <select
              className="btn btn-sm"
              aria-label="Snooze"
              value=""
              onChange={(e) => e.target.value && void run("snooze", Number(e.target.value))}
            >
              <option value="">Snooze…</option>
              <option value="1">1 day</option>
              <option value="7">7 days</option>
              <option value="30">30 days</option>
            </select>
            <Button small onClick={() => void run("dismiss")}>
              Dismiss…
            </Button>
            <Button small onClick={() => void run("handled")}>
              Mark handled
            </Button>
          </>
        ) : (
          <Button small onClick={() => void run("reopen")}>
            Reopen
          </Button>
        )}
        <Button small variant="ghost" onClick={() => void run("note")}>
          Add note
        </Button>
      </div>
      {d && d.vendors.some((v) => v.series.length) && (
        <Chart
          option={vendorChart(d.vendors, colors, r.currency)}
          height={170}
          label="Top vendors' rates over the last 90 days"
        />
      )}
      {d && (
        <table className="rtable mm-vendors">
          <thead>
            <tr>
              <th>Vendor trunk</th>
              <th>Tier</th>
              <th className="num">Old</th>
              <th className="num">New</th>
              <th className="num">Change</th>
              <th>From</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {d.vendors.map((v) => (
              <tr key={v.vendorTrunkId} className={v.moved ? undefined : "off"}>
                <td>
                  {v.vendorTrunk} <span className="muted small">{v.vendor}</span>
                </td>
                <td>{v.tier === "tier1" ? "Tier 1" : v.tier.replace("tier", "Tier ")}</td>
                <td className="num">{formatRate(v.oldRate)}</td>
                <td className="num">{formatRate(v.newRate)}</td>
                <td className="num">
                  {v.moved ? formatPct(v.changePct, true) : <span className="muted">did not move</span>}
                </td>
                <td>{v.effectiveFrom ? shortDate(v.effectiveFrom) : "—"}</td>
                <td>
                  {v.moved && (
                    <button
                      type="button"
                      className="link small"
                      title="Route Rules using this vendor (Bulk edit: replace vendor)"
                      onClick={() => navigate(routeRulesFor(v.vendorTrunk), { newTab: true })}
                    >
                      Reroute…
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {notMoved.length > 0 && (
        <p className="muted small">
          {notMoved.length} top vendor{notMoved.length === 1 ? "" : "s"} did not move (e.g. {notMoved[0]!.vendorTrunk}{" "}
          at {formatRate(notMoved[0]!.newRate)} {r.currency}): rerouting there keeps the old cost.
        </p>
      )}
    </div>
  );
}

function Clients({ r }: { r: MarketMoveRow }) {
  const q = useMarketMove(r.id);
  const navigate = useTabNavigate();
  const [picked, setPicked] = useState<Set<number> | null>(null);
  const d: MarketMoveDetail | undefined = q.data;
  if (!d) return <p className="muted small">Loading…</p>;
  const chosen =
    picked ??
    new Set(
      d.clients.filter((c) => c.suggestedRate !== null && c.suggestedRate !== c.sellRate).map((c) => c.rateTableId),
    );
  const toggle = (id: number) => {
    const n = new Set(chosen);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    setPicked(n);
  };
  return (
    <div className="mm-clients">
      <div className="bulk-row">
        <strong>{d.clients.length} client tables sell this destination</strong>
        <span className="muted small">{chosen.size} chosen</span>
        <span className="fb-spacer" />
        <Button
          small
          variant="primary"
          disabled={!chosen.size}
          title="Opens Bulk rating with the suggested rates and dates (§13.11)"
          onClick={() => navigate(updateRatesUrl(d, [...chosen]), { newTab: true, title: "Bulk rating" })}
        >
          Update rates ({chosen.size})
        </Button>
      </div>
      <div className="mm-table-wrap">
        <table className="rtable">
          <thead>
            <tr>
              <th>
                <input
                  type="checkbox"
                  aria-label="Choose all"
                  checked={chosen.size === d.clients.length && d.clients.length > 0}
                  onChange={(e) => setPicked(new Set(e.target.checked ? d.clients.map((c) => c.rateTableId) : []))}
                />
              </th>
              <th>Table</th>
              <th>Clients</th>
              <th>Account Manager</th>
              <th className="num">Sell</th>
              <th className="num">Margin now</th>
              <th className="num">At new cost</th>
              <th className="num">Msgs 7d</th>
              <th className="num">Notice</th>
              <th className="num" title="New market cost plus the client's current margin (or the target margin)">
                Suggested
              </th>
              <th className="num" title="Suggested rate against today's sell rate">
                Change
              </th>
              <th>From</th>
              <th>Auto-apply</th>
            </tr>
          </thead>
          <tbody>
            {d.clients.map((c) => (
              <tr key={c.rateTableId}>
                <td>
                  <input
                    type="checkbox"
                    aria-label={`Choose ${c.table}`}
                    checked={chosen.has(c.rateTableId)}
                    onChange={() => toggle(c.rateTableId)}
                  />
                </td>
                <td>{c.table}</td>
                <td title={c.clients}>{c.clients.length > 40 ? `${c.clients.slice(0, 40)}…` : c.clients}</td>
                <td>{c.accountManager ?? "—"}</td>
                <td className="num">
                  {formatRate(c.sellRate)} <span className="muted small">{c.currency}</span>
                </td>
                <td className="num">{formatPct(c.marginNowPct)}</td>
                <td className={`num${c.belowNewCost ? " tone-error strong" : ""}`}>{formatPct(c.marginNewPct)}</td>
                <td className="num">{c.messages7d.toLocaleString("en-US")}</td>
                <td className="num">{c.noticeDays} d</td>
                <td className="num strong">{formatRate(c.suggestedRate)}</td>
                <td className="num">
                  {c.suggestedRate !== null && c.sellRate > 0
                    ? formatPct(Math.round((c.suggestedRate / c.sellRate - 1) * 10000) / 100, true)
                    : "—"}
                </td>
                <td>{shortDate(c.suggestedFrom)}</td>
                <td className="muted small">{c.autoRule ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Log({ r }: { r: MarketMoveRow }) {
  const d = useMarketMove(r.id).data;
  return (
    <ul className="incident-notes">
      {d?.log.map((g, i) => (
        <li key={i}>
          <span className="muted small">
            {g.user ?? "system"} · {fmtWhen(g.at)}
          </span>
          <div>{g.text}</div>
        </li>
      ))}
    </ul>
  );
}

function AutoRuleRow({ rule }: { rule: MarketAutoRule }) {
  const archive = useArchiveAutoRule();
  return (
    <li className="bulk-row">
      <StatusDot tone={rule.status === "active" ? "good" : "neutral"} /> {rule.label}
      <span className="fb-spacer" />
      <Button small variant="ghost" onClick={() => archive.mutate(rule.id, { onError: fail })}>
        Delete
      </Button>
    </li>
  );
}

/**
 * Every client (customers and bilateral partners), searched on the server, with tick boxes (team trial round 4,
 * §13.14). Clients that already have a rule are shown but cannot be ticked again.
 */
function ClientChecklist({
  ids,
  onChange,
  taken,
}: {
  ids: number[];
  onChange: (ids: number[]) => void;
  taken: Set<number>;
}) {
  const [q, setQ] = useState("");
  const results = useQuery({
    queryKey: ["list", "market-rule-clients", q],
    queryFn: () =>
      fetchListPage<Enterprise>("enterprises", {
        limit: 500,
        withTotal: true,
        ...(q.trim() ? { search: q.trim() } : {}),
        filter: { logic: "and", conditions: [{ field: "type", op: "in", values: ["customer", "reciprocal"] }] },
        sort: [{ field: "name", dir: "asc" }],
      }),
    staleTime: 30_000,
  });
  const rows = (results.data?.rows ?? []).filter((r) => !r.archivedAt);
  const free = rows.filter((r) => !taken.has(r.id));
  const allShown = free.length > 0 && free.every((r) => ids.includes(r.id));
  const toggle = (id: number) => onChange(ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]);
  return (
    <div className="multi-pick table-scope">
      <input
        type="search"
        placeholder="Search clients…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        aria-label="Search clients"
      />
      <div className="pick-list">
        {free.length > 0 && (
          <label className="choice-row select-all">
            <input
              type="checkbox"
              checked={allShown}
              onChange={() =>
                onChange(
                  allShown
                    ? ids.filter((id) => !free.some((r) => r.id === id))
                    : [...new Set([...ids, ...free.map((r) => r.id)])],
                )
              }
            />
            <span className="strong">Select all shown</span>
            <span className="muted small">
              {rows.length}
              {results.data?.total && results.data.total > rows.length ? ` of ${results.data.total}` : ""} clients
            </span>
          </label>
        )}
        {rows.map((r) => (
          <label key={r.id} className="choice-row" title={taken.has(r.id) ? "Already has a rule" : undefined}>
            <input
              type="checkbox"
              disabled={taken.has(r.id)}
              checked={taken.has(r.id) || ids.includes(r.id)}
              onChange={() => toggle(r.id)}
            />
            <span>{r.name}</span>
            <span className="muted small">
              {taken.has(r.id)
                ? "has a rule"
                : [r.type === "reciprocal" ? "Bilateral" : null, r.accountManagerName].filter(Boolean).join(" · ")}
            </span>
          </label>
        ))}
        {results.isSuccess && rows.length === 0 && <p className="muted small pad">No matches.</p>}
      </div>
    </div>
  );
}

function SettingsDialog({ done }: { done: (v: null) => void }) {
  const q = useMarketSettings();
  const save = useSaveMarketSettings();
  const rules = useAutoRules();
  const saveRule = useSaveAutoRule();
  const digest = useSendDigest();
  const [d, setD] = useState<MarketMoveSettings | null>(null);
  const s = d ?? q.data ?? null;
  const [ents, setEnts] = useState<number[]>([]);
  const [adding, setAdding] = useState(false);
  const [min, setMin] = useState("10");
  const [both, setBoth] = useState(false);
  const num = (k: keyof MarketMoveSettings, label: string, step = 1) =>
    s && (
      <label className="field">
        <span>{label}</span>
        <input
          type="number"
          step={step}
          value={(s[k] as number | null) ?? ""}
          onChange={(e) => setD({ ...s, [k]: e.target.value === "" ? null : Number(e.target.value) })}
        />
      </label>
    );
  return (
    <Modal
      title="Market move settings"
      width={720}
      onClose={() => done(null)}
      footer={
        <>
          <Button
            onClick={() =>
              digest.mutate(undefined, {
                onSuccess: (r) => toast({ tone: "good", message: `Digest sent to ${r.sent} account managers` }),
                onError: fail,
              })
            }
          >
            Send digest now
          </Button>
          <span className="fb-spacer" />
          <Button onClick={() => done(null)}>Close</Button>
          <Button
            variant="primary"
            disabled={!d || save.isPending}
            onClick={() =>
              d &&
              save.mutate(d, {
                onSuccess: () => {
                  toast({ tone: "good", message: "Saved; the next scan uses them" });
                  setD(null);
                },
                onError: fail,
              })
            }
          >
            Save
          </Button>
        </>
      }
    >
      {s && (
        <>
          <h3 className="part-title">Detection (§13.14)</h3>
          <div className="rn-form-grid">
            <label className="field">
              <span>Destinations without a top vendor list</span>
              <select
                value={s.unlistedMode}
                onChange={(e) => setD({ ...s, unlistedMode: e.target.value as MarketMoveSettings["unlistedMode"] })}
              >
                <option value="tier1">Tier 1 vendors (not watched with fewer than N)</option>
                <option value="cheapest">Cheapest N vendors (+ Tier 1 if ticked)</option>
                <option value="skip">Not watched</option>
              </select>
            </label>
            {s.unlistedMode === "cheapest" && (
              <>
                {num("cheapestN", "Cheapest N vendors count")}
                <label className="toggle-inline">
                  <input
                    type="checkbox"
                    checked={s.includeTier1}
                    onChange={(e) => setD({ ...s, includeTier1: e.target.checked })}
                  />
                  Tier 1 vendors count too
                </label>
              </>
            )}
            {num("windowDays", "Dates within (days)")}
            {num("minVendors", "At least N vendors")}
            {num("minChangePct", "Moving by at least (%)", 0.5)}
            {num("lookbackDays", "Look back (days)")}
            {num("urgentChangePct", "Urgent: increase ≥ (%)", 0.5)}
            {num("urgentDays", "Urgent: starting within (days)")}
            {num("targetMarginPct", "Target margin for suggestions (%)", 0.5)}
            {num("digestHour", "Daily digest at (UTC hour)")}
          </div>
          <p className="muted small">
            Destinations can have their own hand-picked top vendors (with or without Tier 1): use{" "}
            <button type="button" className="link" onClick={() => void openTopVendors()}>
              Top vendors per destination
            </button>
            . Destinations without one use the choice above: by default their Tier 1 vendors, and a destination with
            fewer Tier 1 vendors than &quot;At least N vendors&quot; is not watched.
          </p>
          <h3 className="part-title">Auto-apply rules</h3>
          <p className="muted small">
            Follow market moves automatically for a client: re-price when the margin at the new market cost falls below
            the minimum, from the move&apos;s date or the client&apos;s increase (or decrease) notice, whichever is
            later. Each re-price is one undoable change, and the client&apos;s customer trunks get the normal rate
            notification e-mail at once, showing the new rate and its start date.
          </p>
          <ul className="mm-rules">
            {rules.data?.rules.map((r) => (
              <AutoRuleRow key={r.id} rule={r} />
            ))}
            {rules.data && !rules.data.rules.length && <li className="muted small">No rules yet.</li>}
          </ul>
          <ClientChecklist
            ids={ents}
            onChange={setEnts}
            taken={
              new Set(
                (rules.data?.rules ?? [])
                  .filter((r) => r.enterpriseId !== null && r.status === "active")
                  .map((r) => r.enterpriseId!),
              )
            }
          />
          <div className="bulk-row">
            <span className="muted small">
              {ents.length ? `${ents.length} client${ents.length === 1 ? "" : "s"} ticked` : "Tick clients above"}
            </span>
            <label className="toggle-inline">
              keep margin ≥
              <input className="mm-num" type="number" value={min} onChange={(e) => setMin(e.target.value)} /> %
            </label>
            <label className="toggle-inline">
              <input type="checkbox" checked={both} onChange={(e) => setBoth(e.target.checked)} /> decreases too
            </label>
            <Button
              small
              disabled={!ents.length || adding}
              onClick={async () => {
                // One rule per client (the contract keeps one client per rule).
                setAdding(true);
                let added = 0;
                try {
                  for (const enterpriseId of ents) {
                    await saveRule.mutateAsync({
                      id: null,
                      body: {
                        enterpriseId,
                        categoryId: null,
                        direction: both ? "both" : "increases",
                        minMarginPct: Number(min),
                        status: "active",
                      },
                    });
                    added++;
                  }
                  toast({ tone: "good", message: `${added} rule${added === 1 ? "" : "s"} added` });
                  setEnts([]);
                } catch (e) {
                  fail(e);
                } finally {
                  setAdding(false);
                }
              }}
            >
              {adding ? "Adding…" : ents.length > 1 ? `Add ${ents.length} rules` : "Add rule"}
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}

const STATE_CHIP: Record<MarketMoveRow["state"], string> = {
  open: "amber",
  snoozed: "blue",
  handled: "green",
  dismissed: "",
  expired: "",
};

/** Summary tiles over the open moves (team trial round 5). */
function MoveKpis() {
  const q = useMarketSummary();
  const d = q.data;
  const tiles: { label: string; value: number | undefined; tone?: string; note?: string }[] = [
    { label: "Open moves", value: d?.open },
    { label: "Urgent", value: d?.urgent, tone: "red", note: "Large increases starting soon" },
    { label: "Increases", value: d?.up, tone: "red" },
    { label: "Decreases", value: d?.down, tone: "green" },
    { label: "For my clients", value: d?.mine, tone: "blue" },
  ];
  return (
    <div className="kpi-tiles">
      {tiles.map((t) => (
        <div key={t.label} className="kpi-tile">
          <span className={`kpi-label${t.tone ? ` tone-dot ${t.tone}` : ""}`}>{t.label}</span>
          <span className="kpi-value">{t.value === undefined ? "…" : t.value.toLocaleString("en-US")}</span>
          {t.note && <span className="muted small">{t.note}</span>}
        </div>
      ))}
    </div>
  );
}

export function MarketMovesPage() {
  const scan = useScanMoves();
  const act = useActOnMove();
  // The Move card's actions, per row (§13.14).
  const run = async (r: MarketMoveRow, action: "dismiss" | "handled" | "note" | "reopen" | "snooze", days?: number) => {
    let note: string | null = null;
    if (action === "dismiss" || action === "handled" || action === "note") {
      note = await ask<string>((done) => (
        <NoteDialog
          title={{ dismiss: "Dismiss this move", handled: "Mark handled", note: "Add a note" }[action]}
          required={action !== "handled"}
          done={done}
        />
      ));
      if (note === null) return;
    }
    act.mutate(
      { id: r.id, body: { action, ...(days ? { days } : {}), ...(note ? { note } : {}) } },
      { onSuccess: () => toast({ tone: "good", message: "Saved on the move" }), onError: fail },
    );
  };
  return (
    <ListScreen<MarketMoveRow>
      list="market_moves"
      page={page}
      noSelection
      historyScope={null}
      rowActions={(r) => {
        const open = r.state === "open";
        const closed = open ? undefined : `${STATE_LABEL[r.state]}: reopen it first`;
        return [
          {
            label: "Mark handled…",
            icon: "check",
            main: true,
            disabled: !open || act.isPending,
            hint: closed,
            onSelect: () => void run(r, "handled"),
          },
          {
            label: "Dismiss…",
            icon: "x",
            disabled: !open || act.isPending,
            hint: closed,
            onSelect: () => void run(r, "dismiss"),
          },
          ...[1, 7, 30].map((days) => ({
            label: `Snooze ${days} day${days === 1 ? "" : "s"}`,
            icon: "clock" as const,
            disabled: !open || act.isPending,
            hint: closed,
            onSelect: () => void run(r, "snooze", days),
          })),
          {
            label: "Reopen",
            icon: "undo",
            disabled: open || act.isPending,
            hint: open ? "Already open" : undefined,
            onSelect: () => void run(r, "reopen"),
          },
          { label: "Add note…", icon: "file", disabled: act.isPending, onSelect: () => void run(r, "note") },
        ];
      }}
      primary={{
        label: scan.isPending ? "Scanning…" : "Scan now",
        icon: "refresh",
        disabled: scan.isPending,
        onClick: () =>
          scan.mutate(undefined, {
            onSuccess: (x) =>
              toast({
                tone: "good",
                message: `${x.created} new, ${x.updated} updated, ${x.expired} expired${x.autoApplied ? `, ${x.autoApplied} auto-applied` : ""} (${(x.tookMs / 1000).toFixed(1)} s)`,
              }),
            onError: fail,
          }),
      }}
      actions={
        <>
          <Button icon="users" onClick={() => void openTopVendors()}>
            Top vendors
          </Button>
          <Button icon="gauge" onClick={() => void ask<null>((done) => <SettingsDialog done={done} />)}>
            Settings
          </Button>
        </>
      }
      // Queue redesign (team trial round 5, like Incidents and Alert rules): summary tiles, a filter bar of chips,
      // and each move as a card row with a direction edge.
      above={<MoveKpis />}
      rowHeight={62}
      initialState={{
        columns: { state: { field: "state", op: "in", values: ["open"] } },
        visible: ["country", "avgChangePct", "firstEffective", "newCost", "affectedClients", "state"],
      }}
      toolbarFields={["state", "direction", "urgent", "amUserId"]}
      toolbar={(state, setState) => {
        const set = (field: string, c: FilterCondition | null) => {
          const columns = { ...state.columns };
          if (c) columns[field] = c;
          else delete columns[field];
          setState({ ...state, columns });
        };
        const am = state.columns.amUserId;
        const urgent = state.columns.urgent;
        return (
          <div className="incident-filters">
            <ChecklistChip
              label="State"
              field="state"
              condition={state.columns.state}
              options={Object.entries(STATE_LABEL).map(([value, label]) => ({ value, label }))}
              onChange={(c) => set("state", c)}
            />
            <ChecklistChip
              label="Direction"
              field="direction"
              condition={state.columns.direction}
              options={[
                { value: "up", label: "↑ Increases" },
                { value: "down", label: "↓ Decreases" },
              ]}
              onChange={(c) => set("direction", c)}
            />
            <button
              type="button"
              className={`range-chip plain${urgent ? " set" : ""}`}
              aria-pressed={!!urgent}
              onClick={() => set("urgent", urgent ? null : { field: "urgent", op: "eq", value: true })}
            >
              {urgent ? "Urgent only" : "Urgent: All"}
            </button>
            <AmFilter
              value={am ? Number(am.value) : null}
              onChange={(id) => set("amUserId", id === null ? null : { field: "amUserId", op: "eq", value: id })}
            />
          </div>
        );
      }}
      columns={{
        country: {
          width: 300,
          label: "Destination",
          render: (r) => (
            <span className="two-line">
              <strong>
                {r.country ?? "—"}
                {r.urgent && r.state === "open" && (
                  <>
                    {" "}
                    <span className="chip-tag red">Urgent</span>
                  </>
                )}
              </strong>
              <span className="muted small">
                {r.network ?? "All networks"} · {r.mccmnc}
              </span>
            </span>
          ),
        },
        network: { width: 170 },
        mccmnc: { width: 80, align: "right" },
        direction: { width: 70, render: (r) => (r.direction === "up" ? "↑ Up" : "↓ Down") },
        avgChangePct: {
          width: 190,
          label: "Change",
          render: (r) => (
            <span className="two-line">
              <span className="mm-change">{arrow(r)}</span>
              <span className="muted small">
                {r.movedCount} of {r.topCount} top vendors moved
              </span>
            </span>
          ),
        },
        movedCount: {
          width: 90,
          align: "right",
          render: (r) => (
            <span className="num">
              {r.movedCount} of {r.topCount}
            </span>
          ),
        },
        firstEffective: {
          width: 230,
          label: "Effective",
          render: (r) => (
            <span className="two-line">
              <strong className="num">
                {shortDate(r.firstEffective)}
                {r.lastEffective.slice(0, 10) !== r.firstEffective.slice(0, 10)
                  ? ` – ${shortDate(r.lastEffective)}`
                  : ""}
              </strong>
              <span className="muted small">{relDays(r.firstEffective)}</span>
            </span>
          ),
        },
        newCost: {
          width: 220,
          align: "right",
          label: "Market cost",
          render: (r) => (
            <span className="two-line right">
              <span className="num">
                {formatRate(r.oldCost)} → <strong>{formatRate(r.newCost)}</strong>
              </span>
              <span className="muted small">
                {r.currency}
                {r.oldCost && r.newCost !== null
                  ? ` · ${formatPct(Math.round((r.newCost / r.oldCost - 1) * 10000) / 100, true)}`
                  : ""}
              </span>
            </span>
          ),
        },
        affectedClients: {
          width: 170,
          align: "right",
          label: "Clients",
          render: (r) => (
            <span className="two-line right">
              <strong className="num">
                {r.affectedClients} client{r.affectedClients === 1 ? "" : "s"}
              </strong>
              <span className="muted small">{r.volume7d.toLocaleString("en-US")} msgs in 7 days</span>
            </span>
          ),
        },
        volume7d: {
          width: 90,
          align: "right",
          render: (r) => <span className="num">{r.volume7d.toLocaleString("en-US")}</span>,
        },
        urgent: { width: 80, render: (r) => (r.urgent ? <span className="chip-tag red">Urgent</span> : "") },
        state: {
          width: 190,
          render: (r) => (
            <span className="two-line">
              <span className={`chip-tag ${STATE_CHIP[r.state]}`}>
                <span className="dot-mini" />
                {STATE_LABEL[r.state]}
              </span>
              <span className="muted small">
                {r.state === "snoozed" && r.snoozedUntil
                  ? `until ${shortDate(r.snoozedUntil)}`
                  : r.handledBy
                    ? `by ${r.handledBy}`
                    : `detected ${shortDate(r.detectedAt)}`}
              </span>
            </span>
          ),
        },
        detectedAt: { width: 160, render: (r) => fmtWhen(r.detectedAt) },
      }}
      rowClass={(r) =>
        `rule-row ${r.direction === "up" ? "sev-critical" : "sev-good"}${r.state === "open" ? "" : " row-muted"}`
      }
      detail={(r) => ({
        title: (
          <>
            <strong>
              {r.country} · {r.network} ({r.mccmnc})
            </strong>
            {arrow(r)}
            <span className="muted">{STATE_LABEL[r.state]}</span>
          </>
        ),
        sections: [
          { key: "move", label: "Move", content: <MoveCard key={r.id} r={r} /> },
          { key: "clients", label: `Affected clients (${r.affectedTables})`, content: <Clients key={r.id} r={r} /> },
          { key: "log", label: "Log", content: <Log key={r.id} r={r} /> },
        ],
      })}
      shortcuts="↑↓ move · Enter opens the move"
    />
  );
}
