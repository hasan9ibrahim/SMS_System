// Test in place (§13.2): a sample message (sender, receiver, text, TON/NPI, a vendor DLR) run
// through one translation rule or a trunk's whole list, shown as before → after values and the
// rules that fired. Used by the Translation rules page and the trunk Rules tab.
import { useState } from "react";
import type { MessageState, TestMessage, TranslationTestResult, TrunkRulesTestResult } from "@sms/contract";
import { Icon } from "../../ui/Icon";
import { Button, StatusDot } from "../../ui/primitives";
import { problemText } from "../routing/dialogs";

const FIELDS: [keyof MessageState, string][] = [
  ["sender", "Sender ID"],
  ["receiver", "Receiver"],
  ["mccmnc", "Network (MCCMNC)"],
  ["text", "Text"],
  ["senderTon", "Sender TON"],
  ["senderNpi", "Sender NPI"],
  ["destTon", "Dest TON"],
  ["destNpi", "Dest NPI"],
  ["billingType", "Billing type"],
  ["registeredDelivery", "Registered delivery"],
  ["dlrStatus", "DLR stat"],
  ["dlrError", "DLR err"],
];

const show = (v: unknown) => (v === null || v === undefined || v === "" ? "—" : String(v));

export function TestResultView({ r, onOpenRule }: { r: TranslationTestResult; onOpenRule?: (id: number) => void }) {
  const hlr = (r as Partial<TrunkRulesTestResult>).hlr;
  const fired = r.steps.filter((s) => s.fired).length;
  return (
    <div className="tt-result">
      <div className="decision-head">
        <StatusDot tone={r.blocked ? "error" : fired ? "good" : "neutral"} />
        <strong>
          {r.blocked ? "Blocked" : fired ? `${fired} rule${fired === 1 ? "" : "s"} changed the message` : "No change"}
        </strong>
        <span className="fb-spacer" />
        {hlr !== undefined && (
          <span className="muted small">
            HLR:{" "}
            {hlr ? `${hlr.providerName} (rule ${hlr.ruleName})` : r.blocked ? "not queried" : "no HLR rule matches"}
          </span>
        )}
      </div>
      <table className="mini-table tt-values">
        <thead>
          <tr>
            <th>Field</th>
            <th>Before</th>
            <th>After</th>
          </tr>
        </thead>
        <tbody>
          {FIELDS.filter(([k]) => r.before[k] !== null || r.after[k] !== null).map(([k, label]) => {
            const changed = show(r.before[k]) !== show(r.after[k]);
            return (
              <tr key={k} className={changed ? "chosen" : ""}>
                <td className="muted">{label}</td>
                <td className="num">{show(r.before[k])}</td>
                <td className={`num${changed ? " strong" : ""}`}>{show(r.after[k])}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {r.steps.length === 0 ? (
        <p className="muted">No rule runs here.</p>
      ) : (
        <ol className="tt-steps">
          {r.steps.map((s) => (
            <li
              key={s.ruleId}
              className={s.blocked ? "blocked" : s.fired ? "fired" : s.matched ? "matched" : "skipped"}
            >
              <div className="tt-step-head">
                <Icon name={s.blocked ? "x" : s.matched ? "check" : "minus"} size={13} />
                {onOpenRule ? (
                  <button type="button" className="link" onClick={() => onOpenRule(s.ruleId)}>
                    #{s.ruleId} {s.name}
                  </button>
                ) : (
                  <strong>{s.name}</strong>
                )}
                <span className="muted small">
                  {s.blocked
                    ? "blocked the message"
                    : s.fired
                      ? s.changes.map((c) => `${c.field} ${show(c.before)} → ${show(c.after)}`).join(" · ")
                      : s.matched
                        ? "matched, nothing to change"
                        : "did not match"}
                  {s.matched && !s.blocked && !s.continueAfter ? " · Stop" : ""}
                </span>
              </div>
              {s.checks.length > 0 && (
                <ul className="checks">
                  {s.checks.map((c, i) => (
                    <li key={i} className={c.ok ? "ok" : "fail"}>
                      <Icon name={c.ok ? "check" : "x"} size={12} />
                      <span className="strong">{c.condition}</span>
                      <span className="muted">{c.detail}</span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** Sample message form plus the result; `run` does the call (one rule, or a trunk). */
export function TranslationTest<R extends TranslationTestResult>({
  run,
  note,
  onOpenRule,
}: {
  run: (m: TestMessage) => Promise<R>;
  note?: string;
  onOpenRule?: (id: number) => void;
}) {
  const [m, setM] = useState<TestMessage>({ sender: "", receiver: "", text: "" });
  const [result, setResult] = useState<R | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const set = (patch: Partial<TestMessage>) => setM((v) => ({ ...v, ...patch }));
  const num = (v: string) => (v === "" ? null : Number(v));
  const go = async () => {
    setRunning(true);
    setError(null);
    try {
      setResult(await run(m));
    } catch (e) {
      setError(problemText(e));
    } finally {
      setRunning(false);
    }
  };
  return (
    <div className="test-section">
      {note && <p className="muted small">{note}</p>}
      <form
        className="test-form"
        onSubmit={(e) => {
          e.preventDefault();
          void go();
        }}
      >
        <div className="fgrid cols-4">
          <label className="field">
            <span>Sender ID</span>
            <input
              value={m.sender}
              maxLength={32}
              placeholder="ACME"
              onChange={(e) => set({ sender: e.target.value })}
            />
          </label>
          <label className="field">
            <span>
              Receiver<span className="req">*</span>
            </span>
            <input
              value={m.receiver}
              maxLength={32}
              placeholder="00447700900123"
              onChange={(e) => set({ receiver: e.target.value.trim() })}
            />
          </label>
          <label className="field">
            <span>Sender TON</span>
            <input
              type="number"
              min={0}
              max={6}
              value={m.senderTon ?? ""}
              onChange={(e) => set({ senderTon: num(e.target.value) })}
            />
          </label>
          <label className="field">
            <span>Sender NPI</span>
            <input
              type="number"
              min={0}
              max={18}
              value={m.senderNpi ?? ""}
              onChange={(e) => set({ senderNpi: num(e.target.value) })}
            />
          </label>
          <label className="field span-2">
            <span>Text</span>
            <input value={m.text} maxLength={2000} onChange={(e) => set({ text: e.target.value })} />
          </label>
          <label className="field">
            <span>Vendor DLR stat</span>
            <input
              value={m.dlrStatus ?? ""}
              maxLength={10}
              placeholder="UNDELIV"
              onChange={(e) => set({ dlrStatus: e.target.value.toUpperCase() || null })}
            />
          </label>
          <div className="field test-run">
            <span>&nbsp;</span>
            <Button type="submit" icon="play" disabled={running || !m.receiver}>
              Run
            </Button>
          </div>
        </div>
      </form>
      {error && <p className="error-text">{error}</p>}
      {result && <TestResultView r={result} onOpenRule={onOpenRule} />}
    </div>
  );
}
