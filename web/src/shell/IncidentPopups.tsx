// Pop-up cards for new incidents (§13.6): severity, what happened, value vs baseline, time,
// and Acknowledge / Open in Analytics / Snooze (15 min, 1 h, until tomorrow). Acknowledge and snooze
// go to the server, so every tab and colleague sees them; sounds play from the live store.
import { useEffect } from "react";
import type { IncidentEvent } from "@sms/contract";
import { useLive, openIncidents } from "../live/store";
import { useTabs } from "./tabs";
import { useOpener } from "./useOpener";
import { Icon } from "../ui/Icon";

/** Pages that show live traffic get the alert dot while incidents are open (§13.5). */
const ALERT_PAGES = ["/dashboard", "/live", "/monitoring/incidents"];

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

export function IncidentPopups({ popout = false }: { popout?: boolean }) {
  const { incidents, popups, dismissPopup, acknowledge, snooze } = useLive();
  const opener = useOpener({ popout });
  const cards = popups.map((id) => incidents.find((i) => i.incidentId === id)).filter((i) => i !== undefined);
  if (cards.length === 0) return null;
  return (
    <div className="incident-cards" aria-live="assertive">
      {cards.map((i) => (
        <div key={i.incidentId} className={`incident-card sev-${i.severity}`} role="alert">
          <div className="incident-head">
            <Icon name="alert" size={15} />
            <strong>
              {i.severity === "critical" ? "Critical" : i.severity === "warning" ? "Warning" : "Info"}
              {i.repeat ? " · still on" : ""}
            </strong>
            <span className="muted small">{i.ruleName}</span>
            <span className="muted small num">{new Date(i.startedAt).toISOString().slice(11, 16)} UTC</span>
            <button
              type="button"
              className="toast-close"
              aria-label="Dismiss"
              onClick={() => dismissPopup(i.incidentId)}
            >
              <Icon name="x" size={13} />
            </button>
          </div>
          <p>{i.message}</p>
          {i.currentValue !== null && i.baselineValue != null && (
            <p className="muted small">
              Now <strong className="num">{i.currentValue}</strong> · baseline{" "}
              <span className="num">{i.baselineValue}</span>
            </p>
          )}
          <div className="incident-actions">
            <button type="button" className="btn btn-sm btn-default" onClick={() => void acknowledge(i.incidentId)}>
              Acknowledge
            </button>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => {
                dismissPopup(i.incidentId);
                opener(analyticsPath(i), { ctrlKey: true });
              }}
            >
              Open in Analytics
            </button>
            <select
              className="btn btn-sm btn-ghost snooze-select"
              aria-label="Snooze"
              value=""
              onChange={(e) => e.target.value && void snooze(i.incidentId, e.target.value as "15m" | "1h" | "tomorrow")}
            >
              <option value="">Snooze…</option>
              <option value="15m">15 min</option>
              <option value="1h">1 hour</option>
              <option value="tomorrow">Until tomorrow</option>
            </select>
          </div>
        </div>
      ))}
    </div>
  );
}
