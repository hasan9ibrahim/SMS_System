// Market moves (§13.14): destinations where leading vendors moved their rates. Each move shows the
// direction and average change, how many top vendors moved, the dates and a line chart of each top
// vendor's rate; under it the affected clients with today's sell rate, margins now and at the new
// cost, 7-day volume, notice period and a suggested rate. "Update rates" opens Bulk rating pre-filled
// with the chosen clients' suggestions; reroute, snooze, dismiss and handled are logged on the move.
import { useState } from "react";
import type { MarketAutoRule, MarketMoveDetail, MarketMoveRow, MarketMoveSettings } from "@sms/contract";
import {
  useActOnMove,
  useArchiveAutoRule,
  useAutoRules,
  useMarketMove,
  useMarketSettings,
  useSaveAutoRule,
  useSaveMarketSettings,
  useScanMoves,
  useSendDigest,
} from "../../../api/market";
import { pageForPath } from "../../../nav/registry";
import { ListScreen } from "../../../page/ListScreen";
import { ListLookup } from "../../../records/parts";
import { useTabNavigate } from "../../../shell/tabContext";
import { Chart, useChartColors } from "../../../ui/Chart";
import { ask, toast } from "../../../ui/feedback";
import { Button, Modal, StatusDot } from "../../../ui/primitives";
import { problemText } from "../../routing/dialogs";
import { fmtWhen } from "../../reference/shared";
import { Kv } from "../../admin/parts";
import { formatPct, formatRate, shortDate } from "../format";
import { AmFilter } from "../RateManagerPage";
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
          market cost {formatRate(r.oldCost)} → {formatRate(r.newCost)} {r.currency}
        </span>
        {r.urgent && <span className="chip-mini tone-error">Urgent</span>}
        <span className="fb-spacer" />
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
              <th>AM</th>
              <th className="num">Sell</th>
              <th className="num">Margin now</th>
              <th className="num">At new cost</th>
              <th className="num">Msgs 7d</th>
              <th className="num">Notice</th>
              <th className="num">Suggested</th>
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

function SettingsDialog({ done }: { done: (v: null) => void }) {
  const q = useMarketSettings();
  const save = useSaveMarketSettings();
  const rules = useAutoRules();
  const saveRule = useSaveAutoRule();
  const digest = useSendDigest();
  const [d, setD] = useState<MarketMoveSettings | null>(null);
  const s = d ?? q.data ?? null;
  const [ent, setEnt] = useState<number | null>(null);
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
            {num("cheapestN", "Cheapest N vendors count")}
            <label className="toggle-inline">
              <input
                type="checkbox"
                checked={s.includeTier1}
                onChange={(e) => setD({ ...s, includeTier1: e.target.checked })}
              />
              Tier 1 vendors count too
            </label>
            {num("windowDays", "Dates within (days)")}
            {num("minVendors", "At least N vendors")}
            {num("minChangePct", "Moving by at least (%)", 0.5)}
            {num("lookbackDays", "Look back (days)")}
            {num("urgentChangePct", "Urgent: increase ≥ (%)", 0.5)}
            {num("urgentDays", "Urgent: starting within (days)")}
            {num("targetMarginPct", "Target margin for suggestions (%)", 0.5)}
            {num("digestHour", "Daily digest at (UTC hour)")}
          </div>
          <h3 className="part-title">Auto-apply rules</h3>
          <p className="muted small">
            Follow market moves automatically for a client: re-price when the margin at the new cost falls below the
            minimum, from the move's date or the client's notice period, whichever is later. Each re-price is one
            undoable change.
          </p>
          <ul className="mm-rules">
            {rules.data?.rules.map((r) => (
              <AutoRuleRow key={r.id} rule={r} />
            ))}
            {rules.data && !rules.data.rules.length && <li className="muted small">No rules yet.</li>}
          </ul>
          <div className="bulk-row">
            <ListLookup<{ id: number; name: string }>
              list="enterprises"
              value={ent}
              fixed={[{ field: "type", op: "in", values: ["customer", "both"] }]}
              onChange={(r) => setEnt(r?.id ?? null)}
              labelOf={(r) => r.name}
              placeholder="Client…"
            />
            <label className="toggle-inline">
              keep margin ≥
              <input className="mm-num" type="number" value={min} onChange={(e) => setMin(e.target.value)} /> %
            </label>
            <label className="toggle-inline">
              <input type="checkbox" checked={both} onChange={(e) => setBoth(e.target.checked)} /> decreases too
            </label>
            <Button
              small
              disabled={!ent || saveRule.isPending}
              onClick={() =>
                saveRule.mutate(
                  {
                    id: null,
                    body: {
                      enterpriseId: ent,
                      categoryId: null,
                      direction: both ? "both" : "increases",
                      minMarginPct: Number(min),
                      status: "active",
                    },
                  },
                  { onSuccess: () => setEnt(null), onError: fail },
                )
              }
            >
              Add rule
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}

export function MarketMovesPage() {
  const scan = useScanMoves();
  return (
    <ListScreen<MarketMoveRow>
      list="market_moves"
      page={page}
      noSelection
      historyScope={null}
      initialState={{ columns: { state: { field: "state", op: "in", values: ["open"] } } }}
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
        <Button icon="gauge" onClick={() => void ask<null>((done) => <SettingsDialog done={done} />)}>
          Settings
        </Button>
      }
      toolbar={(state, setState) => {
        const c = state.columns.amUserId;
        return (
          <AmFilter
            value={c ? Number(c.value) : null}
            onChange={(id) => {
              const columns = { ...state.columns };
              if (id === null) delete columns.amUserId;
              else columns.amUserId = { field: "amUserId", op: "eq", value: id };
              setState({ ...state, columns });
            }}
          />
        );
      }}
      columns={{
        country: { width: 140 },
        network: { width: 170 },
        mccmnc: { width: 80, align: "right" },
        direction: { width: 70, render: (r) => (r.direction === "up" ? "↑ Up" : "↓ Down") },
        avgChangePct: { width: 100, align: "right", render: (r) => arrow(r) },
        movedCount: {
          width: 90,
          align: "right",
          render: (r) => (
            <span className="num">
              {r.movedCount} of {r.topCount}
            </span>
          ),
        },
        firstEffective: { width: 110, render: (r) => shortDate(r.firstEffective) },
        newCost: {
          width: 180,
          align: "right",
          render: (r) => (
            <span className="num">
              {formatRate(r.oldCost)} → {formatRate(r.newCost)}
            </span>
          ),
        },
        affectedClients: { width: 80, align: "right" },
        volume7d: {
          width: 90,
          align: "right",
          render: (r) => <span className="num">{r.volume7d.toLocaleString("en-US")}</span>,
        },
        urgent: { width: 80, render: (r) => (r.urgent ? <span className="chip-mini tone-error">Urgent</span> : "") },
        state: {
          width: 110,
          render: (r) => (
            <span>
              <StatusDot tone={STATE_TONE[r.state]} /> {STATE_LABEL[r.state]}
            </span>
          ),
        },
        detectedAt: { width: 160, render: (r) => fmtWhen(r.detectedAt) },
      }}
      rowClass={(r) => (r.urgent && r.state === "open" ? "row-alert" : undefined)}
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
      shortcuts="↑↓ move · the account manager filter keeps moves for that AM's clients"
    />
  );
}
