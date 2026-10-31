// Advanced LCR (§13.23): one page with three views (Client view removed, team trial round 8) kept in the tab URL (?view=).
// - LCR table: every vendor trunk for a destination ranked by cost (or a quality-weighted score), at
//   a point in time, with a profile's filters and picks, and a what-if.
// - Profiles: named rule sets reused by Least cost route rules.
// - Changes: top vendor changes and cheapest cost moves, with the alert settings.
import { HoverList } from "../../../ui/HoverList";
import { useMemo, useState } from "react";
import { useLocation } from "react-router";
import { useQuery } from "@tanstack/react-query";
import type {
  LcrChangeRow,
  LcrProfileInput,
  LcrProfileRow,
  LcrQuery,
  LcrRow,
  LcrWeights,
} from "@sms/contract";
import {
  useLcrAlertSettings,
  useLcrProfile,
  useLcrTable,
  useSaveLcrAlertSettings,
  useSaveLcrProfile,
} from "../../../api/lcr";
import { useNotifySaved } from "../../../history/undo";
import { pageForPath } from "../../../nav/registry";
import { ListScreen } from "../../../page/ListScreen";
import { PageHeader } from "../../../page/PageHeader";
import { ListLookup } from "../../../records/parts";
import { usePageStatus, useTabNavigate } from "../../../shell/tabContext";
import { ask, toast } from "../../../ui/feedback";
import { Button, Modal, StatusDot } from "../../../ui/primitives";
import { QualityPct } from "../../../ui/quality";
import { VirtualTable, type VColumn } from "../../lookup/VirtualTable";
import { scopeUrl } from "../../rates/bulkModel";
import { formatPct, formatRate, shortDate } from "../../rates/format";
import { fmtWhen } from "../../reference/shared";
import { problemText } from "../dialogs";
import {
  blankProfile,
  isView,
  lcrCsv,
  nextMonday,
  profileProblems,
  rulesForDestination,
  VIEWS,
  type LcrView,
} from "./lcrModel";
import { DateTimeInput } from "../../../ui/DateTimeInput";
import { CheckList, type CheckItem } from "../../../ui/CheckList";
import { fetchPickPage } from "../../../api/hooks";

const page = pageForPath("/routing/lcr")!;
const fail = (e: unknown) => toast({ tone: "error", message: problemText(e) });
const num = (v: number | null, d = 1) => (v === null ? "—" : v.toFixed(d));

function useLcrNav() {
  const location = useLocation();
  const navigate = useTabNavigate();
  const params = new URLSearchParams(location.search);
  const raw = params.get("view");
  const view: LcrView = isView(raw) ? raw : "table";
  return {
    view,
    params,
    go: (next: LcrView, extra: Record<string, string> = {}) => {
      const p = new URLSearchParams({ view: next, ...extra });
      navigate(`/routing/lcr?${p.toString()}`, { replace: true });
    },
    set: (key: string, value: string | null) => {
      const p = new URLSearchParams(location.search);
      if (value === null || value === "") p.delete(key);
      else p.set(key, value);
      navigate(`/routing/lcr?${p.toString()}`, { replace: true });
    },
  };
}

function ViewSwitch() {
  const { view, go } = useLcrNav();
  return (
    <div className="rm-trunk">
      <div className="segmented small" role="radiogroup" aria-label="LCR view">
        {VIEWS.map((v) => (
          <button
            key={v.key}
            type="button"
            role="radio"
            aria-checked={view === v.key}
            className={view === v.key ? "on" : ""}
            onClick={() => go(v.key)}
          >
            {v.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------- LCR table

function WeightsEditor({ value, onChange }: { value: LcrWeights; onChange: (w: LcrWeights) => void }) {
  return (
    <div className="lcr-weights">
      {(["cost", "asr", "dlr", "delay"] as const).map((k) => (
        <label key={k} className="toggle-inline">
          {k === "cost" ? "Cost" : k === "delay" ? "Delay" : k.toUpperCase()}
          <input
            className="mm-num"
            type="number"
            min={0}
            max={100}
            value={value[k]}
            onChange={(e) => onChange({ ...value, [k]: Number(e.target.value) || 0 })}
          />
        </label>
      ))}
    </div>
  );
}

function TableView() {
  const { params, set } = useLcrNav();
  const navigate = useTabNavigate();
  const mccmnc = params.get("mccmnc") ?? "";
  const at = params.get("at");
  const profileId = params.get("profile") ? Number(params.get("profile")) : null;
  const [weighted, setWeighted] = useState(false);
  const [weights, setWeights] = useState<LcrWeights>({ cost: 60, asr: 10, dlr: 25, delay: 5 });
  const [remove, setRemove] = useState<number[]>([]);
  const [rates, setRates] = useState<{ vendorTrunkId: number; rate: number }[]>([]);
  const [offerTrunk, setOfferTrunk] = useState<number | null>(null);
  const [offerRate, setOfferRate] = useState("");
  const body: LcrQuery | null = mccmnc
    ? {
        mccmnc,
        at: at ?? null,
        profileId,
        ...(weighted ? { qualityWeighted: true, weights } : {}),
        ...(remove.length || rates.length ? { whatIf: { remove, rates } } : {}),
      }
    : null;
  const q = useLcrTable(body);
  const t = q.data;
  usePageStatus({
    rows: t
      ? `${t.rows.length} vendor trunks · ${t.rows.filter((r) => r.rank !== null).length} eligible · as of ${t.at.slice(0, 16).replace("T", " ")} UTC`
      : mccmnc
        ? "Loading…"
        : "Choose a destination",
    shortcuts: `Costs in ${t?.currency ?? "the platform currency"} · QBR quality per vendor and destination`,
  });
  const toggleRemove = (id: number) =>
    setRemove(remove.includes(id) ? remove.filter((x) => x !== id) : [...remove, id]);
  const columns: VColumn<LcrRow>[] = [
    {
      key: "rank",
      header: "#",
      width: 64,
      sticky: true,
      align: "right",
      render: (r) =>
        r.rank === null ? (
          <span className="muted">—</span>
        ) : (
          <span
            className="num strong"
            title={r.baselineRank !== null && r.baselineRank !== r.rank ? `was ${r.baselineRank}` : undefined}
          >
            {r.rank}
            {r.baselineRank !== null && r.baselineRank !== r.rank && (
              <span className={r.rank < r.baselineRank ? "tone-good small" : "tone-error small"}>
                {" "}
                {r.rank < r.baselineRank ? "↑" : "↓"}
              </span>
            )}
          </span>
        ),
    },
    {
      key: "trunk",
      header: "Vendor trunk",
      width: 190,
      sticky: true,
      render: (r) => (
        <span title={r.vendor}>
          {r.vendorTrunk}
          {r.whatIf && <span className="chip-mini tone-warning">{r.whatIf}</span>}
        </span>
      ),
    },
    { key: "vendor", header: "Vendor", width: 180, render: (r) => r.vendor },
    { key: "tier", header: "Tier", width: 64, render: (r) => r.tier.replace("tier", "T") },
    {
      key: "cost",
      header: "Cost",
      width: 92,
      align: "right",
      render: (r) => <span className="num strong">{formatRate(r.cost)}</span>,
    },
    {
      key: "rate",
      header: "Rate",
      width: 110,
      align: "right",
      render: (r) => (
        <span className="num">
          {formatRate(r.rate)} <span className="muted small">{r.currency}</span>
        </span>
      ),
    },
    { key: "from", header: "Since", width: 100, render: (r) => shortDate(r.effectiveFrom) },
    {
      key: "next",
      header: "Scheduled",
      width: 150,
      render: (r) =>
        r.nextRate !== null ? (
          <span className={r.nextRate > r.rate ? "tone-warning" : undefined}>
            {formatRate(r.nextRate)} from {shortDate(r.nextFrom)}
          </span>
        ) : (
          <span className="muted">—</span>
        ),
    },
    { key: "asr", header: "ASR", width: 64, align: "right", render: (r) => <QualityPct value={r.asr} suffix="" /> },
    { key: "dlr", header: "DLR", width: 64, align: "right", render: (r) => <QualityPct value={r.dlr} suffix="" /> },
    { key: "delay", header: "Delay s", width: 70, align: "right", render: (r) => num(r.delayS) },
    {
      key: "tps",
      header: "TPS / limit",
      width: 100,
      align: "right",
      render: (r) => (
        <span className={r.atLimit ? "tone-error" : undefined}>
          {r.tpsNow === null ? "—" : r.tpsNow} / {r.tpsLimit ?? "—"}
        </span>
      ),
    },
    {
      key: "routed",
      header: "Routed now",
      width: 92,
      align: "right",
      render: (r) => (r.routedNow ? <span className="strong">{r.routedNow}</span> : <span className="muted">0</span>),
    },
    { key: "score", header: "Score", width: 70, align: "right", render: (r) => num(r.score) },
    {
      key: "pick",
      header: "Used",
      width: 80,
      render: (r) =>
        r.pick ? <span className="tone-good strong">{r.share !== null ? `${r.share} %` : "yes"}</span> : "",
    },
    {
      key: "excluded",
      header: "Left out",
      width: 180,
      render: (r) => <span className="muted">{r.excluded ?? ""}</span>,
    },
    {
      key: "act",
      header: "What-if",
      width: 90,
      render: (r) =>
        r.whatIf === "added" ? null : (
          <button type="button" className="link small" onClick={() => toggleRemove(r.vendorTrunkId)}>
            {remove.includes(r.vendorTrunkId) ? "Put back" : "Remove"}
          </button>
        ),
    },
  ];
  return (
    <div className="page lcr-page">
      <PageHeader
        page={page}
        actions={
          <>
            <Button icon="download" disabled={!t} onClick={() => t && download(`lcr-${t.mccmnc}.csv`, lcrCsv(t))}>
              Export
            </Button>
            <Button
              icon="route"
              disabled={!mccmnc}
              title="Route Rules for this destination; Bulk edit › Apply LCR profile"
              onClick={() => navigate(rulesForDestination(mccmnc), { newTab: true })}
            >
              Apply to route rules
            </Button>
            <Button
              variant="primary"
              icon="tag"
              disabled={!mccmnc}
              title="Bulk rating for this destination: set client rates from cost + margin"
              onClick={() => navigate(scopeUrl({ mccmncs: [mccmnc] }), { newTab: true, title: "Bulk rating" })}
            >
              Price clients from LCR
            </Button>
          </>
        }
      />
      <ViewSwitch />
      <div className="lcr-controls">
        <div className="field">
          <span>Destination</span>
          <ListLookup<{ id: number; mccmnc: string; network: string; country: string }>
            list="destinations"
            value={null}
            onChange={(r) => {
              if (!r) return;
              setRemove([]);
              setRates([]);
              set("mccmnc", r.mccmnc);
            }}
            labelOf={(r) => `${r.country} · ${r.network} (${r.mccmnc})`}
            placeholder={t ? `${t.country} · ${t.network} (${t.mccmnc})` : "Find a destination…"}
          />
        </div>
        {/* Laptop screens (team trial round 12): Now / Next Monday on the date line, profile and ranking together. */}
        <div className="field">
          <span>Point in time (UTC)</span>
          <div className="bulk-row lcr-line">
            <DateTimeInput
              value={at ? at.slice(0, 16) : ""}
              onChange={(e) => set("at", e.target.value ? new Date(`${e.target.value}:00Z`).toISOString() : null)}
            />
            <Button small variant="ghost" onClick={() => set("at", null)}>
              Now
            </Button>
            <Button small variant="ghost" onClick={() => set("at", nextMonday().toISOString())}>
              Next Monday
            </Button>
          </div>
        </div>
        <div className="field">
          <span>LCR profile and ranking</span>
          <div className="bulk-row lcr-line lcr-profile">
            <ListLookup<{ id: number; name: string }>
              list="lcr_profiles"
              value={profileId}
              onChange={(r) => set("profile", r ? String(r.id) : null)}
              labelOf={(r) => r.name}
              placeholder="None: rank every vendor"
            />
            <label className="toggle-inline">
              <input type="checkbox" checked={weighted} onChange={(e) => setWeighted(e.target.checked)} />{" "}
              Quality-weighted score
            </label>
          </div>
        </div>
        {weighted && (
          <div className="lcr-weights-row">
            <WeightsEditor value={weights} onChange={setWeights} />
          </div>
        )}
      </div>
      <div className="lcr-whatif bulk-row">
        <strong>What-if</strong>
        {remove.map((id) => (
          <span key={id} className="chip">
            without {t?.rows.find((r) => r.vendorTrunkId === id)?.vendorTrunk ?? `#${id}`}
            <button type="button" aria-label="Put back" onClick={() => toggleRemove(id)}>
              ×
            </button>
          </span>
        ))}
        {rates.map((x) => (
          <span key={x.vendorTrunkId} className="chip">
            {t?.rows.find((r) => r.vendorTrunkId === x.vendorTrunkId)?.vendorTrunk ?? `#${x.vendorTrunkId}`} at {x.rate}
            <button type="button" aria-label="Remove" onClick={() => setRates(rates.filter((y) => y !== x))}>
              ×
            </button>
          </span>
        ))}
        <ListLookup<{ id: number; name: string }>
          list="vendor_trunks"
          value={offerTrunk}
          onChange={(r) => setOfferTrunk(r?.id ?? null)}
          labelOf={(r) => r.name}
          placeholder="Vendor (new rate or offer)…"
        />
        <input
          className="mm-num lcr-rate"
          type="number"
          step="any"
          placeholder={`cost ${t?.currency ?? ""}`}
          value={offerRate}
          onChange={(e) => setOfferRate(e.target.value)}
        />
        <Button
          small
          disabled={!offerTrunk || !offerRate || !mccmnc}
          onClick={() => {
            setRates([
              ...rates.filter((x) => x.vendorTrunkId !== offerTrunk),
              { vendorTrunkId: offerTrunk!, rate: Number(offerRate) },
            ]);
            setOfferTrunk(null);
            setOfferRate("");
          }}
        >
          Add
        </Button>
        {(remove.length > 0 || rates.length > 0) && (
          <Button
            small
            variant="ghost"
            onClick={() => {
              setRemove([]);
              setRates([]);
            }}
          >
            Clear what-if
          </Button>
        )}
      </div>
      {t?.impact && (
        <div className="stat-cards compact">
          <div className="stat-card">
            <span className="stat-label">Routes that change</span>
            <span className={`stat-value${t.impact.routesChanged ? " tone-warning" : ""}`}>
              {t.impact.routesChanged}
            </span>
            <span className="muted small">of {t.impact.clientLines} client trunks selling it</span>
          </div>
          <div className="stat-card">
            <span className="stat-label">Messages (7 days)</span>
            <span className="stat-value">{t.impact.messages7d.toLocaleString("en-US")}</span>
          </div>
          <div className="stat-card">
            <span className="stat-label">Cost change (7 days)</span>
            <span className={`stat-value${t.impact.costChange7d > 0 ? " tone-error" : ""}`}>
              {t.impact.costChange7d > 0 ? "+" : ""}
              {t.impact.costChange7d.toFixed(2)}
            </span>
            <span className="muted small">{t.currency}</span>
          </div>
          <div className="stat-card">
            <span className="stat-label">Margin change (7 days)</span>
            <span
              className={`stat-value${t.impact.marginChange7d < 0 ? " tone-error" : t.impact.marginChange7d > 0 ? " tone-good" : ""}`}
            >
              {t.impact.marginChange7d > 0 ? "+" : ""}
              {t.impact.marginChange7d.toFixed(2)}
            </span>
            <HoverList
              items={t.impact.changes.map((c) => `${c.customerTrunk}: ${c.from ?? "—"} → ${c.to ?? "—"}`)}
              heading="Client trunks whose vendor changes"
            >
              <span className="muted small">
                {t.impact.changes
                  .slice(0, 2)
                  .map((c) => `${c.customerTrunk}: ${c.from ?? "—"} → ${c.to ?? "—"}`)
                  .join(" · ")}
                {t.impact.changes.length > 2 ? ` +${t.impact.changes.length - 2}` : ""}
              </span>
            </HoverList>
          </div>
        </div>
      )}
      {q.isError && <div className="grid-message error">{problemText(q.error)}</div>}
      {mccmnc ? (
        <VirtualTable<LcrRow>
          label="LCR table"
          rows={t?.rows ?? []}
          columns={columns}
          rowKey={(r) => String(r.vendorTrunkId)}
          rowClass={(r) => (r.rank === null ? "inactive" : r.pick && t?.profile ? "lcr-pick" : undefined)}
          empty={q.isPending ? "Loading…" : "No vendor has a rate for this destination"}
        />
      ) : (
        <div className="grid-message muted bulk-empty">Choose a destination to see its vendors ranked by cost.</div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- profiles

function ProfileDialog({ id, done }: { id: number | null; done: (v: boolean | null) => void }) {
  const existing = useLcrProfile(id);
  const save = useSaveLcrProfile();
  const notifySaved = useNotifySaved();
  const [draft, setDraft] = useState<LcrProfileInput | null>(null);
  const base: LcrProfileInput | null = id === null ? blankProfile() : existing.data ? strip(existing.data) : null;
  const p = draft ?? base;
  if (!p) return null;
  const setP = (patch: Partial<LcrProfileInput>) => setDraft({ ...p, ...patch });
  const problems = profileProblems(p);
  const pct = (k: "minAsr" | "minDlr" | "maxDelayS" | "maxRate", label: string, step = 1) => (
    <label className="field">
      <span>{label}</span>
      <input
        type="number"
        step={step}
        placeholder="any"
        value={p[k] ?? ""}
        onChange={(e) => setP({ [k]: e.target.value === "" ? null : Number(e.target.value) })}
      />
    </label>
  );
  return (
    <Modal
      title={id === null ? "New LCR profile" : `LCR profile · ${p.name}`}
      width={760}
      onClose={() => done(null)}
      footer={
        <>
          <Button onClick={() => done(null)}>Cancel</Button>
          <Button
            variant="primary"
            disabled={Object.keys(problems).length > 0 || save.isPending}
            onClick={() =>
              save.mutate(
                { id, input: p },
                {
                  onSuccess: (r) => {
                    if (r.change) notifySaved(r.change, `Saved ${r.record.name}`);
                    done(true);
                  },
                  onError: fail,
                },
              )
            }
          >
            Save
          </Button>
        </>
      }
    >
      <div className="rn-form-grid">
        <label className="field">
          <span>Name</span>
          <input autoFocus value={p.name} maxLength={120} onChange={(e) => setP({ name: e.target.value })} />
          {problems.name && <small className="tone-error">{problems.name}</small>}
        </label>
        <label className="field">
          <span>Status</span>
          <select value={p.status} onChange={(e) => setP({ status: e.target.value as LcrProfileInput["status"] })}>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </select>
        </label>
        <label className="field rn-span">
          <span>Description</span>
          <input
            value={p.description ?? ""}
            maxLength={500}
            onChange={(e) => setP({ description: e.target.value || null })}
          />
        </label>
        <label className="field">
          <span>Vendor trunks</span>
          <select
            value={p.vendorTrunkMode}
            onChange={(e) => setP({ vendorTrunkMode: e.target.value as LcrProfileInput["vendorTrunkMode"] })}
          >
            <option value="all">All</option>
            <option value="inclusive">Only these</option>
            <option value="exclusive">All but these</option>
          </select>
        </label>
        {p.vendorTrunkMode !== "all" && (
          <div className="field rn-span">
            <span>{p.vendorTrunkMode === "inclusive" ? "Only" : "Never"} these vendor trunks</span>
            {/* Vendor trunks as checkboxes, Check all / Uncheck all on the searched ones (team trial round 2). */}
            <VendorTrunkChecks ids={p.vendorTrunkIds} onChange={(ids) => setP({ vendorTrunkIds: ids })} />
            {problems.vendorTrunkIds && <small className="tone-error">{problems.vendorTrunkIds}</small>}
          </div>
        )}
        <div className="field">
          <span>Tiers allowed</span>
          <div className="bulk-row">
            {(["tier1", "tier2", "tier3"] as const).map((t) => (
              <label key={t} className="toggle-inline">
                <input
                  type="checkbox"
                  checked={p.tiers.includes(t)}
                  onChange={(e) => setP({ tiers: e.target.checked ? [...p.tiers, t] : p.tiers.filter((x) => x !== t) })}
                />
                {t.replace("tier", "Tier ")}
              </label>
            ))}
          </div>
          <small className="muted">None ticked = all tiers</small>
        </div>
        {pct("minAsr", "Minimum ASR %")}
        {pct("minDlr", "Minimum DLR %")}
        {pct("maxDelayS", "Maximum delay (s)", 0.5)}
        {pct("maxRate", "Maximum cost (platform currency)", 0.0001)}
        <label className="field">
          <span>Vendors to use (1–10)</span>
          <input
            type="number"
            min={1}
            max={10}
            value={p.vendorCount}
            onChange={(e) => setP({ vendorCount: Math.min(10, Math.max(1, Number(e.target.value) || 1)) })}
          />
        </label>
        <label className="field">
          <span>Split</span>
          <select
            value={p.split}
            onChange={(e) => {
              const split = e.target.value as LcrProfileInput["split"];
              setP({
                split,
                shares: split === "percentage" ? evenShares(p.vendorCount) : [],
              });
            }}
          >
            <option value="top_down">Top-down</option>
            <option value="percentage">Percentage</option>
          </select>
        </label>
        {p.split === "percentage" && (
          <div className="field rn-span">
            <span>Shares per position (%)</span>
            <div className="bulk-row">
              {Array.from({ length: p.vendorCount }, (_, i) => (
                <input
                  key={i}
                  className="mm-num"
                  type="number"
                  min={0}
                  max={100}
                  aria-label={`Share ${i + 1}`}
                  value={p.shares[i] ?? 0}
                  onChange={(e) => {
                    const shares = Array.from({ length: p.vendorCount }, (_, j) => p.shares[j] ?? 0);
                    shares[i] = Number(e.target.value) || 0;
                    setP({ shares });
                  }}
                />
              ))}
            </div>
            {problems.shares && <small className="tone-error">{problems.shares}</small>}
          </div>
        )}
        <label className="field">
          <span>Tie-breaker</span>
          <select
            value={p.tieBreaker}
            onChange={(e) => setP({ tieBreaker: e.target.value as LcrProfileInput["tieBreaker"] })}
          >
            <option value="quality">Better DLR first</option>
            <option value="cost">Lower cost first</option>
          </select>
        </label>
        <label className="toggle-inline">
          <input
            type="checkbox"
            checked={p.excludeAtTpsLimit}
            onChange={(e) => setP({ excludeAtTpsLimit: e.target.checked })}
          />
          Leave out vendors at their TPS limit
        </label>
        <label className="toggle-inline rn-span">
          <input
            type="checkbox"
            checked={p.qualityWeighted}
            onChange={(e) => setP({ qualityWeighted: e.target.checked })}
          />
          Rank by the quality-weighted score
        </label>
        {p.qualityWeighted && (
          <div className="field rn-span">
            <span>Weights</span>
            <WeightsEditor value={p.weights} onChange={(weights) => setP({ weights })} />
          </div>
        )}
      </div>
    </Modal>
  );
}

/** Shares that add up to 100, the first positions taking the remainder. */
const evenShares = (n: number) => Array.from({ length: n }, (_, i) => Math.floor(100 / n) + (i < 100 % n ? 1 : 0));

const strip = (r: LcrProfileRow): LcrProfileInput => {
  const { id: _i, ruleCount: _r, updatedBy: _u, updatedAt: _a, archivedAt: _d, ...rest } = r;
  return rest;
};

function ProfilesView() {
  const edit = (id: number | null) => void ask<boolean>((done) => <ProfileDialog id={id} done={done} />);
  return (
    <ListScreen<LcrProfileRow>
      list="lcr_profiles"
      page={page}
      above={<ViewSwitch />}
      noSelection
      historyScope={{ entityTypes: ["lcr_profile"] }}
      primary={{ label: "New profile", onClick: () => edit(null) }}
      rowActions={(r) => [{ label: "Edit", icon: "file", main: true, onSelect: () => edit(r.id) }]}
      columns={{
        name: { width: 240, render: (r) => <strong>{r.name}</strong> },
        status: {
          width: 100,
          render: (r) => (
            <span>
              <StatusDot tone={r.status === "active" ? "good" : "neutral"} />{" "}
              {r.status === "active" ? "Active" : "Inactive"}
            </span>
          ),
        },
        vendorCount: { width: 110, align: "right" },
        split: {
          width: 150,
          render: (r) => (r.split === "percentage" ? `Percentage ${r.shares.join("/")}` : "Top-down"),
        },
        minDlr: { width: 90, align: "right", render: (r) => formatPct(r.minDlr) },
        qualityWeighted: { width: 130, render: (r) => (r.qualityWeighted ? "Score" : "Cost") },
        // Pointing at the count lists the route rules using the profile (team trial round 1).
        ruleCount: {
          width: 80,
          align: "right",
          render: (r) =>
            r.ruleCount ? (
              <HoverList items={r.ruleNames} more={r.ruleCount - r.ruleNames.length} heading="Route rules">
                <span className="num">{r.ruleCount}</span>
              </HoverList>
            ) : (
              <span className="muted">—</span>
            ),
        },
        vendorScope: {
          width: 160,
          render: (r) => (
            <HoverList
              items={r.vendorScopeNames}
              heading={r.vendorScope.startsWith("All but") ? "All vendors except:" : undefined}
            >
              <span>{r.vendorScope}</span>
            </HoverList>
          ),
        },
        updatedBy: { width: 140 },
        updatedAt: { width: 160, render: (r) => fmtWhen(r.updatedAt) },
      }}
      onOpen={(r) => edit(r.id)}
      shortcuts="Enter or double-click: edit · route rules of type Least cost pick a profile"
    />
  );
}

// ---------------------------------------------------------------- changes

function AlertSettingsDialog({ done }: { done: (v: null) => void }) {
  const q = useLcrAlertSettings();
  const save = useSaveLcrAlertSettings();
  const [d, setD] = useState<typeof q.data | null>(null);
  const s = d ?? q.data;
  if (!s) return null;
  return (
    <Modal
      title="LCR change alerts"
      onClose={() => done(null)}
      footer={
        <>
          <Button onClick={() => done(null)}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!d || save.isPending}
            onClick={() => d && save.mutate(d, { onSuccess: () => done(null), onError: fail })}
          >
            Save
          </Button>
        </>
      }
    >
      <label className="toggle-inline">
        <input type="checkbox" checked={s.enabled} onChange={(e) => setD({ ...s, enabled: e.target.checked })} /> Check
        every 15 minutes
      </label>
      <label className="toggle-inline">
        <input type="checkbox" checked={s.topChanged} onChange={(e) => setD({ ...s, topChanged: e.target.checked })} />{" "}
        When the top LCR vendor changes
      </label>
      <label className="field">
        <span>When the cheapest cost moves by more than (%)</span>
        <input
          type="number"
          min={0.1}
          step={0.5}
          value={s.costMovePct}
          onChange={(e) => setD({ ...s, costMovePct: Number(e.target.value) })}
        />
      </label>
    </Modal>
  );
}

function ChangesView() {
  const { go } = useLcrNav();
  const navigate = useTabNavigate();
  return (
    <ListScreen<LcrChangeRow>
      list="lcr_changes"
      page={page}
      above={<ViewSwitch />}
      noSelection
      historyScope={null}
      // Read-only: the one row action is the linked market move, like the link in the row.
      rowActions={(r) => [
        {
          label: "Market move",
          icon: "trending",
          main: true,
          disabled: !r.marketMoveId,
          hint: r.marketMoveId ? `Market move #${r.marketMoveId}` : "No market move linked",
          onSelect: () => navigate("/rates/market-moves", { newTab: true }),
        },
      ]}
      actions={
        <Button icon="bell" onClick={() => void ask<null>((done) => <AlertSettingsDialog done={done} />)}>
          Alert settings
        </Button>
      }
      columns={{
        detectedAt: { width: 160, render: (r) => fmtWhen(r.detectedAt) },
        country: { width: 140 },
        network: { width: 170 },
        mccmnc: { width: 80, align: "right" },
        kind: {
          width: 170,
          render: (r) => (r.kind === "top_changed" ? "Top vendor changed" : "Cheapest cost moved"),
        },
        oldVendor: { width: 160 },
        newVendor: { width: 160 },
        oldCost: { width: 90, align: "right", render: (r) => formatRate(r.oldCost) },
        newCost: { width: 90, align: "right", render: (r) => formatRate(r.newCost) },
        changePct: {
          width: 90,
          align: "right",
          render: (r) => (
            <span className={r.changePct !== null && r.changePct > 0 ? "tone-warning" : undefined}>
              {formatPct(r.changePct, true)}
            </span>
          ),
        },
      }}
      trailing={{
        header: "",
        width: 150,
        render: (r) =>
          r.marketMoveId ? (
            <button
              type="button"
              className="link small"
              onClick={(e) => {
                e.stopPropagation();
                navigate("/rates/market-moves", { newTab: true });
              }}
            >
              Market move #{r.marketMoveId}
            </button>
          ) : null,
      }}
      onOpen={(r) => go("table", { mccmnc: r.mccmnc })}
      shortcuts="Enter: open the destination's LCR table"
    />
  );
}

export function LcrPage() {
  const { view } = useLcrNav();
  if (view === "profiles") return <ProfilesView />;
  if (view === "changes") return <ChangesView />;
  return <TableView />;
}

/** Every vendor trunk as a checkbox, searchable by trunk or enterprise name (§13.23, team trial round 2). */
function VendorTrunkChecks({ ids, onChange }: { ids: number[]; onChange: (ids: number[]) => void }) {
  const trunks = useQuery({
    queryKey: ["list", "vendor_trunks", "checklist"],
    queryFn: () =>
      fetchPickPage<{ id: number; name: string; enterpriseName?: string; status?: string }>("vendor_trunks", {
        limit: 4000,
        withTotal: false,
        sort: [{ field: "name", dir: "asc" }],
      }),
    staleTime: 60_000,
  });
  const items = useMemo<CheckItem<number>[]>(
    () =>
      (trunks.data?.rows ?? []).map((t) => ({
        value: t.id,
        label: t.name,
        detail: t.enterpriseName,
        muted: t.status !== undefined && t.status !== "active",
      })),
    [trunks.data],
  );
  if (trunks.isPending) return <div className="muted">Loading vendor trunks…</div>;
  return (
    <CheckList
      items={items}
      selected={ids}
      onChange={onChange}
      label="Vendor trunks"
      placeholder="Search trunk or vendor…"
      height={220}
      autoFocus={false}
    />
  );
}
