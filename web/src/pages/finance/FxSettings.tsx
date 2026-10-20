// Exchange-rate source and currency alerts (team trial round 2). Rates are per 1 EUR, the base currency.
// Source (round 3): any rate API (XE, Open Exchange Rates, Fixer, ExchangeRate-API, ECB) or a custom JSON URL,
// or manual entry; administrators only, the key is never shown again. The source is checked every minute to
// every day (hourly by default) and a rate changes only when it moved at least the minimum change; a daily
// update at a set time takes every rate whatever the difference.
// Alerts: when a currency moves against EUR by at least a % or an amount, e-mail the recipients.
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { FxAlertRule, FxAlertRuleInput, FxProvider, FxProviderUpdate } from "@sms/contract";
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
import { TimeInput } from "../../ui/DateTimeInput";
import { fmtWhen } from "../reference/shared";
import { problemText } from "../routing/dialogs";

const REFRESH: { value: FxProviderUpdate["refreshMinutes"]; label: string }[] = [
  { value: 1, label: "Every minute" },
  { value: 15, label: "Every 15 minutes" },
  { value: 60, label: "Every hour (default)" },
  { value: 360, label: "Every 6 hours" },
  { value: 1440, label: "Once a day" },
];

const AUTH: { value: FxProviderUpdate["authType"]; label: string }[] = [
  { value: "none", label: "No key" },
  { value: "query", label: "Query parameter" },
  { value: "header", label: "Header" },
  { value: "basic", label: "Basic auth (account ID : key)" },
  { value: "path", label: "In the URL ({key})" },
];

type Form = FxProviderUpdate & { apiKey: string };

const formOf = (p: FxProvider): Form => ({
  provider: p.provider,
  label: p.label,
  apiUrl: p.apiUrl,
  authType: p.authType,
  authParam: p.authParam,
  accountId: p.accountId,
  ratesPath: p.ratesPath,
  baseCurrency: p.baseCurrency,
  refreshMinutes: p.refreshMinutes,
  minChangeMode: p.minChangeMode,
  minChange: p.minChange,
  dailyUpdateAt: p.dailyUpdateAt,
  enabled: p.enabled,
  apiKey: "",
});

function ProviderCard() {
  const { data: me } = useMe();
  const admin = !!me && me.permissions.includes("*");
  const q = useFxProvider(admin);
  const ref = useReference();
  const save = useSaveFxProvider();
  const qc = useQueryClient();
  const [edit, setEdit] = useState<Form | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!admin)
    return (
      <section className="fx-card">
        <h2>Rate source</h2>
        <p className="muted small">Only administrators can see and change where exchange rates come from.</p>
      </section>
    );
  const p = q.data;
  if (!p) return <section className="fx-card muted">Loading…</section>;
  const form = edit ?? formOf(p);
  const preset = p.presets.find((x) => x.provider === form.provider);
  const manual = form.provider === "manual";
  const set = (patch: Partial<Form>) => setEdit({ ...form, ...patch });
  // Picking a source fills its defaults; a custom source keeps what was typed.
  const pick = (provider: FxProviderUpdate["provider"]) => {
    const d = p.presets.find((x) => x.provider === provider);
    if (!d || provider === "custom") return set({ provider });
    set({
      provider,
      apiUrl: d.apiUrl,
      authType: d.authType,
      authParam: d.authParam,
      ratesPath: d.ratesPath,
      baseCurrency: d.baseCurrency,
    });
  };
  const submit = () => {
    const { apiKey, ...rest } = form;
    save.mutate(
      { ...rest, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) },
      {
        onSuccess: () => {
          setEdit(null);
          setError(null);
          void qc.invalidateQueries({ queryKey: ["fx"] });
          toast({ tone: "good", message: "Rate source saved" });
        },
        onError: (e) => setError(problemText(e)),
      },
    );
  };
  const currencies = (ref.data?.currencies ?? []).map((c) => c.iso);
  const keyNeeded = form.authType !== "none";
  return (
    <section className="fx-card">
      <h2>Rate source</h2>
      <p className="small">
        Rates are kept <strong>per 1 EUR</strong>, the base currency. Pick any rate API (or a custom JSON URL). The
        platform <strong>checks</strong> it on the schedule below but only <strong>changes a rate</strong> when it moved
        at least the minimum change; once a day at the update time every rate is taken whatever the difference.
      </p>
      <div className="fgrid cols-2">
        <label className="field">
          <span>Source</span>
          <select value={form.provider} onChange={(e) => pick(e.target.value as FxProviderUpdate["provider"])}>
            {p.presets.map((x) => (
              <option key={x.provider} value={x.provider}>
                {x.label}
              </option>
            ))}
          </select>
          {preset && <small className="muted">{preset.note}</small>}
        </label>
        {form.provider === "custom" ? (
          <label className="field">
            <span>Source name</span>
            <input value={form.label ?? ""} maxLength={80} onChange={(e) => set({ label: e.target.value || null })} />
          </label>
        ) : (
          <span />
        )}
        {!manual && (
          <>
            <label className="field wide">
              <span>API URL</span>
              <input
                value={form.apiUrl ?? ""}
                maxLength={1000}
                placeholder="https://…  ({key} = API key, {base} = base currency)"
                onChange={(e) => set({ apiUrl: e.target.value || null })}
              />
            </label>
            <label className="field">
              <span>API key sent as</span>
              <select
                value={form.authType}
                onChange={(e) => set({ authType: e.target.value as FxProviderUpdate["authType"] })}
              >
                {AUTH.map((x) => (
                  <option key={x.value} value={x.value}>
                    {x.label}
                  </option>
                ))}
              </select>
            </label>
            {form.authType === "query" || form.authType === "header" ? (
              <label className="field">
                <span>{form.authType === "query" ? "Parameter name" : "Header name"}</span>
                <input
                  value={form.authParam ?? ""}
                  maxLength={100}
                  placeholder={form.authType === "query" ? "app_id, access_key …" : "Authorization, apikey …"}
                  onChange={(e) => set({ authParam: e.target.value || null })}
                />
              </label>
            ) : form.authType === "basic" ? (
              <label className="field">
                <span>Account ID</span>
                <input
                  value={form.accountId ?? ""}
                  autoComplete="off"
                  onChange={(e) => set({ accountId: e.target.value || null })}
                />
              </label>
            ) : (
              <span />
            )}
            {keyNeeded && (
              <label className="field">
                <span>
                  API key{" "}
                  {p.apiKeySet ? <span className="tone-good">· stored</span> : <span className="muted">· not set</span>}
                </span>
                <input
                  type="password"
                  value={form.apiKey}
                  autoComplete="new-password"
                  placeholder={p.apiKeySet ? "Leave empty to keep the stored key" : "Paste the API key"}
                  onChange={(e) => set({ apiKey: e.target.value })}
                />
              </label>
            )}
            <label className="field">
              <span>Rates path in the answer</span>
              <input
                value={form.ratesPath ?? ""}
                maxLength={200}
                placeholder="rates"
                onChange={(e) => set({ ratesPath: e.target.value || null })}
              />
            </label>
            <label className="field">
              <span>Source quotes against</span>
              <select value={form.baseCurrency} onChange={(e) => set({ baseCurrency: e.target.value })}>
                {(currencies.includes(form.baseCurrency) ? currencies : [form.baseCurrency, ...currencies]).map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
              <small className="muted">Converted to per 1 EUR when saved.</small>
            </label>
            <label className="field">
              <span>Check the source</span>
              <select
                value={form.refreshMinutes}
                onChange={(e) => set({ refreshMinutes: Number(e.target.value) as FxProviderUpdate["refreshMinutes"] })}
              >
                {REFRESH.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </select>
            </label>
            <div className="field">
              <span>Update a rate only when it moved at least</span>
              <div className="inline-inputs">
                <input
                  className="num w-num"
                  type="number"
                  min={0}
                  step="any"
                  value={form.minChange}
                  onChange={(e) => set({ minChange: Math.max(0, Number(e.target.value) || 0) })}
                />
                <select
                  value={form.minChangeMode}
                  onChange={(e) => set({ minChangeMode: e.target.value as FxProviderUpdate["minChangeMode"] })}
                >
                  <option value="percent">% of the current rate</option>
                  <option value="amount">units per 1 EUR</option>
                </select>
              </div>
              <small className="muted">0 = every check updates the rates.</small>
            </div>
            <div className="field">
              <span>Daily update (24-hour, {p.timezone})</span>
              <div className="inline-inputs">
                <label className="toggle-inline">
                  <input
                    type="checkbox"
                    checked={form.dailyUpdateAt !== null}
                    onChange={(e) => set({ dailyUpdateAt: e.target.checked ? "06:00" : null })}
                  />
                  Every day at
                </label>
                <TimeInput
                  aria-label="Daily update time"
                  disabled={form.dailyUpdateAt === null}
                  value={form.dailyUpdateAt ?? "06:00"}
                  onChange={(t) => set({ dailyUpdateAt: t })}
                />
              </div>
              <small className="muted">Takes every rate from the source whatever the difference.</small>
            </div>
          </>
        )}
      </div>
      {!manual && (
        <label className="toggle-inline">
          <input type="checkbox" checked={form.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
          Check automatically
        </label>
      )}
      <dl className="kv small">
        <dt>Last check</dt>
        <dd>{p.lastRunAt ? `${fmtWhen(p.lastRunAt)} · ${p.lastMessage ?? p.lastStatus}` : "not yet"}</dd>
        <dt>Next check</dt>
        <dd>{p.nextRunAt ? fmtWhen(p.nextRunAt) : "—"}</dd>
        <dt>Last daily update</dt>
        <dd>{p.lastDailyAt ? fmtWhen(p.lastDailyAt) : "not yet"}</dd>
        <dt>Next daily update</dt>
        <dd>{p.nextDailyAt ? fmtWhen(p.nextDailyAt) : "—"}</dd>
      </dl>
      {p.simulated && (
        <p className="muted small">
          Trial phase: checks are simulated (small market moves); nothing is sent to the rate API. The key is stored
          encrypted and never shown again. Sync Rates on Currencies takes every rate at once, like the daily update.
        </p>
      )}
      {error && <p className="error-text">{error}</p>}
      <div className="bulk-row">
        <Button variant="primary" small disabled={!edit || save.isPending} onClick={submit}>
          Save rate source
        </Button>
        {edit && (
          <Button
            small
            onClick={() => {
              setEdit(null);
              setError(null);
            }}
          >
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
