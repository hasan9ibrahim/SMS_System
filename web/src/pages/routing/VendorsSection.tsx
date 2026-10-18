// Vendors section of a route rule (§6.3 Route Information, §13.8 vendor capacity, §13.27
// warm-up threshold and number whitelists). Edits stay local until Save, which writes the
// rule once (one undoable change, §13.10).
import { Fragment, useMemo, useState } from "react";
import type { RouteRuleDetail, RouteRuleInput, RouteVendor, RouteWhitelist, TrunkListRow } from "@sms/contract";
import { useReference } from "../../api/records";
import { ListLookup } from "../../records/parts";
import { Icon } from "../../ui/Icon";
import { Button } from "../../ui/primitives";
import { TrunkPick, type Picked } from "./pickers";
import { backupProblems, ROUTE_TYPES, routeTypeOf, shareProblems } from "./ruleModel";

type Draft = Pick<
  RouteRuleInput,
  | "routeType"
  | "huntPolicy"
  | "enableBackupRoutes"
  | "maxRouteLevel"
  | "margin"
  | "qbrFormula"
  | "qbrWeights"
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
  qbrFormula: r.qbrFormula,
  qbrWeights: r.qbrWeights ?? null,
  skipVendorAtTpsPct: r.skipVendorAtTpsPct,
  lcrProfileId: r.lcrProfileId ?? null,
  threshold: r.threshold,
  thresholdInterval: r.thresholdInterval,
  vendorCategoryMode: r.vendorCategoryMode,
  vendorCategoryIds: r.vendorCategoryIds,
  vendorTrunkMode: r.vendorTrunkMode,
  vendorTrunkIds: r.vendorTrunkIds,
  vendors: r.vendors,
  whitelists: r.whitelists,
});

const numOrNull = (v: string) => (v === "" ? null : Number(v));

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
  const hunt = { top_down: "Top down (by level)", round_robin: "Round robin", percentage: "Percentage split" }[
    rule.huntPolicy ?? "top_down"
  ];
  return (
    <div className="vendors-view">
      <div className="vv-head">
        <span>
          <span className={`dot dot-${type.tone}`} /> <strong>{type.label}</strong>
        </span>
        {rule.routeType !== "block" && <span className="muted">{hunt}</span>}
        {rule.routeType !== "block" && <span className="muted">max level {rule.maxRouteLevel}</span>}
        {rule.routeType !== "block" && rule.margin !== null && rule.margin !== undefined && (
          <span className="muted">min margin {rule.margin}</span>
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
}: {
  rule: RouteRuleDetail;
  saving: boolean;
  onSave: (patch: Partial<RouteRuleInput>) => Promise<string | null>;
  /** In the popup: Cancel closes it. */
  onCancel?: () => void;
}) {
  const ref = useReference();
  const initial = useMemo(() => draftOf(rule), [rule]);
  const [d, setD] = useState<Draft>(initial);
  const [error, setError] = useState<string | null>(null);
  const dirty = JSON.stringify(d) !== JSON.stringify(initial);
  const set = (patch: Partial<Draft>) => setD((x) => ({ ...x, ...patch }));
  const setVendor = (i: number, patch: Partial<RouteVendor>) =>
    set({ vendors: d.vendors!.map((v, j) => (j === i ? { ...v, ...patch } : v)) });
  const setWhitelist = (i: number, patch: Partial<RouteWhitelist>) =>
    set({ whitelists: d.whitelists!.map((w, j) => (j === i ? { ...w, ...patch } : w)) });
  const vendors = d.vendors ?? [];
  const whitelists = d.whitelists ?? [];
  const block = d.routeType === "block";
  const scoped = d.routeType === "dynamic" || d.routeType === "qbr";
  const vendorName = (id: number) => rule.labels.vendorTrunks.find((v) => v.id === id)?.name ?? `#${id}`;
  const [scopeTrunks, setScopeTrunks] = useState<Picked<number>[]>(
    (rule.vendorTrunkIds ?? []).map((id) => ({ key: id, label: vendorName(id) })),
  );
  const problems = block ? [] : shareProblems(vendors, d.huntPolicy ?? "top_down");

  const save = async () => {
    if (problems.length) return setError(problems.join(" "));
    const bp = backupProblems(vendors, vendorName);
    if (bp.length) return setError(bp.join(" "));
    const w = d.qbrWeights;
    if (d.routeType === "qbr" && w && w.asr + w.dlr + w.delay + w.cost !== 100)
      return setError("The quality weights must add up to 100 %.");
    if (d.routeType === "static" && vendors.length === 0) return setError("A static rule needs at least one vendor.");
    if (vendors.some((v) => !v.vendorTrunkId)) return setError("Choose a vendor trunk on every row.");
    if (whitelists.some((w) => !w.vendorTrunkId || (!w.numbers.length && !w.numberListId)))
      return setError("Each whitelist needs a vendor and numbers or a number list.");
    setError(await onSave({ ...d, vendorTrunkIds: scopeTrunks.map((t) => t.key) }));
  };

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
                {d.huntPolicy === "percentage" && <th className="num">Share %</th>}
                <th>Backup</th>
                <th title="Send the first N messages to this vendor before the normal split (§13.27)">Warm-up first</th>
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
                      {d.huntPolicy === "percentage" && (
                        <td>
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
                                    warmupPer: v.warmupPer ?? "rule",
                                    warmupReset: v.warmupReset ?? null,
                                  }
                                : { warmupCount: null, warmupPer: null, warmupReset: null },
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
                          onChange={(e) =>
                            setVendor(i, { warmupReset: (e.target.value || null) as RouteVendor["warmupReset"] })
                          }
                        >
                          <option value="">Never</option>
                          <option value="hour">Hourly</option>
                          <option value="day">Daily</option>
                          <option value="week">Weekly</option>
                        </select>
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
                        <td colSpan={d.huntPolicy === "percentage" ? 7 : 6}>
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
                    <TrunkPick kind="vendor" value={scopeTrunks} onChange={setScopeTrunks} />
                  )}
                </div>
              </div>
              {d.routeType === "dynamic" && (
                <div className="field">
                  <span>LCR profile (§13.23)</span>
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
                  <small className="muted">
                    The profile filters vendors (tiers, quality, max rate, TPS), orders them and sets how many are used.
                  </small>
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
            <div className="fgrid cols-4">
              <label className="field">
                <span>Minimum margin (flat)</span>
                <input
                  type="number"
                  step={0.0001}
                  value={d.margin}
                  onChange={(e) => set({ margin: Number(e.target.value) || 0 })}
                />
                <small className="muted">Vendors leaving less are skipped</small>
              </label>
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
                <small className="muted">§13.8 vendor capacity</small>
              </label>
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
                  onChange={(e) => set({ thresholdInterval: (e.target.value || null) as Draft["thresholdInterval"] })}
                >
                  <option value="minute">Minute</option>
                  <option value="hour">Hour</option>
                  <option value="day">Day</option>
                </select>
              </label>
            </div>
            <p className="muted small">
              Revenue and cost limits per customer and vendor trunk are set on the trunk page (§13.26).
            </p>
          </fieldset>

          <fieldset className="vf-group">
            <legend>Number whitelists (checked before warm-up and split, §13.27)</legend>
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
        {onCancel ? (
          <Button onClick={onCancel}>Cancel</Button>
        ) : (
          <Button disabled={!dirty || saving} onClick={() => (setD(initial), setError(null))}>
            Revert
          </Button>
        )}
        <Button icon="save" disabled={!dirty || saving} onClick={() => void save()}>
          Save vendors
        </Button>
      </div>
    </div>
  );
}
