// Incidents (§13.6): every alert with start time, end time, duration, peak value, who acknowledged and
// when, and notes; filter and export. The detail acknowledges (with a note), snoozes, adds notes and
// opens the scope in Live analytics. New and changed incidents refresh the list as they arrive.
import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router";
import type { IncidentRow } from "@sms/contract";
import { exportIncidents, useAcknowledge, useAddIncidentNote, useIncident, useSnooze } from "../../../api/alerts";
import { useRefreshRecords } from "../../../api/records";
import { toListQuery } from "../../../grid/filterModel";
import { useLive } from "../../../live/store";
import { pageForPath } from "../../../nav/registry";
import { ListScreen } from "../../../page/ListScreen";
import { useTabNavigate } from "../../../shell/tabContext";
import { toast } from "../../../ui/feedback";
import { Button, StatusDot } from "../../../ui/primitives";
import { problemText } from "../../routing/dialogs";
import { fmtWhen } from "../../reference/shared";
import { Kv } from "../../admin/parts";
import { analyticsFor, duration, METRIC_SHORT } from "./alertsModel";
import { severityCell } from "./parts";

const page = pageForPath("/monitoring/incidents")!;
const STATE = { open: "Open", acknowledged: "Acknowledged", recovered: "Recovered" } as const;
const stateCell = (s: IncidentRow["state"]) => (
  <span>
    <StatusDot tone={s === "recovered" ? "good" : s === "acknowledged" ? "warning" : "error"} /> {STATE[s]}
  </span>
);
const num = (v: number | null) => (v === null ? "—" : Math.round(v * 100) / 100);

function IncidentDetailView({ r }: { r: IncidentRow }) {
  const detail = useIncident(r.id);
  const ack = useAcknowledge();
  const snooze = useSnooze();
  const addNote = useAddIncidentNote();
  const navigate = useTabNavigate();
  const [note, setNote] = useState("");
  const d = detail.data;
  const fail = (e: unknown) => toast({ tone: "error", message: problemText(e) });
  return (
    <div className="incident-detail">
      <div className="incident-detail-actions">
        {r.state === "open" && (
          <Button
            small
            icon="check"
            disabled={ack.isPending}
            onClick={() => ack.mutate({ id: r.id }, { onError: fail })}
          >
            Acknowledge
          </Button>
        )}
        {r.state !== "recovered" && (
          <select
            className="btn btn-sm"
            aria-label="Snooze"
            value=""
            onChange={(e) =>
              e.target.value &&
              snooze.mutate(
                { id: r.id, span: e.target.value as "15m" | "1h" | "tomorrow" },
                { onSuccess: () => toast({ tone: "good", message: "Snoozed" }), onError: fail },
              )
            }
          >
            <option value="">Snooze…</option>
            <option value="15m">15 min</option>
            <option value="1h">1 hour</option>
            <option value="tomorrow">Until tomorrow</option>
          </select>
        )}
        <Button small icon="chart" onClick={() => navigate(analyticsFor(r.entityKind, r.entityName))}>
          Open in Analytics
        </Button>
      </div>
      <Kv
        items={[
          ["What happened", r.message],
          ["Rule", `${r.ruleName}${d ? ` – ${d.conditionLabel}` : ""}`],
          ["Now / baseline / peak", `${num(r.currentValue)} / ${num(r.baselineValue)} / ${num(r.peakValue)}`],
          ["Started", fmtWhen(r.startedAt)],
          ["Ended", r.endedAt ? fmtWhen(r.endedAt) : "still open"],
          ["Duration", duration(r.durationSeconds)],
          ["Acknowledged", r.acknowledgedBy ? `${r.acknowledgedBy}, ${fmtWhen(r.acknowledgedAt)}` : null],
          ["Snoozed until", r.snoozedUntil && Date.parse(r.snoozedUntil) > Date.now() ? fmtWhen(r.snoozedUntil) : null],
          ["E-mailed", r.emailedAt ? fmtWhen(r.emailedAt) : null],
        ]}
      />
      <h3 className="part-title">Notes</h3>
      {d?.notes.length ? (
        <ul className="incident-notes">
          {d.notes.map((n) => (
            <li key={n.id}>
              <span className="muted small">
                {n.user ?? "system"} · {fmtWhen(n.at)}
              </span>
              <div>{n.text}</div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted small">No notes yet.</p>
      )}
      <div className="note-add">
        <input
          value={note}
          maxLength={2000}
          placeholder="Add a note…"
          aria-label="Add a note"
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && note.trim())
              addNote.mutate({ id: r.id, text: note.trim() }, { onSuccess: () => setNote(""), onError: fail });
          }}
        />
        <Button
          small
          disabled={!note.trim() || addNote.isPending}
          onClick={() =>
            addNote.mutate({ id: r.id, text: note.trim() }, { onSuccess: () => setNote(""), onError: fail })
          }
        >
          Add
        </Button>
      </div>
    </div>
  );
}

/** Refreshes the list (at most every 5 s) while incidents arrive on the socket. */
function useLiveRefresh() {
  const refresh = useRefreshRecords();
  const stamp = useLive((s) =>
    s.incidents.map((i) => `${i.incidentId}:${i.state}:${i.acknowledgedAt ?? ""}`).join(","),
  );
  const last = useRef(0);
  useEffect(() => {
    const wait = Math.max(0, 5000 - (Date.now() - last.current));
    const t = setTimeout(() => {
      last.current = Date.now();
      void refresh();
    }, wait);
    return () => clearTimeout(t);
  }, [stamp]); // eslint-disable-line react-hooks/exhaustive-deps
}

export function IncidentsPage() {
  const location = useLocation();
  const selectId = Number(new URLSearchParams(location.search).get("incident")) || null;
  useLiveRefresh();
  const ack = useAcknowledge();
  const snooze = useSnooze();
  const navigate = useTabNavigate();
  const fail = (e: unknown) => toast({ tone: "error", message: problemText(e) });
  const SNOOZE = [
    { span: "15m", label: "Snooze 15 min" },
    { span: "1h", label: "Snooze 1 hour" },
    { span: "tomorrow", label: "Snooze to tomorrow" },
  ] as const;
  return (
    <ListScreen<IncidentRow>
      list="incidents"
      page={page}
      noSelection
      historyScope={null}
      selectId={selectId}
      onExport={(state) =>
        void exportIncidents({ ...toListQuery(state), limit: 100000 } as never).catch((e: unknown) =>
          toast({ tone: "error", message: problemText(e) }),
        )
      }
      columns={{
        id: { width: 90 },
        startedAt: { width: 165, render: (r) => fmtWhen(r.startedAt) },
        endedAt: {
          width: 165,
          render: (r) => (r.endedAt ? fmtWhen(r.endedAt) : <span className="tone-error">open</span>),
        },
        durationSeconds: {
          width: 110,
          align: "right",
          render: (r) => <span className="num">{duration(r.durationSeconds)}</span>,
        },
        severity: { width: 105, render: (r) => severityCell(r.severity) },
        state: { width: 130, render: (r) => stateCell(r.state) },
        ruleName: { width: 230 },
        entityName: { width: 200 },
        metric: { width: 90, render: (r) => METRIC_SHORT[r.metric] },
        message: { width: 420 },
        peakValue: { width: 90, align: "right", render: (r) => <span className="num">{num(r.peakValue)}</span> },
        acknowledgedBy: { width: 140, render: (r) => r.acknowledgedBy ?? <span className="muted">—</span> },
      }}
      rowActions={(r) => [
        {
          label: "Acknowledge",
          icon: "check",
          main: true,
          disabled: r.state !== "open" || ack.isPending,
          hint: r.state === "open" ? undefined : `Already ${STATE[r.state].toLowerCase()}`,
          onSelect: () => ack.mutate({ id: r.id }, { onError: fail }),
        },
        ...SNOOZE.map((o) => ({
          label: o.label,
          icon: "clock" as const,
          disabled: r.state === "recovered" || snooze.isPending,
          hint: r.state === "recovered" ? "Already recovered" : undefined,
          onSelect: () =>
            snooze.mutate(
              { id: r.id, span: o.span },
              { onSuccess: () => toast({ tone: "good", message: "Snoozed" }), onError: fail },
            ),
        })),
        {
          label: "Open in Analytics",
          icon: "chart",
          onSelect: () => navigate(analyticsFor(r.entityKind, r.entityName)),
        },
      ]}
      rowClass={(r) => (r.state === "recovered" ? undefined : r.severity === "critical" ? "row-alert" : undefined)}
      detail={(r) => ({
        title: (
          <>
            <strong>
              #{r.id} {r.entityName}
            </strong>
            <span className="muted">
              {r.ruleName} · {STATE[r.state]}
            </span>
          </>
        ),
        sections: [{ key: "incident", label: "Incident", content: <IncidentDetailView r={r} /> }],
      })}
      shortcuts="↑↓ move"
    />
  );
}
