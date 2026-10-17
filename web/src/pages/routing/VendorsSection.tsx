// Vendors section of a route rule (§6.3 Route Information, §13.8 vendor capacity, §13.27
// warm-up threshold and number whitelists). Edits stay local until Save, which writes the
// rule once (one undoable change, §13.10).
import { useMemo, useState } from "react";
import type { RouteRuleDetail, RouteRuleInput, RouteVendor, RouteWhitelist, TrunkListRow } from "@sms/contract";
import { useReference } from "../../api/records";
import { ListLookup } from "../../records/parts";
import { Icon } from "../../ui/Icon";
import { Button } from "../../ui/primitives";
import { TrunkPick, type Picked } from "./pickers";
import { ROUTE_TYPES, shareProblems } from "./ruleModel";

type Draft = Pick<
  RouteRuleInput,
  | "routeType"
  | "huntPolicy"
  | "enableBackupRoutes"
  | "maxRouteLevel"
  | "margin"
  | "qbrFormula"
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

export function VendorsSection({
  rule,
  saving,
  onSave,
}: {
  rule: RouteRuleDetail;
  saving: boolean;
  onSave: (patch: Partial<RouteRuleInput>) => Promise<string | null>;
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
            <label className="toggle-inline">
              <input
                type="checkbox"
                checked={!!d.enableBackupRoutes}
                onChange={(e) => set({ enableBackupRoutes: e.target.checked })}
              />
              Backup routes
            </label>
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
              {vendors.map((v, i) => (
                <tr key={i}>
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
                      onChange={(r) => r && setVendor(i, { vendorTrunkId: r.id })}
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
                    <input
                      type="checkbox"
                      aria-label="Backup"
                      checked={!!v.isBackup}
                      onChange={(e) => setVendor(i, { isBackup: e.target.checked })}
                    />
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
                            ? { warmupCount: n, warmupPer: v.warmupPer ?? "rule", warmupReset: v.warmupReset ?? null }
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
                      onClick={() => set({ vendors: vendors.filter((_, j) => j !== i) })}
                    >
                      <Icon name="x" size={13} />
                    </button>
                  </td>
                </tr>
              ))}
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
                <label className="field">
                  <span>QBR formula</span>
                  <input
                    value={d.qbrFormula ?? ""}
                    maxLength={500}
                    placeholder="e.g. 0.6*DLR + 0.3*ASR - 0.1*ADD"
                    onChange={(e) => set({ qbrFormula: e.target.value || null })}
                  />
                </label>
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
        <Button disabled={!dirty || saving} onClick={() => (setD(initial), setError(null))}>
          Revert
        </Button>
        <Button icon="save" disabled={!dirty || saving} onClick={() => void save()}>
          Save vendors
        </Button>
      </div>
    </div>
  );
}
