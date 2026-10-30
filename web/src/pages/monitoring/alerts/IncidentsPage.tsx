// Incidents (§13.6): every alert with start time, end time, duration, peak value, who acknowledged and
// when, and notes; filter and export. The detail acknowledges (with a note), snoozes, adds notes and
// opens the scope in Live analytics. New and changed incidents refresh the list as they arrive.
import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router";
import type { IncidentRow } from "@sms/contract";
import { exportIncidents, useAcknowledge, useAddIncidentNote, useIncident, useSnooze } from "../../../api/alerts";
import { usePlatformCurrency, useRefreshRecords } from "../../../api/records";
import { toListQuery } from "../../../grid/filterModel";
import { useLive } from "../../../live/store";
import { pageForPath } from "../../../nav/registry";
import { ListScreen } from "../../../page/ListScreen";
import { useTabNavigate } from "../../../shell/tabContext";
import { toast } from "../../../ui/feedback";
import { Button } from "../../../ui/primitives";
import { metricQualityClass } from "../../../ui/quality";
import { problemText } from "../../routing/dialogs";
import { fmtWhen } from "../../reference/shared";
import { Kv } from "../../admin/parts";
import { analyticsFor, duration, fmtAlertValue, METRIC_SHORT } from "./alertsModel";
import { IncidentFilters, todayCondition } from "./IncidentFilters";

const page = pageForPath("/monitoring/incidents")!;
const STATE = { open: "Open", acknowledged: "Acknowledged", recovered: "Recovered" } as const;
const num = (v: number | null) => (v === null ? "—" : Math.round(v * 100) / 100);
/** An incident value; ASR and DLR values are coloured by value (§13.4). */
const valueCell = (r: IncidentRow, v: number | null) => (
  <span className={`num ${metricQualityClass(r.metric, v)}`}>{num(v)}</span>
);

function IncidentDetailView({ r }: { r: IncidentRow }) {
  const detail = useIncident(r.id);
  const ack = useAcknowledge();
  const snooze = useSnooze();
  const addNote = useAddIncidentNote();
  const navigate = useTabNavigate();
  const [note, setNote] = useState("");
  const currency = usePlatformCurrency();
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
          [
            "Now / baseline / peak",
            <>
              {valueCell(r, r.currentValue)} / {valueCell(r, r.baselineValue)} / {valueCell(r, r.peakValue)}
            </>,
          ],
          [
            "Worst destinations",
            r.breakdown.length ? (
              <span className="tag-row">
                {r.breakdown.map((b) => (
                  <span key={`${b.code}-${b.name}`} className="chip-tag">
                    {b.name}
                    {b.code ? ` (${b.code})` : ""} ·{" "}
                    <span className="num">{fmtAlertValue(r.metric, b.value, currency)}</span>
                  </span>
                ))}
              </span>
            ) : null,
          ],
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
        void exportIncidents({ ...toListQuery(state), limit: 4000, withTotal: false }).catch((e: unknown) =>
          toast({ tone: "error", message: problemText(e) }),
        )
      }
      // Incident log redesign (team trial round 4): a filter bar of periods and Rule / Severity / State chips,
      // state and severity as pills, scope over its rule, start → end, duration with a bar, the peak.
      rowHeight={60}
      initialState={{
        switches: { startedAt: todayCondition() },
        visible: ["id", "state", "severity", "entityName", "message", "startedAt", "durationSeconds", "peakValue"],
      }}
      toolbar={(state, setState) => <IncidentFilters state={state} setState={setState} />}
      toolbarFields={["startedAt", "ruleName", "severity", "state"]}
      columns={{
        id: { width: 80, label: "#", render: (r) => <span className="num muted">{r.id}</span> },
        startedAt: {
          width: 170,
          label: "Start → end",
          render: (r) => (
            <span className="num">
              {r.startedAt.slice(11, 16)} → {r.endedAt ? r.endedAt.slice(11, 16) : "ongoing"}
            </span>
          ),
        },
        endedAt: {
          width: 165,
          render: (r) => (r.endedAt ? fmtWhen(r.endedAt) : <span className="tone-error">open</span>),
        },
        durationSeconds: {
          width: 200,
          label: "Duration",
          render: (r) => (
            <span className="two-line">
              <strong className="num">
                {duration(r.durationSeconds)}
                {r.endedAt ? "" : " so far"}
              </strong>
              <span className={`dur-bar${r.endedAt ? "" : " open"}`}>
                <span style={{ width: `${Math.min(100, (r.durationSeconds / 3600) * 100)}%` }} />
              </span>
            </span>
          ),
        },
        severity: {
          width: 110,
          render: (r) => (
            <span
              className={`chip-tag ${r.severity === "critical" ? "red" : r.severity === "warning" ? "amber" : "blue"}`}
            >
              {r.severity[0]!.toUpperCase() + r.severity.slice(1)}
            </span>
          ),
        },
        state: {
          width: 130,
          render: (r) => (
            <span
              className={`chip-tag ${r.state === "recovered" ? "green" : r.state === "acknowledged" ? "amber" : "red"}`}
            >
              <span className="dot-mini" />
              {STATE[r.state]}
            </span>
          ),
        },
        ruleName: { width: 230 },
        entityName: {
          width: 260,
          label: "Scope · rule",
          render: (r) => (
            <span className="two-line">
              <strong>{r.entityName}</strong>
              <button
                type="button"
                className="link small"
                onClick={(e) => {
                  e.stopPropagation();
                  navigate("/monitoring/alert-rules");
                }}
              >
                {r.ruleName}
              </button>
            </span>
          ),
        },
        metric: { width: 90, render: (r) => METRIC_SHORT[r.metric] },
        message: { width: 440, label: "What happened" },
        peakValue: {
          width: 100,
          align: "right",
          label: "Peak",
          render: (r) => <strong>{valueCell(r, r.peakValue)}</strong>,
        },
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
