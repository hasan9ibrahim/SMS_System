// Exchange-rate source and currency alerts (team trial round 2). Rates are per 1 EUR, the base currency.
// Source: XE Currency Data API (xe.com: a paid account with an account ID and API key; administrators only,
// the key is never shown again) or manual entry, refreshed every minute to every day (hourly by default).
// Alerts: when a currency moves against EUR by at least a % or an amount, e-mail the recipients.
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { FxAlertRule, FxAlertRuleInput, FxProviderUpdate } from "@sms/contract";
import {
  useDeleteFxAlertRule,
  useFxAlertEvents,
  useFxAlertRules,
  useFxProvider,
  useSaveFxAlertRule,
  useSaveFxProvider,
} from "../../api/finance";
import { useMe } from "../../api/hooks";
import { useReference } from "../../api/records";
import { ask, confirmDialog, toast } from "../../ui/feedback";
import { Button, Modal } from "../../ui/primitives";
import { fmtWhen } from "../reference/shared";
import { problemText } from "../routing/dialogs";

const REFRESH: { value: FxProviderUpdate["refreshMinutes"]; label: string }[] = [
  { value: 1, label: "Every minute" },
  { value: 15, label: "Every 15 minutes" },
  { value: 60, label: "Every hour (default)" },
  { value: 360, label: "Every 6 hours" },
  { value: 1440, label: "Once a day" },
];

function ProviderCard() {
  const { data: me } = useMe();
  const admin = !!me && me.permissions.includes("*");
  const q = useFxProvider(admin);
  const save = useSaveFxProvider();
  const qc = useQueryClient();
  const [edit, setEdit] = useState<(FxProviderUpdate & { apiKey: string }) | null>(null);
  if (!admin)
    return (
      <section className="fx-card">
        <h2>Rate source</h2>
        <p className="muted small">Only administrators can see and change where exchange rates come from.</p>
      </section>
    );
  const p = q.data;
  if (!p) return <section className="fx-card muted">Loading…</section>;
  const form = edit ?? {
    provider: p.provider,
    accountId: p.accountId,
    refreshMinutes: p.refreshMinutes,
    enabled: p.enabled,
    apiKey: "",
  };
  const submit = () =>
    save.mutate(
      {
        provider: form.provider,
        accountId: form.accountId,
        refreshMinutes: form.refreshMinutes,
        enabled: form.enabled,
        ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
      },
      {
        onSuccess: () => {
          setEdit(null);
          void qc.invalidateQueries({ queryKey: ["fx"] });
          toast({ tone: "good", message: "Rate source saved" });
        },
        onError: (e) => toast({ tone: "error", message: problemText(e) }),
      },
    );
  const set = (patch: Partial<typeof form>) => setEdit({ ...form, ...patch });
  return (
    <section className="fx-card">
      <h2>Rate source</h2>
      <p className="small">
        Rates are kept <strong>per 1 EUR</strong>, the base currency. With XE, the platform pulls every currency from
        the <strong>XE Currency Data API</strong> (xe.com) on the schedule below. XE&apos;s plan decides how fresh its
        rates are: daily, hourly or every minute.
      </p>
      <div className="fgrid cols-2">
        <label className="field">
          <span>Source</span>
          <select
            value={form.provider}
            onChange={(e) => set({ provider: e.target.value as FxProviderUpdate["provider"] })}
          >
            <option value="xe">XE Currency Data API (xe.com)</option>
            <option value="manual">Manual (rates typed in)</option>
          </select>
        </label>
        <label className="field">
          <span>Refresh</span>
          <select
            value={form.refreshMinutes}
            disabled={form.provider !== "xe"}
            onChange={(e) => set({ refreshMinutes: Number(e.target.value) as FxProviderUpdate["refreshMinutes"] })}
          >
            {REFRESH.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>XE account ID</span>
          <input
            value={form.accountId ?? ""}
            disabled={form.provider !== "xe"}
            autoComplete="off"
            onChange={(e) => set({ accountId: e.target.value || null })}
          />
        </label>
        <label className="field">
          <span>
            XE API key{" "}
            {p.apiKeySet ? <span className="tone-good">· stored</span> : <span className="muted">· not set</span>}
          </span>
          <input
            type="password"
            value={form.apiKey}
            disabled={form.provider !== "xe"}
            autoComplete="new-password"
            placeholder={p.apiKeySet ? "Leave empty to keep the stored key" : "Paste the API key"}
            onChange={(e) => set({ apiKey: e.target.value })}
          />
        </label>
      </div>
      <label className="toggle-inline">
        <input type="checkbox" checked={form.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
        Refresh automatically
      </label>
      <dl className="kv small">
        <dt>Last refresh</dt>
        <dd>{p.lastRunAt ? `${fmtWhen(p.lastRunAt)} · ${p.lastMessage ?? p.lastStatus}` : "not yet"}</dd>
        <dt>Next refresh</dt>
        <dd>{p.nextRunAt ? fmtWhen(p.nextRunAt) : "—"}</dd>
      </dl>
      {p.simulated && (
        <p className="muted small">
          Trial phase: refreshes are simulated (small market moves); nothing is sent to XE. The key is stored encrypted
          and never shown again.
        </p>
      )}
      <div className="bulk-row">
        <Button variant="primary" small disabled={!edit || save.isPending} onClick={submit}>
          Save rate source
        </Button>
        {edit && (
          <Button small onClick={() => setEdit(null)}>
            Discard
          </Button>
        )}
      </div>
    </section>
  );
}

function RuleDialog({ rule, done }: { rule: FxAlertRule | null; done: () => void }) {
  const ref = useReference();
  const save = useSaveFxAlertRule();
  const qc = useQueryClient();
  const [v, setV] = useState({
    iso: rule?.iso ?? "",
    pct: rule?.thresholdPct?.toString() ?? "2",
    abs: rule?.thresholdAbs?.toString() ?? "",
    window: rule?.window ?? ("update" as FxAlertRuleInput["window"]),
    recipients: (rule?.recipients ?? []).join(", "),
    enabled: rule?.enabled ?? true,
  });
  const [error, setError] = useState<string | null>(null);
  const currencies = (ref.data?.currencies ?? []).map((c) => c.iso).filter((c) => c !== "EUR");
  const submit = () => {
    const pct = v.pct.trim() ? Number(v.pct.replace(",", ".")) : null;
    const abs = v.abs.trim() ? Number(v.abs.replace(",", ".")) : null;
    if (pct === null && abs === null) return setError("Give a % or an amount (or both).");
    if ((pct !== null && !(pct > 0)) || (abs !== null && !(abs > 0))) return setError("Thresholds must be above 0.");
    const input: FxAlertRuleInput = {
      iso: v.iso || null,
      thresholdPct: pct,
      thresholdAbs: abs,
      window: v.window,
      recipients: v.recipients
        .split(/[,;\s]+/)
        .map((x) => x.trim())
        .filter(Boolean),
      enabled: v.enabled,
    };
    save.mutate(
      { id: rule?.id ?? null, input },
      {
        onSuccess: () => {
          void qc.invalidateQueries({ queryKey: ["fx"] });
          done();
        },
        onError: (e) => setError(problemText(e)),
      },
    );
  };
  return (
    <Modal
      title={rule ? "Edit currency alert" : "Add currency alert"}
      onClose={done}
      footer={
        <>
          <Button onClick={done}>Cancel</Button>
          <Button variant="primary" disabled={save.isPending} onClick={submit}>
            {rule ? "Save" : "Add alert"}
          </Button>
        </>
      }
    >
      <div className="fgrid cols-2">
        <label className="field">
          <span>Currency</span>
          <select value={v.iso} onChange={(e) => setV({ ...v, iso: e.target.value })}>
            <option value="">Any currency</option>
            {currencies.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Compared with</span>
          <select
            value={v.window}
            onChange={(e) => setV({ ...v, window: e.target.value as FxAlertRuleInput["window"] })}
          >
            <option value="update">The previous rate</option>
            <option value="day">The rate 24 hours before</option>
          </select>
        </label>
        <label className="field">
          <span>Moves by at least (%)</span>
          <input
            inputMode="decimal"
            value={v.pct}
            placeholder="e.g. 2"
            onChange={(e) => setV({ ...v, pct: e.target.value })}
          />
        </label>
        <label className="field">
          <span>or by at least ({v.iso || "units"} per 1 EUR)</span>
          <input
            inputMode="decimal"
            value={v.abs}
            placeholder="e.g. 0.05"
            onChange={(e) => setV({ ...v, abs: e.target.value })}
          />
        </label>
      </div>
      <label className="field">
        <span>E-mail to (comma separated)</span>
        <input
          value={v.recipients}
          placeholder="finance@…, rates@…"
          onChange={(e) => setV({ ...v, recipients: e.target.value })}
        />
      </label>
      <label className="toggle-inline">
        <input type="checkbox" checked={v.enabled} onChange={(e) => setV({ ...v, enabled: e.target.checked })} />
        Enabled
      </label>
      <p className="muted small">Up or down. Checked every time rates are refreshed or synced.</p>
      {error && <p className="error-text">{error}</p>}
    </Modal>
  );
}

function AlertsCard() {
  const rules = useFxAlertRules();
  const events = useFxAlertEvents();
  const del = useDeleteFxAlertRule();
  const qc = useQueryClient();
  const remove = async (r: FxAlertRule) => {
    if (
      !(await confirmDialog({ title: "Delete this currency alert?", message: describe(r), ok: "Delete", danger: true }))
    )
      return;
    del.mutate(r.id, { onSuccess: () => void qc.invalidateQueries({ queryKey: ["fx"] }) });
  };
  return (
    <section className="fx-card">
      <div className="bulk-row">
        <h2>Currency alerts</h2>
        <span className="fb-spacer" />
        <Button small icon="plus" onClick={() => void ask<void>((d) => <RuleDialog rule={null} done={() => d()} />)}>
          Add alert
        </Button>
      </div>
      {rules.data?.length ? (
        <table className="mini-table">
          <thead>
            <tr>
              <th>Alert</th>
              <th>E-mail to</th>
              <th>Last fired</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rules.data.map((r) => (
              <tr key={r.id} className={r.enabled ? "" : "off"}>
                <td>{describe(r)}</td>
                <td>{r.recipients.join(", ") || <span className="muted">nobody (listed below only)</span>}</td>
                <td>{r.lastTriggeredAt ? fmtWhen(r.lastTriggeredAt) : <span className="muted">never</span>}</td>
                <td className="num">
                  <button
                    type="button"
                    className="link-btn"
                    onClick={() => void ask<void>((d) => <RuleDialog rule={r} done={() => d()} />)}
                  >
                    Edit
                  </button>{" "}
                  <button type="button" className="link-btn" onClick={() => void remove(r)}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted small">No alert yet. Add one to be e-mailed when a currency moves against EUR.</p>
      )}
      <h3>Fired recently</h3>
      {events.data?.length ? (
        <table className="mini-table">
          <thead>
            <tr>
              <th>When</th>
              <th>Currency</th>
              <th className="num">From</th>
              <th className="num">To</th>
              <th className="num">Change</th>
              <th className="num">E-mails</th>
            </tr>
          </thead>
          <tbody>
            {events.data.map((e) => (
              <tr key={e.id}>
                <td>{fmtWhen(e.at)}</td>
                <td>
                  <strong>{e.iso}</strong>
                  <span className="muted small"> {e.window === "day" ? "vs 24 h" : "vs previous"}</span>
                </td>
                <td className="num">{e.fromRate}</td>
                <td className="num">{e.toRate}</td>
                <td className={`num ${Math.abs(e.changePct) >= 1 ? "tone-warning" : ""}`}>
                  {e.changePct > 0 ? "+" : ""}
                  {e.changePct.toFixed(2)} %
                </td>
                <td className="num">{e.emailed}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted small">No alert has fired.</p>
      )}
    </section>
  );
}

function describe(r: FxAlertRule): string {
  const t = [
    r.thresholdPct !== null ? `${r.thresholdPct} %` : null,
    r.thresholdAbs !== null ? `${r.thresholdAbs} ${r.iso ?? "units"}` : null,
  ]
    .filter(Boolean)
    .join(" or ");
  return `${r.iso ?? "Any currency"} moves ≥ ${t} vs ${r.window === "day" ? "24 hours before" : "the previous rate"}${r.enabled ? "" : " (off)"}`;
}

export function FxSettings() {
  return (
    <div className="fx-settings">
      <ProviderCard />
      <AlertsCard />
    </div>
  );
}
