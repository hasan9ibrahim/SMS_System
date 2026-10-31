// Rule Test (§15.4) and the Route Simulator dialog (§6.3): run a sample number through
// one rule, or through all rules in priority order, and show the decision step by step.
import { useState } from "react";
import type {
  EgressSkip,
  RouteDecision,
  RouteSimulation,
  RouteTestRequest,
  TranslationTestResult,
  TrunkListRow,
} from "@sms/contract";
import { ApiError } from "../../api/client";
import { simulateRoute, testRouteRule } from "../../api/routing";
import { ListLookup } from "../../records/parts";
import { Icon } from "../../ui/Icon";
import { Button, Modal, StatusDot } from "../../ui/primitives";
import { formatRate } from "../rates/format";

const OUTCOME: Record<RouteDecision["outcome"], { label: string; tone: "good" | "warning" | "error" | "neutral" }> = {
  route: { label: "Routed", tone: "good" },
  block: { label: "Blocked by the rule", tone: "error" },
  no_vendor: { label: "No vendor available", tone: "warning" },
  not_matched: { label: "Rule does not match", tone: "neutral" },
};

const DECIDED: Record<string, string> = {
  whitelist: "number whitelist",
  warmup: "warm-up threshold",
  percentage: "percentage split",
  top_down: "top down",
  round_robin: "round robin",
  lcr: "least cost",
  qbr: "quality score",
};

function TestForm({
  value,
  onChange,
  onRun,
  running,
  autoFocus,
}: {
  value: RouteTestRequest;
  onChange: (v: RouteTestRequest) => void;
  onRun: () => void;
  running: boolean;
  /** Only in the dialog: in the detail panel focus stays on the grid for its shortcuts. */
  autoFocus?: boolean;
}) {
  const set = (patch: Partial<RouteTestRequest>) => {
    const next: Record<string, unknown> = { ...value, ...patch };
    for (const k of Object.keys(next)) if (next[k] === undefined || next[k] === "") delete next[k];
    onChange(next as unknown as RouteTestRequest);
  };
  const n = (v: string) => (v === "" ? undefined : Number(v));
  return (
    <form
      className="test-form"
      onSubmit={(e) => {
        e.preventDefault();
        onRun();
      }}
    >
      <div className="fgrid cols-4">
        <label className="field">
          <span>
            Receiver number<span className="req">*</span>
          </span>
          <input
            autoFocus={autoFocus}
            value={value.receiver}
            inputMode="numeric"
            placeholder="61412345678"
            onChange={(e) => set({ receiver: e.target.value.replace(/\D/g, "") })}
          />
        </label>
        <div className="field">
          <span>Customer trunk</span>
          <ListLookup<TrunkListRow>
            list="customer_trunks"
            value={value.customerTrunkId ?? null}
            onChange={(r) => set({ customerTrunkId: r?.id })}
            labelOf={(r) => r.name}
            detailOf={(r) => r.enterpriseName}
            placeholder="Any trunk…"
          />
        </div>
        <label className="field">
          <span>Sender</span>
          <input value={value.sender ?? ""} maxLength={20} onChange={(e) => set({ sender: e.target.value })} />
        </label>
        <label className="field">
          <span>MCCMNC (after HLR)</span>
          <input
            value={value.mccmnc ?? ""}
            maxLength={6}
            placeholder="from the number"
            onChange={(e) => set({ mccmnc: e.target.value.replace(/\D/g, "") })}
          />
        </label>
        <label className="field span-2">
          <span>Content</span>
          <input value={value.content ?? ""} maxLength={1600} onChange={(e) => set({ content: e.target.value })} />
        </label>
        <label className="field">
          <span>HLR ported</span>
          <select
            value={value.hlrPorted === undefined ? "" : String(value.hlrPorted)}
            onChange={(e) => set({ hlrPorted: e.target.value === "" ? undefined : e.target.value === "true" })}
          >
            <option value="">Unknown</option>
            <option value="true">Ported</option>
            <option value="false">Not ported</option>
          </select>
        </label>
        <label className="field">
          <span>Live TPS</span>
          <input type="number" min={0} value={value.tps ?? ""} onChange={(e) => set({ tps: n(e.target.value) })} />
        </label>
        <label className="field">
          <span>Revenue/msg</span>
          <input
            type="number"
            min={0}
            step={0.001}
            placeholder="from the rate"
            value={value.revenuePerMessage ?? ""}
            onChange={(e) => set({ revenuePerMessage: n(e.target.value) })}
          />
        </label>
        <label className="field">
          <span>Revenue so far</span>
          <input
            type="number"
            min={0}
            step={0.01}
            value={value.accumulatedRevenue ?? ""}
            onChange={(e) => set({ accumulatedRevenue: n(e.target.value) })}
          />
        </label>
        <label className="field">
          <span>Warm-up sent</span>
          <input
            type="number"
            min={0}
            value={value.warmupSent ?? ""}
            onChange={(e) => set({ warmupSent: n(e.target.value) })}
          />
        </label>
        <div className="field test-run">
          <span>&nbsp;</span>
          <Button type="submit" icon="play" disabled={running || !/^[0-9]{5,15}$/.test(value.receiver)}>
            Run
          </Button>
        </div>
      </div>
    </form>
  );
}

function DecisionView({ d, skipped = [] }: { d: RouteDecision; skipped?: EgressSkip[] | undefined }) {
  const o = OUTCOME[d.outcome];
  return (
    <div className="decision">
      <div className="decision-head">
        <StatusDot tone={o.tone} />
        <strong>{o.label}</strong>
        {d.vendor && (
          <span>
            → <strong>{d.vendor.name}</strong> <span className="muted">level {d.vendor.level}</span>{" "}
            <span className="tag">{DECIDED[d.vendor.decidedBy] ?? d.vendor.decidedBy}</span>
          </span>
        )}
        <span className="fb-spacer" />
        <span className="muted small">
          {d.mccmnc ?? "no destination"}
          {d.destination ? ` · ${d.destination}` : ""}
          {d.sellRate !== null ? ` · sell ${formatRate(d.sellRate)}` : ""}
        </span>
      </div>
      <ul className="checks">
        {d.checks.map((c, i) => (
          <li key={i} className={c.ok ? "ok" : "fail"}>
            <Icon name={c.ok ? "check" : "x"} size={13} />
            <span className="strong">{c.condition}</span>
            <span className="muted">{c.detail}</span>
          </li>
        ))}
      </ul>
      {d.candidates.length > 0 && (
        <table className="mini-table">
          <thead>
            <tr>
              <th>Level</th>
              <th>Vendor</th>
              <th className="num">Cost</th>
              <th className="num">Margin</th>
              <th>Note</th>
            </tr>
          </thead>
          <tbody>
            {d.candidates.map((c) => (
              <tr
                key={`${c.level}-${c.vendorTrunkId}`}
                className={d.vendor?.vendorTrunkId === c.vendorTrunkId ? "chosen" : ""}
              >
                <td className="num">{c.level}</td>
                <td>{c.name}</td>
                <td className="num">{formatRate(c.cost)}</td>
                <td className={`num${c.margin !== null && c.margin < 0 ? " tone-error" : ""}`}>
                  {formatRate(c.margin)}
                </td>
                <td className="muted">{c.note ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {skipped.length > 0 && (
        // Vendors passed over because their own vendor translation rules block the message (decided 2026-10-18).
        <div className="egress-skipped">
          <strong className="small">Vendors skipped</strong>
          <ul className="checks">
            {skipped.map((x) => (
              <li key={x.vendorTrunkId} className="fail">
                <Icon name="x" size={13} />
                <span className="strong">{x.vendorTrunk}</span>
                <span className="muted">
                  blocked by its vendor translation rule{" "}
                  {x.result.steps
                    .filter((st) => st.blocked)
                    .map((st) => st.name)
                    .join(", ")}{" "}
                  — the next vendor was tried
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// The message names each field's problem in plain words (api/problems.ts).
const errText = (e: unknown) => (e instanceof ApiError ? e.message : String(e));

/**
 * What the customer trunk's ingress translation did before the rules were tried (team trial round 12): each rule
 * that changed the message, field by field, or blocked it.
 */
function IngressView({ ingress }: { ingress: TranslationTestResult | null | undefined }) {
  if (!ingress) return null;
  const fired = ingress.steps.filter((s) => s.matched && (s.changes.length > 0 || s.blocked));
  return (
    <div className={`sim-ingress${ingress.blocked ? " blocked" : ""}`}>
      <strong>Ingress translation</strong>{" "}
      {ingress.blocked ? (
        <span className="tone-error">blocked the message: the switch would reject it</span>
      ) : fired.length ? (
        <span className="muted">the rules were tried on the translated message</span>
      ) : (
        <span className="muted">no rule changed the message</span>
      )}
      {fired.length > 0 && (
        <ul>
          {fired.map((s) => (
            <li key={s.ruleId}>
              #{s.ruleId} {s.name}
              {s.blocked
                ? ": blocked"
                : `: ${s.changes.map((c) => `${c.field} “${c.before ?? ""}” → “${c.after ?? ""}”`).join(", ")}`}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The Test section of one rule. */
export function TestSection({ ruleId, trunkId }: { ruleId: number; trunkId: number | null }) {
  const [req, setReq] = useState<RouteTestRequest>({ receiver: "", ...(trunkId ? { customerTrunkId: trunkId } : {}) });
  const [result, setResult] = useState<RouteDecision | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      setResult(await testRouteRule(ruleId, req));
    } catch (e) {
      setError(errText(e));
    } finally {
      setRunning(false);
    }
  };
  return (
    <div className="test-section">
      <TestForm value={req} onChange={setReq} onRun={() => void run()} running={running} />
      {error && <p className="error-text">{error}</p>}
      {result && <IngressView ingress={result.ingress} />}
      {result && <DecisionView d={result} skipped={result.egressSkipped} />}
    </div>
  );
}

/** Route Simulator: all active rules in priority order, up to the deciding one. */
export function SimulateDialog({ onClose, onOpenRule }: { onClose: () => void; onOpenRule: (id: number) => void }) {
  const [req, setReq] = useState<RouteTestRequest>({ receiver: "" });
  const [result, setResult] = useState<RouteSimulation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [showSkipped, setShowSkipped] = useState(false);
  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      setResult(await simulateRoute(req));
    } catch (e) {
      setError(errText(e));
    } finally {
      setRunning(false);
    }
  };
  return (
    <Modal title="Route simulator" width={880} onClose={onClose}>
      <TestForm value={req} onChange={setReq} onRun={() => void run()} running={running} autoFocus />
      {error && <p className="error-text">{error}</p>}
      {result && (
        <div className="sim-result">
          <IngressView ingress={result.ingress} />
          {result.tried.some((t) => !t.matched) && (
            <label className="toggle-inline">
              <input type="checkbox" checked={showSkipped} onChange={(e) => setShowSkipped(e.target.checked)} />
              Show the {result.tried.filter((t) => !t.matched).length} rules tried before (did not match)
            </label>
          )}
          <table className="mini-table">
            <thead>
              <tr>
                <th className="num">Priority</th>
                <th>Rule</th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody>
              {result.tried
                .filter((t) => showSkipped || t.matched)
                .map((t) => (
                  <tr key={t.ruleId} className={t.matched ? "chosen" : ""}>
                    <td className="num">{t.priority}</td>
                    <td>
                      <button type="button" className="link" onClick={() => onOpenRule(t.ruleId)}>
                        #{t.ruleId} {t.name}
                      </button>
                    </td>
                    <td className={t.matched ? "strong" : "muted"}>{t.reason}</td>
                  </tr>
                ))}
              {!result.tried.some((t) => t.matched) && !showSkipped && (
                <tr>
                  <td colSpan={3} className="muted">
                    No rule matched this message.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          {result.decision ? (
            <DecisionView d={result.decision} skipped={result.egressSkipped} />
          ) : (
            <p className="muted">No rule matched: the message would be rejected.</p>
          )}
        </div>
      )}
    </Modal>
  );
}
