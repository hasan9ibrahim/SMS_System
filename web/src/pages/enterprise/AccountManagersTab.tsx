// Account manager history and Hand over (§13.30): results before the handover stay with the
// previous AM. A handover is immediate or scheduled; a new one replaces a pending one.
import { useState } from "react";
import type { EnterpriseDetail } from "@sms/contract";
import { ApiError } from "../../api/client";
import { useAmHistory, useHandover, useReference } from "../../api/records";
import { useNotifySaved } from "../../history/undo";
import { Button, Modal } from "../../ui/primitives";
import { HeaderAction, type SectionProps } from "../../records/parts";
import { DateTimeInput } from "../../ui/DateTimeInput";

const utc = (s: string) => `${s.slice(0, 16).replace("T", " ")} UTC`;

function HandoverDialog({ enterprise, onClose }: { enterprise: EnterpriseDetail; onClose: () => void }) {
  const ref = useReference();
  const handover = useHandover(enterprise.id);
  const notifySaved = useNotifySaved();
  const [userId, setUserId] = useState<number | null>(null);
  const [when, setWhen] = useState<"now" | "later">("now");
  const [at, setAt] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const submit = () => {
    if (!userId) return setError("Choose the new account manager.");
    if (when === "later" && !at) return setError("Choose when the handover takes effect.");
    handover.mutate(
      {
        userId,
        ...(when === "later" ? { effectiveAt: new Date(`${at}:00Z`).toISOString() } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      },
      {
        onSuccess: (r) => {
          notifySaved(r.change, when === "now" ? "Handed over" : "Handover scheduled");
          onClose();
        },
        onError: (e) => {
          const p = e instanceof ApiError ? ((e.problem.errors ?? []) as { message: string; path: string }[]) : [];
          setError(p.length ? p.map((x) => `${x.path.slice(1)}: ${x.message}`).join("; ") : (e as Error).message);
        },
      },
    );
  };
  return (
    <Modal
      title={`Hand over ${enterprise.name}`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={submit} disabled={handover.isPending}>
            {when === "now" ? "Hand over now" : "Schedule handover"}
          </Button>
        </>
      }
    >
      <label className="field">
        <span>
          New account manager<span className="req">*</span>
        </span>
        <select value={userId ?? ""} onChange={(e) => setUserId(e.target.value ? Number(e.target.value) : null)}>
          <option value="">—</option>
          {ref.data?.accountManagers
            .filter((u) => u.id !== enterprise.accountManagerId)
            .map((u) => (
              <option key={u.id} value={u.id}>
                {u.displayName}
              </option>
            ))}
        </select>
      </label>
      <div className="field">
        <span>Effective</span>
        <label className="toggle-inline">
          <input type="radio" checked={when === "now"} onChange={() => setWhen("now")} /> Now
        </label>
        <label className="toggle-inline">
          <input type="radio" checked={when === "later"} onChange={() => setWhen("later")} /> At a set time (UTC)
          <DateTimeInput
            value={at}
            disabled={when !== "later"}
            min={new Date().toISOString().slice(0, 16)}
            onChange={(e) => setAt(e.target.value)}
          />
        </label>
      </div>
      <label className="field">
        <span>Note</span>
        <textarea rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      <p className="muted small">
        Revenue, cost and margin before the handover stay credited to{" "}
        {enterprise.accountManagerName ?? "the current AM"}. A scheduled handover replaces one that hasn't started yet.
      </p>
      {error && <p className="error-text">{error}</p>}
    </Modal>
  );
}

export function AccountManagersTab({ enterprise, slot }: SectionProps & { enterprise: EnterpriseDetail }) {
  const periods = useAmHistory(enterprise.id);
  const [open, setOpen] = useState(false);
  const now = Date.now();
  return (
    <>
      <HeaderAction slot={slot}>
        <Button variant="primary" icon="users" disabled={!!enterprise.archived} onClick={() => setOpen(true)}>
          Hand over
        </Button>
      </HeaderAction>
      <div className="card">
        {periods.isError && <p className="error-text">{(periods.error as Error).message}</p>}
        {periods.data && (
          <table className="rtable">
            <thead>
              <tr>
                <th>Account manager</th>
                <th>From</th>
                <th>Until</th>
                <th>Note</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {periods.data.map((p) => {
                const start = Date.parse(p.startsAt);
                const current = start <= now && (!p.endsAt || Date.parse(p.endsAt) > now);
                return (
                  <tr key={`${p.userId}-${p.startsAt}`}>
                    <td className="strong">{p.userName}</td>
                    <td className="tnum">{utc(p.startsAt)}</td>
                    <td className="tnum">{p.endsAt ? utc(p.endsAt) : "—"}</td>
                    <td className="muted">{p.note ?? ""}</td>
                    <td>
                      {current && <span className="tag tag-accent">Current</span>}
                      {start > now && <span className="tag">Scheduled</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      <p className="muted small">
        Reports split results by the AM at send time (§13.30). Undo a handover from History until it takes effect.
      </p>
      {open && <HandoverDialog enterprise={enterprise} onClose={() => setOpen(false)} />}
    </>
  );
}
