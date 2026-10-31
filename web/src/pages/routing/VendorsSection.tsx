// Vendors section of a route rule (§6.3 Route Information, §13.8 vendor capacity, §13.27
// warm-up threshold and number whitelists). Edits stay local until Save, which writes the
// rule once (one undoable change, §13.10).
import { Fragment, useMemo, useRef, useState } from "react";
import type {
  RouteRuleDetail,
  RouteRuleInput,
  RouteVendor,
  RouteVendorCost,
  RouteWhitelist,
  TrunkListRow,
} from "@sms/contract";
import { useResetWarmup, useVendorCosts } from "../../api/routing";
import { useReference } from "../../api/records";
import { ListLookup } from "../../records/parts";
import { Icon } from "../../ui/Icon";
import { toast } from "../../ui/feedback";
import { problemText } from "./dialogs";
import { Button, Menu, Popover } from "../../ui/primitives";
import { TrunkPick, type Picked } from "./pickers";
import { MarginInput } from "./MarginInput";
import {
  backupProblems,
  categoryFilter,
  formatMargin,
  ROUTE_TYPES,
  routeTypeOf,
  shareProblems,
  soleOnLevel,
  withSoleShares,
} from "./ruleModel";

type Draft = Pick<
  RouteRuleInput,
  | "routeType"
  | "huntPolicy"
  | "enableBackupRoutes"
  | "maxRouteLevel"
  | "margin"
  | "marginType"
  | "qbrFormula"
  | "qbrWeights"
  | "percentagePerCustomerTrunk"
  | "skipVendorAtTpsPct"
  | "lcrProfileId"
  | "threshold"
  | "thresholdInterval"
  | "vendorCategoryMode"
  | "vendorCategoryIds"
  | "vendorTrunkMode"
  | "vendorTrunkIds"
  | "vendors"
  | "whitelists"
>;

const draftOf = (r: RouteRuleDetail): Draft => ({
  routeType: r.routeType,
  huntPolicy: r.huntPolicy,
  enableBackupRoutes: r.enableBackupRoutes,
  maxRouteLevel: r.maxRouteLevel,
  margin: r.margin,
  marginType: r.marginType ?? "amount",
  qbrFormula: r.qbrFormula,
  qbrWeights: r.qbrWeights ?? null,
  percentagePerCustomerTrunk: r.percentagePerCustomerTrunk ?? true,
  skipVendorAtTpsPct: r.skipVendorAtTpsPct,
  lcrProfileId: r.lcrProfileId ?? null,
  threshold: r.threshold,
  thresholdInterval: r.thresholdInterval,
  vendorCategoryMode: r.vendorCategoryMode,
  vendorCategoryIds: r.vendorCategoryIds,
  vendorTrunkMode: r.vendorTrunkMode,
  vendorTrunkIds: r.vendorTrunkIds,
  // The Reset time is shown, never saved (team trial round 6).
  vendors: r.vendors.map(({ warmupResetAt: _, ...v }) => v),
  whitelists: r.whitelists,
});

const numOrNull = (v: string) => (v === "" ? null : Number(v));

/** Rates to 6 decimals without trailing zeros. */
const rate = (v: number) => String(Number(v.toFixed(6)));
const span = (min: number, max: number) => (min === max ? rate(min) : `${rate(min)}–${rate(max)}`);

/**
 * A vendor's cost for the rule's destinations (team trial round 4): EUR (the base) first, one figure when flat,
 * else min–max; the vendor's own currency under it when that is not EUR.
 */
export function VendorCost({ cost }: { cost: RouteVendorCost | undefined }) {
  if (!cost) return <span className="muted">…</span>;
  if (cost.minEur === null || cost.maxEur === null || cost.min === null || cost.max === null)
    return (
      <span className="muted" title="No current rate for the rule's destinations">
        no rate
      </span>
    );
  const flat = cost.min === cost.max;
  return (
    <span
      className="vendor-cost"
      title={`${cost.destinations} destination${cost.destinations === 1 ? "" : "s"} with a rate${flat ? " · flat" : ""}`}
    >
      <span className="num strong">€{span(cost.minEur, cost.maxEur)}</span>
      {cost.currency && cost.currency !== "EUR" && (
        <span className="num muted small">
          {cost.currency} {span(cost.min, cost.max)}
        </span>
      )}
    </span>
  );
}

const destOf = (r: Pick<RouteRuleDetail, "mccmncMode" | "mccmncs" | "mccmncPattern">) => ({
  mccmncMode: r.mccmncMode,
  mccmncs: r.mccmncs ?? [],
  mccmncPattern: r.mccmncPattern ?? null,
});

/** Read-only vendors of a rule for the detail panel; editing opens the popup. */
/** Quality (QBR) ranking: the defaults decided 2026-10-18, changeable per rule (team trial round 1). */
const QBR_DEFAULT = { asr: 35, dlr: 35, delay: 20, cost: 10 };
const QBR_PARTS = [
  { key: "asr", label: "ASR" },
  { key: "dlr", label: "DLR" },
  { key: "delay", label: "Delay" },
  { key: "cost", label: "Cost" },
] as const;

export function VendorsView({ rule, onEdit }: { rule: RouteRuleDetail; onEdit: (() => void) | null }) {
  const name = (id: number) => rule.labels.vendorTrunks.find((v) => v.id === id)?.name ?? `#${id}`;
  const type = routeTypeOf(rule.routeType);
  // Each vendor followed by its own backups; rule-wide backups last.
  const all = rule.vendors ?? [];
  const primaries = all.filter((v) => !v.isBackup).sort((a, b) => a.level - b.level);
  const vendors = [
    ...primaries.flatMap((p) => [p, ...all.filter((b) => b.isBackup && b.backupForVendorTrunkId === p.vendorTrunkId)]),
    ...all.filter((b) => b.isBackup && !b.backupForVendorTrunkId),
  ];
  const costs = useVendorCosts(
    all.map((v) => v.vendorTrunkId),
    destOf(rule),
  );
  const hunt = { top_down: "Top down (by level)", round_robin: "Round robin", percentage: "Percentage split" }[
    rule.huntPolicy ?? "top_down"
  ];
  return (
    <div className="vendors-view">
      <div className="vv-head">
        <span>
          <span className={`dot dot-${type.tone}`} /> <strong>{type.label}</strong>
        </span>
        {rule.routeType !== "block" && (
          <span className="muted">
            {hunt}
            {rule.huntPolicy === "percentage" && rule.percentagePerCustomerTrunk ? ", per customer trunk" : ""}
          </span>
        )}
        {rule.routeType !== "block" && <span className="muted">max level {rule.maxRouteLevel}</span>}
        {rule.routeType !== "block" && rule.margin !== null && rule.margin !== undefined && (
          <span className="muted">min margin {formatMargin(rule.margin, rule.marginType)}</span>
        )}
        <span className="fb-spacer" />
        {onEdit ? (
          <Button icon="route" onClick={onEdit}>
            Edit vendors…
          </Button>
        ) : (
          <span className="muted">Restore the rule to edit its vendors.</span>
        )}
      </div>
      {rule.routeType === "block" ? (
        <p className="muted">This rule blocks the traffic; it has no vendors.</p>
      ) : vendors.length === 0 ? (
        <p className="muted">
          {rule.routeType === "static"
            ? "No vendors yet."
            : `Vendors are picked by ${type.label.toLowerCase()} from ${(rule.vendorTrunkIds ?? []).length || "all"} vendor trunks.`}
        </p>
      ) : (
        <table className="vf-table vv-table">
          <thead>
            <tr>
              <th>Level</th>
              <th>Vendor trunk</th>
              <th className="num" title="Cost for the rule's destinations: EUR, and the vendor's currency">
                Cost
              </th>
              <th className="num">Share</th>
              <th>Backup</th>
              <th>Warm-up</th>
            </tr>
          </thead>
          <tbody>
            {vendors.map((v, i) => (
              <tr key={i} className={v.isBackup ? "muted" : ""}>
                <td className="num">{v.level}</td>
                <td className="strong">{name(v.vendorTrunkId)}</td>
                <td className="num">
                  <VendorCost cost={costs.get(v.vendorTrunkId)} />
                </td>
                <td className="num">{v.sharePct === null || v.sharePct === undefined ? "—" : `${v.sharePct}%`}</td>
                <td>
                  {v.backupForVendorTrunkId ? `for ${name(v.backupForVendorTrunkId)}` : v.isBackup ? "last resort" : ""}
                </td>
                <td>{v.warmupCount ? `${v.warmupCount} per ${v.warmupPer ?? "day"}` : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {(rule.whitelists ?? []).length > 0 && (
        <p className="muted small">
          {(rule.whitelists ?? []).length} number whitelist{(rule.whitelists ?? []).length === 1 ? "" : "s"} (see Edit
          vendors)
        </p>
      )}
    </div>
  );
}

/** A backup row standing in for one vendor (team trial round 1): same level, takes its traffic when it fails. */
const backupOf = (v: RouteVendor, share = 100): RouteVendor => ({
  level: v.level,
  vendorTrunkId: 0,
  sharePct: share,
  isBackup: true,
  backupForVendorTrunkId: v.vendorTrunkId,
  warmupCount: null,
  warmupPer: null,
  warmupReset: null,
});

export function VendorsSection({
  rule,
  saving,
  onSave,
  onCancel,
  bind,
}: {
  rule: RouteRuleDetail;
  saving: boolean;
  onSave?: (patch: Partial<RouteRuleInput>) => Promise<string | null>;
  /** In the popup: Cancel closes it. */
  onCancel?: () => void;
  /** New rule (team trial round 6): no button of its own; the window's one Save collects the patch. */
  bind?: (collect: () => Partial<RouteRuleInput> | string) => void;
}) {
  const ref = useReference();
  const initial = useMemo(() => draftOf(rule), [rule]);
  const [d, setD] = useState<Draft>(initial);
  const [error, setError] = useState<string | null>(null);
  const dirty = JSON.stringify(d) !== JSON.stringify(initial);
  const set = (patch: Partial<Draft>) => setD((x) => ({ ...x, ...patch }));
  const [marginOk, setMarginOk] = useState(true);
  // Limits (team trial round 2): Minimum margin always; the others when set or added with "+ Add limit".
  const [limits, setLimits] = useState<Set<"skip" | "cap">>(
    () =>
      new Set([...(rule.skipVendorAtTpsPct ? (["skip"] as const) : []), ...(rule.threshold ? (["cap"] as const) : [])]),
  );
  const addLimitRef = useRef<HTMLButtonElement>(null);
  const [addLimitOpen, setAddLimitOpen] = useState(false);
  const setVendor = (i: number, patch: Partial<RouteVendor>) =>
    set({ vendors: d.vendors!.map((v, j) => (j === i ? { ...v, ...patch } : v)) });
  const setWhitelist = (i: number, patch: Partial<RouteWhitelist>) =>
    set({ whitelists: d.whitelists!.map((w, j) => (j === i ? { ...w, ...patch } : w)) });
  const vendors = d.vendors ?? [];
  const whitelists = d.whitelists ?? [];
  const costs = useVendorCosts(
    vendors.map((v) => v.vendorTrunkId),
    destOf(rule),
  );
  const block = d.routeType === "block";
  const scoped = d.routeType === "dynamic" || d.routeType === "qbr";
  const vendorName = (id: number) => rule.labels.vendorTrunks.find((v) => v.id === id)?.name ?? `#${id}`;
  const [scopeTrunks, setScopeTrunks] = useState<Picked<number>[]>(
    (rule.vendorTrunkIds ?? []).map((id) => ({ key: id, label: vendorName(id) })),
  );
  const problems = block ? [] : shareProblems(vendors, d.huntPolicy ?? "top_down");

  // The vendors' patch, or what is wrong with them.
  const check = (): Partial<RouteRuleInput> | string => {
    if (problems.length) return problems.join(" ");
    const bp = backupProblems(vendors, vendorName);
    if (bp.length) return bp.join(" ");
    const w = d.qbrWeights;
    if (d.routeType === "qbr" && w && w.asr + w.dlr + w.delay + w.cost !== 100)
      return "The quality weights must add up to 100 %.";
    if (d.routeType === "static" && vendors.length === 0) return "A static rule needs at least one vendor.";
    if (vendors.some((v) => !v.vendorTrunkId)) return "Choose a vendor trunk on every row.";
    if (whitelists.some((w) => !w.vendorTrunkId || (!w.numbers.length && !w.numberListId)))
      return "Each whitelist needs a vendor and numbers or a number list.";
    if (!marginOk) return "Minimum margin: a number, with % for a percentage.";
    return {
      ...d,
      vendors: withSoleShares(vendors, d.huntPolicy ?? "top_down"),
      vendorTrunkIds: scopeTrunks.map((t) => t.key),
    };
  };
  const save = async () => {
    const p = check();
    if (typeof p === "string") return setError(p);
    setError((await onSave?.(p)) ?? null);
  };
  bind?.(() => {
    if (!dirty) return {};
    const p = check();
    setError(typeof p === "string" ? p : null);
    return p;
  });

  return (
    <div className="vendors-form">
      <div className="vf-row">
        <div className="field">
          <span>Route type</span>
          <div className="segmented" role="radiogroup" aria-label="Route type">
            {ROUTE_TYPES.map((t) => (
              <button
                key={t.value}
                type="button"
                role="radio"
                aria-checked={d.routeType === t.value}
                className={d.routeType === t.value ? "on" : ""}
                onClick={() => set({ routeType: t.value, ...(t.value === "dynamic" ? {} : { lcrProfileId: null }) })}
              >
                <span className={`dot dot-${t.tone}`} /> {t.label}
              </button>
            ))}
          </div>
        </div>
        {!block && (
          <>
            <label className="field">
              <span>Hunt policy</span>
              <select value={d.huntPolicy} onChange={(e) => set({ huntPolicy: e.target.value as Draft["huntPolicy"] })}>
                <option value="top_down">Top down (by level)</option>
                <option value="round_robin">Round robin</option>
                <option value="percentage">Percentage split</option>
              </select>
            </label>
            <label className="field narrow">
              <span>Max route level</span>
              <input
                type="number"
                min={1}
                max={10}
                value={d.maxRouteLevel}
                onChange={(e) => set({ maxRouteLevel: Math.max(1, Math.min(10, Number(e.target.value) || 1)) })}
              />
            </label>
            {d.huntPolicy === "percentage" && (
              <label
                className="toggle-inline"
                title="On: every customer trunk's own traffic is split by the shares. Off: the shares apply to the rule's total traffic."
              >
                <input
                  type="checkbox"
                  checked={!!d.percentagePerCustomerTrunk}
                  onChange={(e) => set({ percentagePerCustomerTrunk: e.target.checked })}
                />
                Split per customer trunk
              </label>
            )}
            {/* The rule-level "Backup routes" switch had no effect and was removed (team trial round 1);
                a vendor ticked Backup is used only when every other vendor is rejected. */}
          </>
        )}
      </div>

      {block ? (
        <p className="muted">Matching messages are rejected. No vendor is used.</p>
      ) : (
        <>
          <table className="vf-table">
            <thead>
              <tr>
                <th>Level</th>
                <th>Vendor trunk</th>
                <th className="num" title="Cost for the rule's destinations: EUR, and the vendor's currency">
                  Cost
                </th>
                {d.huntPolicy === "percentage" && <th className="num">Share %</th>}
                <th>Backup</th>
                <th title="Send the first N messages to this vendor before the normal split">Warm-up first</th>
                <th>Counted per</th>
                <th>Resets</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {vendors.map((v, i) => {
                if (v.isBackup && v.backupForVendorTrunkId) return null;
                const own = vendors
                  .map((b, j) => ({ b, j }))
                  .filter(({ b }) => b.isBackup && !!v.vendorTrunkId && b.backupForVendorTrunkId === v.vendorTrunkId);
                return (
                  <Fragment key={i}>
                    <tr>
                      <td>
                        <select
                          value={v.level}
                          aria-label="Level"
                          onChange={(e) => setVendor(i, { level: Number(e.target.value) })}
                        >
                          {Array.from({ length: d.maxRouteLevel ?? 1 }, (_, k) => k + 1).map((l) => (
                            <option key={l} value={l}>
                              {l}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="vf-vendor">
                        <ListLookup<TrunkListRow>
                          list="vendor_trunks"
                          value={v.vendorTrunkId || null}
                          clearable={false}
                          onChange={(r) =>
                            r &&
                            set({
                              // Its own backups follow the vendor it stands in for.
                              vendors: vendors.map((x, j) =>
                                j === i
                                  ? { ...x, vendorTrunkId: r.id }
                                  : x.isBackup && x.backupForVendorTrunkId === v.vendorTrunkId && v.vendorTrunkId
                                    ? { ...x, backupForVendorTrunkId: r.id }
                                    : x,
                              ),
                            })
                          }
                          labelOf={(r) => r.name}
                          detailOf={(r) => `${r.enterpriseName} · ${r.category ?? ""}`}
                          placeholder="Vendor trunk…"
                        />
                      </td>
                      <td className="num">
                        {v.vendorTrunkId ? <VendorCost cost={costs.get(v.vendorTrunkId)} /> : null}
                      </td>
                      {d.huntPolicy === "percentage" && (
                        <td>
                          {soleOnLevel(vendors, v) ? (
                            // Alone on its level it takes everything: no share to type (team trial round 12).
                            <span className="muted num" title="The only vendor on this level takes all of it">
                              100%
                            </span>
                          ) : (
                            <input
                              className="num w-num"
                              type="number"
                              min={0}
                              max={100}
                              aria-label="Share %"
                              value={v.sharePct ?? ""}
                              disabled={v.isBackup}
                              onChange={(e) => setVendor(i, { sharePct: numOrNull(e.target.value) })}
                            />
                          )}
                        </td>
                      )}
                      <td>
                        {v.isBackup ? (
                          // An older rule-wide backup: the last resort after every level.
                          <label className="toggle-inline small" title="Tried last, after every level">
                            <input type="checkbox" checked onChange={() => setVendor(i, { isBackup: false })} />
                            last resort
                          </label>
                        ) : (
                          <input
                            type="checkbox"
                            aria-label="Backups for this vendor"
                            title={
                              v.vendorTrunkId
                                ? "Vendors that take this vendor's traffic when it fails"
                                : "Choose the vendor first"
                            }
                            disabled={!v.vendorTrunkId}
                            checked={own.length > 0}
                            onChange={(e) =>
                              set({
                                vendors: e.target.checked
                                  ? [...vendors, backupOf(v)]
                                  : vendors.filter(
                                      (x) => !(x.isBackup && x.backupForVendorTrunkId === v.vendorTrunkId),
                                    ),
                              })
                            }
                          />
                        )}
                      </td>
                      <td>
                        <input
                          className="num w-num"
                          type="number"
                          min={1}
                          placeholder="off"
                          aria-label="Warm-up messages"
                          value={v.warmupCount ?? ""}
                          onChange={(e) => {
                            const n = numOrNull(e.target.value);
                            setVendor(
                              i,
                              n
                                ? {
                                    warmupCount: n,
                                    // Defaults (team trial round 6): counted per customer trunk, reset daily.
                                    warmupPer: v.warmupPer ?? "customer_trunk",
                                    warmupReset: v.warmupReset ?? "day",
                                  }
                                : { warmupCount: null, warmupPer: null, warmupReset: null, warmupResetHours: null },
                            );
                          }}
                        />
                      </td>
                      <td>
                        <select
                          aria-label="Warm-up counted per"
                          disabled={!v.warmupCount}
                          value={v.warmupPer ?? ""}
                          onChange={(e) =>
                            setVendor(i, { warmupPer: (e.target.value || null) as RouteVendor["warmupPer"] })
                          }
                        >
                          <option value="rule">Rule</option>
                          <option value="customer_trunk">Customer trunk</option>
                        </select>
                      </td>
                      <td>
                        <select
                          aria-label="Warm-up resets"
                          disabled={!v.warmupCount}
                          value={v.warmupReset ?? ""}
                          onChange={(e) => {
                            const r = (e.target.value || null) as RouteVendor["warmupReset"];
                            setVendor(i, {
                              warmupReset: r,
                              warmupResetHours: r === "custom" ? (v.warmupResetHours ?? 12) : null,
                            });
                          }}
                        >
                          <option value="">Never</option>
                          <option value="hour">Hourly</option>
                          <option value="day">Daily</option>
                          <option value="week">Weekly</option>
                          <option value="custom">Every … hours</option>
                        </select>
                        {/* Custom reset period (team trial round 2), 1–8760 hours. */}
                        {v.warmupReset === "custom" && (
                          <input
                            className="num w-num"
                            type="number"
                            min={1}
                            max={8760}
                            step={1}
                            aria-label="Warm-up reset hours"
                            title="Reset the warm-up count every this many hours"
                            value={v.warmupResetHours ?? ""}
                            onChange={(e) => setVendor(i, { warmupResetHours: numOrNull(e.target.value) })}
                          />
                        )}
                        {v.warmupCount ? <WarmupReset rule={rule} vendorTrunkId={v.vendorTrunkId} /> : null}
                      </td>
                      <td>
                        <button
                          type="button"
                          className="icon-btn"
                          aria-label="Remove vendor"
                          onClick={() =>
                            set({
                              vendors: vendors.filter(
                                (x, j) =>
                                  j !== i &&
                                  !(x.isBackup && v.vendorTrunkId && x.backupForVendorTrunkId === v.vendorTrunkId),
                              ),
                            })
                          }
                        >
                          <Icon name="x" size={13} />
                        </button>
                      </td>
                    </tr>
                    {own.length > 0 && (
                      <tr className="vf-backups">
                        <td />
                        <td colSpan={d.huntPolicy === "percentage" ? 8 : 7}>
                          <div className="vf-backup-list">
                            <span className="muted small">Backups for this vendor (share of its traffic):</span>
                            {own.map(({ b, j }) => (
                              <span key={j} className="vf-backup">
                                <ListLookup<TrunkListRow>
                                  list="vendor_trunks"
                                  value={b.vendorTrunkId || null}
                                  clearable={false}
                                  onChange={(r) => r && setVendor(j, { vendorTrunkId: r.id })}
                                  labelOf={(r) => r.name}
                                  detailOf={(r) => `${r.enterpriseName} · ${r.category ?? ""}`}
                                  placeholder="Backup vendor…"
                                />
                                {b.vendorTrunkId ? <VendorCost cost={costs.get(b.vendorTrunkId)} /> : null}
                                <input
                                  className="num w-num"
                                  type="number"
                                  min={0}
                                  max={100}
                                  aria-label="Backup share %"
                                  value={b.sharePct ?? ""}
                                  onChange={(e) => setVendor(j, { sharePct: numOrNull(e.target.value) })}
                                />
                                %
                                <button
                                  type="button"
                                  className="icon-btn"
                                  aria-label="Remove backup"
                                  onClick={() => set({ vendors: vendors.filter((_, k) => k !== j) })}
                                >
                                  <Icon name="x" size={12} />
                                </button>
                              </span>
                            ))}
                            <button
                              type="button"
                              className="link small"
                              disabled={own.length >= 5}
                              onClick={() => set({ vendors: [...vendors, backupOf(v, 0)] })}
                            >
                              + Add backup
                            </button>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
              {vendors.length === 0 && (
                <tr>
                  <td colSpan={8} className="muted">
                    {scoped
                      ? "No fixed vendors: the vendors in scope below are ranked by cost or quality."
                      : "No vendors yet."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          <div className="vf-actions">
            <Button
              small
              icon="plus"
              disabled={vendors.length >= 50}
              onClick={() =>
                set({
                  vendors: [
                    ...vendors,
                    {
                      level: 1,
                      vendorTrunkId: 0,
                      sharePct: d.huntPolicy === "percentage" ? 0 : null,
                      isBackup: false,
                      warmupCount: null,
                      warmupPer: null,
                      warmupReset: null,
                    },
                  ],
                })
              }
            >
              Add vendor
            </Button>
            {problems.map((p) => (
              <span key={p} className="tone-warning small">
                {p}
              </span>
            ))}
          </div>

          {scoped && (
            <fieldset className="vf-group">
              <legend>Vendors in scope ({d.routeType === "qbr" ? "ranked by quality" : "cheapest first"})</legend>
              <div className="fgrid cols-2">
                <div className="field">
                  <span>Vendor categories</span>
                  <select
                    value={d.vendorCategoryMode}
                    onChange={(e) => set({ vendorCategoryMode: e.target.value as Draft["vendorCategoryMode"] })}
                  >
                    <option value="all">All categories</option>
                    <option value="inclusive">Only these</option>
                    <option value="exclusive">All but these</option>
                  </select>
                  {d.vendorCategoryMode !== "all" && (
                    <div className="check-grid">
                      {ref.data?.productCategories.map((c) => (
                        <label key={c.id} className="toggle-inline">
                          <input
                            type="checkbox"
                            checked={d.vendorCategoryIds?.includes(c.id) ?? false}
                            onChange={(e) =>
                              set({
                                vendorCategoryIds: e.target.checked
                                  ? [...(d.vendorCategoryIds ?? []), c.id]
                                  : (d.vendorCategoryIds ?? []).filter((x) => x !== c.id),
                              })
                            }
                          />
                          {c.name}
                        </label>
                      ))}
                    </div>
                  )}
                </div>
                <div className="field">
                  <span>Vendor trunks</span>
                  <select
                    value={d.vendorTrunkMode}
                    onChange={(e) => set({ vendorTrunkMode: e.target.value as Draft["vendorTrunkMode"] })}
                  >
                    <option value="all">All trunks</option>
                    <option value="inclusive">Only these</option>
                    <option value="exclusive">All but these</option>
                  </select>
                  {d.vendorTrunkMode !== "all" && (
                    <TrunkPick
                      kind="vendor"
                      value={scopeTrunks}
                      onChange={setScopeTrunks}
                      fixed={categoryFilter(d.vendorCategoryMode ?? "all", d.vendorCategoryIds ?? [])}
                    />
                  )}
                </div>
              </div>
              {d.routeType === "dynamic" && (
                <div className="field">
                  <span>LCR profile</span>
                  <ListLookup<{ id: number; name: string; vendorCount: number; split: string }>
                    list="lcr_profiles"
                    value={d.lcrProfileId ?? null}
                    onChange={(p) => set({ lcrProfileId: p?.id ?? null })}
                    labelOf={(p) => p.name}
                    detailOf={(p) =>
                      `${p.vendorCount} vendor${p.vendorCount === 1 ? "" : "s"} · ${p.split === "percentage" ? "percentage" : "top-down"}`
                    }
                    placeholder="None: the cheapest vendors in scope"
                  />
                </div>
              )}
              {d.routeType === "qbr" && (
                <div className="field wide">
                  <span>Quality ranking weights (%)</span>
                  <span className="qbr-weights">
                    {QBR_PARTS.map((p) => (
                      <label key={p.key} className="toggle-inline">
                        {p.label}
                        <input
                          type="number"
                          min={0}
                          max={100}
                          value={(d.qbrWeights ?? QBR_DEFAULT)[p.key]}
                          onChange={(e) =>
                            set({
                              qbrWeights: {
                                ...(d.qbrWeights ?? QBR_DEFAULT),
                                [p.key]: Math.max(0, Math.min(100, Number(e.target.value) || 0)),
                              },
                            })
                          }
                        />
                      </label>
                    ))}
                    {d.qbrWeights && (
                      <button type="button" className="link" onClick={() => set({ qbrWeights: null })}>
                        Back to defaults
                      </button>
                    )}
                  </span>
                  {(() => {
                    const w = d.qbrWeights ?? QBR_DEFAULT;
                    const sum = w.asr + w.dlr + w.delay + w.cost;
                    return sum === 100 ? (
                      <small className="muted">
                        {d.qbrWeights ? "Custom for this rule" : "Defaults: ASR 35 · DLR 35 · delay 20 · cost 10"}
                      </small>
                    ) : (
                      <small className="tone-error">The weights add up to {sum} %; they must make 100 %.</small>
                    );
                  })()}
                </div>
              )}
            </fieldset>
          )}

          <fieldset className="vf-group">
            <legend>Limits</legend>
            <div className="fgrid cols-4 limits-grid">
              <MarginInput
                label="Minimum margin"
                value={d.margin}
                type={d.marginType}
                onValid={setMarginOk}
                onChange={(m) => set({ margin: m.value ?? 0, marginType: m.type })}
              />
              {limits.has("skip") && (
                <label className="field">
                  <span>Skip vendor at % of its TPS</span>
                  <input
                    type="number"
                    min={1}
                    max={100}
                    placeholder="off"
                    value={d.skipVendorAtTpsPct ?? ""}
                    onChange={(e) => set({ skipVendorAtTpsPct: numOrNull(e.target.value) })}
                  />
                </label>
              )}
              {limits.has("cap") && (
                <>
                  <label className="field">
                    <span>Volume cap (messages)</span>
                    <input
                      type="number"
                      min={1}
                      placeholder="off"
                      value={d.threshold ?? ""}
                      onChange={(e) => {
                        const n = numOrNull(e.target.value);
                        set({ threshold: n, thresholdInterval: n ? (d.thresholdInterval ?? "day") : null });
                      }}
                    />
                  </label>
                  <label className="field">
                    <span>per</span>
                    <select
                      disabled={!d.threshold}
                      value={d.thresholdInterval ?? ""}
                      onChange={(e) =>
                        set({ thresholdInterval: (e.target.value || null) as Draft["thresholdInterval"] })
                      }
                    >
                      <option value="minute">Minute</option>
                      <option value="hour">Hour</option>
                      <option value="day">Day</option>
                    </select>
                  </label>
                </>
              )}
            </div>
            {limits.size < 2 && (
              <>
                <button
                  ref={addLimitRef}
                  type="button"
                  className="btn btn-sm btn-add-filter"
                  onClick={() => setAddLimitOpen((v) => !v)}
                >
                  <Icon name="plus" size={13} /> Add limit
                </button>
                <Popover anchor={addLimitRef} open={addLimitOpen} onClose={() => setAddLimitOpen(false)}>
                  <Menu
                    onClose={() => setAddLimitOpen(false)}
                    items={[
                      ...(limits.has("skip")
                        ? []
                        : [
                            {
                              label: "Skip vendor at % of its TPS",
                              onSelect: () => setLimits(new Set([...limits, "skip" as const])),
                            },
                          ]),
                      ...(limits.has("cap")
                        ? []
                        : [
                            {
                              label: "Volume cap (messages per minute, hour or day)",
                              onSelect: () => setLimits(new Set([...limits, "cap" as const])),
                            },
                          ]),
                    ]}
                  />
                </Popover>
              </>
            )}
          </fieldset>

          <fieldset className="vf-group">
            <legend>Number whitelists</legend>
            {whitelists.map((w, i) => (
              <div key={i} className="wl-row">
                <div className="field">
                  <span>Always to vendor</span>
                  <ListLookup<TrunkListRow>
                    list="vendor_trunks"
                    value={w.vendorTrunkId || null}
                    clearable={false}
                    onChange={(r) => r && setWhitelist(i, { vendorTrunkId: r.id })}
                    labelOf={(r) => r.name}
                    placeholder="Vendor trunk…"
                  />
                </div>
                <label className="field grow">
                  <span>Numbers ({w.numbers.length}), one per line</span>
                  <textarea
                    rows={2}
                    value={w.numbers.join("\n")}
                    onChange={(e) =>
                      setWhitelist(i, {
                        numbers: e.target.value
                          .split(/[\s,;]+/)
                          .map((x) => x.trim())
                          .filter((x) => /^[0-9]{1,15}$/.test(x)),
                      })
                    }
                  />
                </label>
                <label className="field">
                  <span>or number list</span>
                  <select
                    value={w.numberListId ?? ""}
                    onChange={(e) => setWhitelist(i, { numberListId: numOrNull(e.target.value) })}
                  >
                    <option value="">—</option>
                    {ref.data?.numberLists.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label="Remove whitelist"
                  onClick={() => set({ whitelists: whitelists.filter((_, j) => j !== i) })}
                >
                  <Icon name="x" size={13} />
                </button>
              </div>
            ))}
            <Button
              small
              icon="plus"
              disabled={whitelists.length >= 20}
              onClick={() =>
                set({
                  whitelists: [
                    ...whitelists,
                    { vendorTrunkId: vendors[0]?.vendorTrunkId ?? 0, numbers: [], numberListId: null },
                  ],
                })
              }
            >
              Add whitelist
            </Button>
          </fieldset>
        </>
      )}
      <div className="vf-save">
        {error && <span className="error-text">{error}</span>}
        <span className="fb-spacer" />
        {!bind &&
          (onCancel ? (
            <Button onClick={onCancel}>Cancel</Button>
          ) : (
            <Button disabled={!dirty || saving} onClick={() => (setD(initial), setError(null))}>
              Revert
            </Button>
          ))}
        {!bind && (
          <Button icon="save" disabled={!dirty || saving} onClick={() => void save()}>
            Save vendors
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * Reset (team trial round 6, §13.27): starts the vendor's warm-up count again from 0 now. Saving or editing the rule
 * never does; only this and the reset period. Works on the saved rule, so a vendor added since the last save waits.
 */
function WarmupReset({ rule, vendorTrunkId }: { rule: RouteRuleDetail; vendorTrunkId: number }) {
  const reset = useResetWarmup();
  const saved = rule.vendors.find((x) => x.vendorTrunkId === vendorTrunkId && x.warmupCount);
  const at = saved?.warmupResetAt;
  return (
    <button
      type="button"
      className="icon-btn"
      aria-label="Reset warm-up count"
      disabled={!saved || reset.isPending}
      title={
        !saved
          ? "Save first, then reset the count"
          : `Start the warm-up count again now${at ? ` (last reset ${new Date(at).toLocaleString("en-GB")})` : ""}`
      }
      onClick={() =>
        reset.mutate(
          { id: rule.id, vendorTrunkId },
          {
            onSuccess: () => toast({ tone: "good", message: "Warm-up count started again" }),
            onError: (e) => toast({ tone: "error", message: problemText(e) }),
          },
        )
      }
    >
      <Icon name="refresh" size={13} />
    </button>
  );
}
