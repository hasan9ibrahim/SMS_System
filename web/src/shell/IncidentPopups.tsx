// Pop-up cards for new incidents (§13.6): severity, who, the value against the rule's condition and window,
// the worst destinations (team trial round 5: laid out as fields instead of one sentence), and Acknowledge / Open in Analytics / Snooze (15 min, 1 h, until tomorrow). Acknowledge and snooze
// go to the server, so every tab and colleague sees them; sounds play from the live store.
import { useEffect } from "react";
import type { IncidentEvent } from "@sms/contract";
import { useLive, openIncidents } from "../live/store";
import { useTabs } from "./tabs";
import { useOpener } from "./useOpener";
import { Icon } from "../ui/Icon";
import { usePlatformCurrency } from "../api/records";
import {
  baselineWords,
  conditionText,
  fmtAlertValue,
  isMeasured,
  METRIC_SHORT,
  SEVERITY_LABEL,
} from "../pages/monitoring/alerts/alertsModel";

/** The Incidents tab gets the alert dot while incidents are open (§13.5); Dashboard and Live tabs show the live light
 * instead (team trial round 6). */
const ALERT_PAGES = ["/monitoring/incidents"];

export function useTabAlertDots() {
  const open = useLive((s) => openIncidents(s).length > 0);
  const tabs = useTabs((s) => s.tabs);
  useEffect(() => {
    for (const t of tabs) {
      const concerned =
        open && ALERT_PAGES.some((p) => t.path === p || t.path.startsWith(`${p}/`) || t.path.startsWith(`${p}?`));
      if (t.alert !== concerned) useTabs.getState().setAlert(t.id, concerned);
    }
  }, [open, tabs]);
}

/** Live analytics for what the incident is about (§13.4): Report By and a name search in the URL. */
export function analyticsPath(i: Pick<IncidentEvent, "scope" | "entityName">): string {
  const first = i.scope?.[0];
  const kind = first?.kind;
  const by =
    kind === "customer_trunk"
      ? "customer_trunk"
      : kind === "vendor_trunk"
        ? "vendor_trunk"
        : kind === "vendor_enterprise"
          ? "vendor"
          : "customer";
  const q = first ? `&q=${encodeURIComponent(first.name)}` : "";
  return `/live/analytics?by=${by}${q}`;
}

/** One pop-up card: who, the value against the condition, the window, the worst destinations, actions. */
function IncidentCard({
  i,
  currency,
  onDismiss,
  onAcknowledge,
  onOpen,
  onSnooze,
}: {
  i: IncidentEvent;
  currency: string;
  onDismiss: () => void;
  onAcknowledge: () => void;
  onOpen: () => void;
  onSnooze: (span: "15m" | "1h" | "tomorrow") => void;
}) {
  const v = (x: number | null) => fmtAlertValue(i.metric, x, currency);
  const measured = isMeasured(i.condition ?? null) && i.metric !== "bind_status";
  const when = conditionText(i.metric, i.condition ?? null, currency);
  const breakdown = i.breakdown ?? [];
  return (
    <div className={`incident-card sev-${i.severity}`} role="alert">
      <div className="incident-head">
        <Icon name="alert" size={15} />
        <span className="incident-sev">{SEVERITY_LABEL[i.severity]}</span>
        {i.repeat && <span className="chip-tag">Still on</span>}
        <span className="muted small num incident-time">{new Date(i.startedAt).toISOString().slice(11, 16)} UTC</span>
        <button type="button" className="toast-close" aria-label="Dismiss" onClick={onDismiss}>
          <Icon name="x" size={13} />
        </button>
      </div>
      <div className="incident-title">
        <strong>{i.entityName}</strong>
        <span className="muted small">{i.ruleName}</span>
      </div>
      {measured ? (
        <dl className="incident-facts">
          <div>
            <dt>{METRIC_SHORT[i.metric]} now</dt>
            <dd className={`num incident-value sev-${i.severity}`}>{v(i.currentValue)}</dd>
            {i.baselineValue != null && (
              <dd className="muted small num" title={`Value in ${baselineWords(i.condition ?? null)}`}>
                was {v(i.baselineValue)}
              </dd>
            )}
          </div>
          {when && (
            <div>
              <dt>Alert when</dt>
              <dd>{when}</dd>
            </div>
          )}
          {i.windowMinutes ? (
            <div>
              <dt>Window</dt>
              <dd>last {i.windowMinutes} min</dd>
            </div>
          ) : null}
        </dl>
      ) : (
        <p className="incident-event">{when ? when.charAt(0).toUpperCase() + when.slice(1) : i.message}</p>
      )}
      {breakdown.length > 0 && (
        <div className="incident-worst">
          <span className="muted small">Worst destinations</span>
          <ul>
            {breakdown.map((b) => (
              <li key={`${b.code}-${b.name}`}>
                <span>
                  {b.name}
                  {b.code && <span className="muted"> ({b.code})</span>}
                </span>
                <span className={`num incident-value sev-${i.severity}`}>{v(b.value)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="incident-actions">
        <button type="button" className="btn btn-sm btn-default" onClick={onAcknowledge}>
          Acknowledge
        </button>
        <button type="button" className="btn btn-sm btn-ghost" onClick={onOpen}>
          Open in Analytics
        </button>
        <select
          className="btn btn-sm btn-ghost snooze-select"
          aria-label="Snooze"
          value=""
          onChange={(e) => e.target.value && onSnooze(e.target.value as "15m" | "1h" | "tomorrow")}
        >
          <option value="">Snooze…</option>
          <option value="15m">15 min</option>
          <option value="1h">1 hour</option>
          <option value="tomorrow">Until tomorrow</option>
        </select>
      </div>
    </div>
  );
}

export function IncidentPopups({ popout = false }: { popout?: boolean }) {
  const { incidents, popups, dismissPopup, acknowledge, snooze } = useLive();
  const opener = useOpener({ popout });
  const currency = usePlatformCurrency();
  const cards = popups.map((id) => incidents.find((i) => i.incidentId === id)).filter((i) => i !== undefined);
  if (cards.length === 0) return null;
  return (
    <div className="incident-cards" aria-live="assertive">
      {cards.map((i) => (
        <IncidentCard
          key={i.incidentId}
          i={i}
          currency={currency}
          onDismiss={() => dismissPopup(i.incidentId)}
          onAcknowledge={() => void acknowledge(i.incidentId)}
          onOpen={() => {
            dismissPopup(i.incidentId);
            opener(analyticsPath(i), { ctrlKey: true });
          }}
          onSnooze={(span) => void snooze(i.incidentId, span)}
        />
      ))}
    </div>
  );
}
