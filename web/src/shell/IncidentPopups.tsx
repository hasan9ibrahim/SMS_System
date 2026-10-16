// Pop-up cards for new incidents (§13.6): severity, what happened, value vs baseline, time,
// and Acknowledge / Open in Analytics / Snooze. Sounds and the Incidents page arrive with
// the Alert rules module (build step 5).
import { useEffect } from "react";
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

export function IncidentPopups({ popout = false }: { popout?: boolean }) {
  const { incidents, popups, dismissPopup, acknowledge } = useLive();
  const opener = useOpener({ popout });
  const cards = popups.map((id) => incidents.find((i) => i.incidentId === id)).filter((i) => i !== undefined);
  if (cards.length === 0) return null;
  return (
    <div className="incident-cards" aria-live="assertive">
      {cards.map((i) => (
        <div key={i.incidentId} className={`incident-card sev-${i.severity}`} role="alert">
          <div className="incident-head">
            <Icon name="alert" size={15} />
            <strong>{i.severity === "critical" ? "Critical" : i.severity === "warning" ? "Warning" : "Info"}</strong>
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
            <button type="button" className="btn btn-sm btn-default" onClick={() => acknowledge(i.incidentId)}>
              Acknowledge
            </button>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => {
                dismissPopup(i.incidentId);
                opener("/live/analytics", { ctrlKey: true });
              }}
            >
              Open in Analytics
            </button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => dismissPopup(i.incidentId)}>
              Snooze 15 min
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
