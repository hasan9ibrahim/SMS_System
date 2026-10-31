// Admin › Cleanup center (§13.19, §13.20): the scan's findings as cards to review before anything
// changes. Area counts filter the list; a finding shows what was found, why it matters, the suggested
// action with the records and what applying does, and for route rules a replay of the last 24 hours.
// Apply one, several or all of a kind as one undoable change; ignore with a reason; approve waiting ones.
import { useState } from "react";
import type { CleanupAction, CleanupFinding, CleanupSettings } from "@sms/contract";
import {
  useApplyCleanup,
  useApproveCleanup,
  useCleanupFinding,
  useCleanupSettings,
  useCleanupSimulation,
  useCleanupSummary,
  useIgnoreFinding,
  useReopenFinding,
  useSaveCleanupSettings,
  useScanCleanup,
} from "../../../api/cleanup";
import { useMe } from "../../../api/hooks";
import { pageForPath } from "../../../nav/registry";
import { ListScreen } from "../../../page/ListScreen";
import { useTabNavigate } from "../../../shell/tabContext";
import { ask, toast } from "../../../ui/feedback";
import { Button, Modal, StatusDot } from "../../../ui/primitives";
import { fmtWhen } from "../../reference/shared";
import { problemText } from "../../routing/dialogs";
import { ACTION_LABEL, AREAS, cleanupUrl, resultText } from "./cleanupModel";

const page = pageForPath("/admin/cleanup")!;
const fail = (e: unknown) => toast({ tone: "error", message: problemText(e) });
const STATE: Record<CleanupFinding["state"], { label: string; tone: "good" | "warning" | "neutral" }> = {
  open: { label: "Open", tone: "warning" },
  awaiting_approval: { label: "Awaiting approval", tone: "warning" },
  applied: { label: "Applied", tone: "good" },
  ignored: { label: "Ignored", tone: "neutral" },
  resolved: { label: "Resolved", tone: "neutral" },
};

function IgnoreDialog({ done }: { done: (reason: string | null) => void }) {
  const [reason, setReason] = useState("");
  return (
    <Modal
      title="Ignore finding"
      onClose={() => done(null)}
      footer={
        <>
          <Button onClick={() => done(null)}>Cancel</Button>
          <Button variant="primary" disabled={!reason.trim()} onClick={() => done(reason.trim())}>
            Ignore
          </Button>
        </>
      }
    >
      <label className="field">
        <span>Why (so it is not suggested again)</span>
        <input autoFocus value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />
      </label>
    </Modal>
  );
}

function SettingsDialog({ done }: { done: (v: null) => void }) {
  const q = useCleanupSettings();
  const save = useSaveCleanupSettings();
  const [d, setD] = useState<CleanupSettings | null>(null);
  const [emails, setEmails] = useState<string | null>(null);
  const s = d ?? q.data;
  if (!s) return null;
  const num = (k: "unusedDays" | "dormantDays" | "userIdleDays" | "expiredDays", label: string) => (
    <label className="field">
      <span>{label}</span>
      <input type="number" min={0} value={s[k]} onChange={(e) => setD({ ...s, [k]: Number(e.target.value) })} />
    </label>
  );
  return (
    <Modal
      title="Cleanup settings"
      onClose={() => done(null)}
      footer={
        <>
          <Button onClick={() => done(null)}>Cancel</Button>
          <Button
            variant="primary"
            disabled={save.isPending}
            onClick={() => {
              const list = (emails ?? s.summaryEmails.join(", "))
                .split(/[,;\s]+/)
                .map((x) => x.trim())
                .filter(Boolean);
              save.mutate({ ...s, summaryEmails: list }, { onSuccess: () => done(null), onError: fail });
            }}
          >
            Save
          </Button>
        </>
      }
    >
      <div className="rn-form-grid">
        {num("unusedDays", "Unused after (days without traffic)")}
        {num("expiredDays", "Expired: days after the stop time")}
        {num("dormantDays", "Dormant enterprise after (days)")}
        {num("userIdleDays", "Idle user after (days without sign-in)")}
      </div>
      <label className="toggle-inline">
        <input
          type="checkbox"
          checked={s.requireApproval}
          onChange={(e) => setD({ ...s, requireApproval: e.target.checked })}
        />{" "}
        Cleanups by non-administrators wait for an administrator&apos;s approval
      </label>
      <label className="field">
        <span>Weekly summary to (rules owners)</span>
        <input value={emails ?? s.summaryEmails.join(", ")} onChange={(e) => setEmails(e.target.value)} />
      </label>
    </Modal>
  );
}

function Simulation({ id, action }: { id: number; action: CleanupAction }) {
  const sim = useCleanupSimulation({ findingIds: [id], action });
  if (sim.isPending) return <p className="muted small">Replaying the last 24 hours…</p>;
  if (sim.isError) return <p className="tone-error small">{problemText(sim.error)}</p>;
  const s = sim.data;
  return (
    <div className={`cleanup-sim ${s.unchanged ? "ok" : "warn"}`}>
      <strong>
        {s.unchanged
          ? "Routing result unchanged"
          : `${s.changedSamples} routes change (${s.changedMessages.toLocaleString("en-US")} messages / 24 h)`}
      </strong>
      <div className="muted small">{s.note}</div>
      {!s.unchanged && (
        <table className="mini-table">
          <thead>
            <tr>
              <th>Client trunk</th>
              <th>Destination</th>
              <th>Vendor now</th>
              <th>After</th>
              <th className="num">Msgs 24 h</th>
            </tr>
          </thead>
          <tbody>
            {s.changes.map((c, i) => (
              <tr key={i}>
                <td>{c.customerTrunk}</td>
                <td>{c.mccmnc}</td>
                <td>{c.before ?? "—"}</td>
                <td>{c.after ?? "no vendor"}</td>
                <td className="num">{c.messages24h.toLocaleString("en-US")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function FindingCard({ row }: { row: CleanupFinding }) {
  const d = useCleanupFinding(row.id);
  const navigate = useTabNavigate();
  const apply = useApplyCleanup();
  const approve = useApproveCleanup();
  const ignore = useIgnoreFinding();
  const reopen = useReopenFinding();
  const { data: me } = useMe();
  const [action, setAction] = useState<CleanupAction>(row.suggestion);
  const f = d.data;
  if (!f) return <div className="muted">Loading…</div>;
  const routing = f.entityType === "route_rule" && action !== "review";
  const done = (r: Parameters<typeof resultText>[0]) =>
    toast({ tone: r.applied || r.awaitingApproval ? "good" : "warning", message: resultText(r) });
  return (
    <div className="cleanup-card">
      <p>{f.why}</p>
      <div className="cleanup-impact">
        <span className="stat-label">Impact</span> {f.impact}
      </div>
      {f.state === "open" && f.actions.length > 1 && (
        <div className="segmented small" role="radiogroup" aria-label="Action">
          {f.actions.map((a) => (
            <button
              key={a}
              type="button"
              role="radio"
              aria-checked={action === a}
              className={action === a ? "on" : ""}
              onClick={() => setAction(a)}
            >
              {ACTION_LABEL[a]}
              {a === f.suggestion ? " (suggested)" : ""}
            </button>
          ))}
        </div>
      )}
      <div>
        <span className="stat-label">Records</span>
        <table className="mini-table">
          <tbody>
            {f.entities.map((e) => (
              <tr key={e.id}>
                <td>
                  {e.path ? (
                    <button type="button" className="link" onClick={() => navigate(e.path!, { newTab: true })}>
                      {e.name}
                    </button>
                  ) : (
                    e.name
                  )}{" "}
                  <span className="muted small">#{e.id}</span>
                </td>
                <td className="muted small">{e.info}</td>
                <td>{e.status ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {f.state === "open" && (
        <div>
          <span className="stat-label">What applying does</span>
          <ul className="cleanup-preview">
            {(action === f.suggestion ? f.preview : [`${ACTION_LABEL[action]}: ${f.entities[0]?.name ?? ""}`]).map(
              (l, i) => (
                <li key={i}>{l}</li>
              ),
            )}
          </ul>
        </div>
      )}
      {f.state === "open" && routing && <Simulation id={f.id} action={action} />}
      {f.ignoreReason && <p className="muted small">Ignored: {f.ignoreReason}</p>}
      {f.appliedAt && (
        <p className="muted small">
          Applied {fmtWhen(f.appliedAt)} by {f.appliedBy ?? "—"} · change #{f.changeId}
        </p>
      )}
      <div className="bulk-row">
        {f.state === "open" && action !== "review" && (
          <Button
            variant="primary"
            disabled={apply.isPending}
            onClick={() => apply.mutate({ findingIds: [f.id], action }, { onSuccess: done, onError: fail })}
          >
            Apply: {ACTION_LABEL[action]}
          </Button>
        )}
        {f.state === "awaiting_approval" && me?.permissions.includes("*") && (
          <Button
            variant="primary"
            disabled={approve.isPending}
            onClick={() => approve.mutate({ findingIds: [f.id] }, { onSuccess: done, onError: fail })}
          >
            Approve
          </Button>
        )}
        {f.state === "open" && (
          <Button
            onClick={() =>
              void ask<string | null>((close) => <IgnoreDialog done={close} />).then(
                (reason) => reason && ignore.mutate({ id: f.id, reason }, { onError: fail }),
              )
            }
          >
            Ignore…
          </Button>
        )}
        {f.state === "ignored" && <Button onClick={() => reopen.mutate(f.id, { onError: fail })}>Reopen</Button>}
      </div>
    </div>
  );
}

function AreaCards() {
  const s = useCleanupSummary();
  const navigate = useTabNavigate();
  if (!s.data) return null;
  return (
    <div className="cleanup-areas">
      {AREAS.map((a) => (
        <button
          key={a.key}
          type="button"
          className="stat-card cleanup-area"
          onClick={() => navigate(cleanupUrl({ area: a.key }), { replace: true })}
        >
          <span className="stat-label">{a.label}</span>
          <span className="stat-value">{s.data.byArea[a.key].toLocaleString("en-US")}</span>
          <span className="muted small">
            {s.data.byKind
              .filter((k) => k.area === a.key)
              .slice(0, 2)
              .map((k) => `${k.open} ${k.kindLabel.toLowerCase()}`)
              .join(" · ") || "nothing open"}
          </span>
        </button>
      ))}
      <div className="cleanup-scan muted small">
        {s.data.open.toLocaleString("en-US")} open · {s.data.awaitingApproval} awaiting approval · {s.data.applied30d}{" "}
        applied in 30 days
        <br />
        Last scan {s.data.lastScanAt ? fmtWhen(s.data.lastScanAt) : "never"} · next{" "}
        {s.data.nextScanAt ? fmtWhen(s.data.nextScanAt) : "—"}
      </div>
    </div>
  );
}

export function CleanupPage() {
  const scan = useScanCleanup();
  const apply = useApplyCleanup();
  const ignore = useIgnoreFinding();
  const approve = useApproveCleanup();
  const reopen = useReopenFinding();
  const { data: me } = useMe();
  const admin = !!me?.permissions.includes("*");
  const done = (r: Parameters<typeof resultText>[0]) =>
    toast({ tone: r.applied || r.awaitingApproval ? "good" : "warning", message: resultText(r) });
  const notOpen = (r: CleanupFinding) => (r.state === "open" ? undefined : `${STATE[r.state].label}: nothing to apply`);
  return (
    <ListScreen<CleanupFinding>
      list="cleanup_findings"
      noExport
      page={page}
      initialState={{ columns: { state: { field: "state", op: "in", values: ["open", "awaiting_approval"] } } }}
      historyScope={{ entityTypes: ["cleanup"] }}
      above={<AreaCards />}
      actions={
        <>
          <Button icon="key" onClick={() => void ask<null>((close) => <SettingsDialog done={close} />)}>
            Settings
          </Button>
          <Button
            icon="refresh"
            disabled={scan.isPending}
            onClick={() =>
              scan.mutate(null, {
                onSuccess: (r) =>
                  toast({
                    tone: "good",
                    message: `Scan: ${r.created} new, ${r.resolved} resolved, ${r.open} open (${(r.durationMs / 1000).toFixed(1)} s)`,
                  }),
                onError: fail,
              })
            }
          >
            {scan.isPending ? "Scanning…" : "Scan now"}
          </Button>
        </>
      }
      rowActions={(r) => [
        // One item per action the finding offers; the suggested one is the main action (§13.19).
        ...r.actions
          .filter((a) => a !== "review")
          .map((a) => ({
            label: `Apply: ${ACTION_LABEL[a]}`,
            icon: "check" as const,
            main: a === r.suggestion,
            disabled: r.state !== "open" || apply.isPending,
            hint: notOpen(r) ?? (a === r.suggestion ? "The suggested action" : undefined),
            onSelect: () => apply.mutate({ findingIds: [r.id], action: a }, { onSuccess: done, onError: fail }),
          })),
        {
          label: "Approve",
          icon: "check",
          main: r.state === "awaiting_approval",
          disabled: r.state !== "awaiting_approval" || !admin || approve.isPending,
          hint:
            r.state !== "awaiting_approval"
              ? "Only a finding awaiting approval"
              : admin
                ? undefined
                : "An administrator approves cleanups",
          onSelect: () => approve.mutate({ findingIds: [r.id] }, { onSuccess: done, onError: fail }),
        },
        "separator",
        {
          label: "Ignore…",
          icon: "eye",
          disabled: r.state !== "open",
          hint: notOpen(r),
          onSelect: () =>
            void ask<string | null>((close) => <IgnoreDialog done={close} />).then(
              (reason) => reason && ignore.mutate({ id: r.id, reason }, { onError: fail }),
            ),
        },
        {
          label: "Reopen",
          icon: "refresh",
          disabled: r.state !== "ignored",
          hint: r.state === "ignored" ? undefined : "Only an ignored finding",
          onSelect: () => reopen.mutate(r.id, { onError: fail }),
        },
      ]}
      columns={{
        kind: { width: 210, render: (r) => r.kindLabel },
        title: { width: 420, render: (r) => <span title={r.why}>{r.title}</span> },
        suggestion: { width: 140, render: (r) => ACTION_LABEL[r.suggestion] },
        impact: { width: 360, render: (r) => <span className="muted">{r.impact}</span> },
        messages30d: {
          width: 110,
          align: "right",
          render: (r) => (r.messages30d === null ? "—" : r.messages30d.toLocaleString("en-US")),
        },
        state: {
          width: 150,
          render: (r) => (
            <span>
              <StatusDot tone={STATE[r.state].tone} hollow={r.state !== "open"} /> {STATE[r.state].label}
            </span>
          ),
        },
        detectedAt: { width: 150, render: (r) => fmtWhen(r.detectedAt) },
      }}
      selection={{
        summary: (rows, ids) => {
          const picked = rows.filter((r) => ids.has(r.id));
          const msgs = picked.reduce((a, r) => a + (r.messages30d ?? 0), 0);
          return `${ids.size} selected · ${msgs.toLocaleString("en-US")} messages / 30 days`;
        },
        bulk: (ids, clear) => [
          {
            label: `Apply the suggestions (${ids.length})`,
            icon: "check",
            onSelect: () => apply.mutate({ findingIds: ids }, { onSuccess: (r) => (done(r), clear()), onError: fail }),
          },
          {
            label: `Delete (archive) where allowed (${ids.length})`,
            icon: "trash",
            onSelect: () =>
              apply.mutate(
                { findingIds: ids, action: "archive" },
                { onSuccess: (r) => (done(r), clear()), onError: fail },
              ),
          },
          {
            label: `Deactivate where allowed (${ids.length})`,
            icon: "minus",
            onSelect: () =>
              apply.mutate(
                { findingIds: ids, action: "deactivate" },
                { onSuccess: (r) => (done(r), clear()), onError: fail },
              ),
          },
          "separator",
          {
            label: `Ignore… (${ids.length})`,
            icon: "eye",
            onSelect: () =>
              void ask<string | null>((close) => <IgnoreDialog done={close} />).then(async (reason) => {
                if (!reason) return;
                for (const id of ids) await ignore.mutateAsync({ id, reason }).catch(fail);
                clear();
              }),
          },
        ],
      }}
      detail={(r) => ({
        title: (
          <>
            <strong>{r.title}</strong>
            <span className="muted">
              {r.kindLabel} · found {fmtWhen(r.detectedAt)}
            </span>
          </>
        ),
        sections: [{ key: "card", label: "Finding", content: <FindingCard key={r.id} row={r} /> }],
      })}
      shortcuts="Select several (or a whole kind with its filter) and apply them as one change · Undo in the header"
    />
  );
}
