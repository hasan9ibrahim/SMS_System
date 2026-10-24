// Account manager history and Hand over (§13.30): results before the handover stay with the
// previous AM. A handover is immediate or scheduled; a new one replaces a pending one.
import { useState } from "react";
import type { EmailTemplateRow, EnterpriseDetail } from "@sms/contract";
import { useAllRows } from "../../api/admin";
import { ApiError } from "../../api/client";
import { useAmHistory, useHandover, useReference } from "../../api/records";
import { useNotifySaved } from "../../history/undo";
import { toast } from "../../ui/feedback";
import { Icon } from "../../ui/Icon";
import { Button, Modal } from "../../ui/primitives";
import { type SectionProps } from "../../records/parts";
import { Avatar } from "../../page/PageHeader";
import { DateTimeInput } from "../../ui/DateTimeInput";

function HandoverDialog({ enterprise, onClose }: { enterprise: EnterpriseDetail; onClose: () => void }) {
  const ref = useReference();
  const handover = useHandover(enterprise.id);
  const notifySaved = useNotifySaved();
  const [userId, setUserId] = useState<number | null>(null);
  const [when, setWhen] = useState<"now" | "later">("now");
  const [at, setAt] = useState("");
  const [note, setNote] = useState("");
  // Team trial round 2: the client is told by e-mail, from the new AM, with an am_handover template.
  const [notify, setNotify] = useState(true);
  const [templateId, setTemplateId] = useState<number | null>(null);
  const templates = useAllRows<EmailTemplateRow>("email_templates", {
    logic: "and",
    conditions: [{ field: "emailType", op: "eq", value: "am_handover" }],
  });
  const [error, setError] = useState<string | null>(null);
  const submit = () => {
    if (!userId) return setError("Choose the new account manager.");
    if (when === "later" && !at) return setError("Choose when the handover takes effect.");
    handover.mutate(
      {
        userId,
        ...(when === "later" ? { effectiveAt: new Date(`${at}:00Z`).toISOString() } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
        notify,
        ...(notify && templateId ? { templateId } : {}),
      },
      {
        onSuccess: (r) => {
          const msg = when === "now" ? "Handed over" : "Handover scheduled";
          notifySaved(r.change, r.emailed ? `${msg} · client e-mailed` : msg);
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
      <label className="toggle-inline">
        <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} /> E-mail the client
      </label>
      {notify && (
        <label className="field">
          <span>Template</span>
          <select
            value={templateId ?? ""}
            onChange={(e) => setTemplateId(e.target.value ? Number(e.target.value) : null)}
          >
            <option value="">Company default</option>
            {templates.data?.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
                {t.businessCompany ? ` (${t.businessCompany})` : ""}
              </option>
            ))}
          </select>
          <span className="muted small">
            Sent from the new Account Manager to the commercial contact, both Account Managers in copy. Edit templates
            in Admin › E-mail templates.
          </span>
        </label>
      )}
      <p className="muted small">
        Revenue, cost and margin before the handover stay credited to{" "}
        {enterprise.accountManagerName ?? "the current Account Manager"}. A scheduled handover replaces one that hasn't
        started yet.
      </p>
      {error && <p className="error-text">{error}</p>}
    </Modal>
  );
}

const day = (s: string) =>
  `${new Date(s).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })}`;
const dayTime = (s: string) => `${day(s)}, ${s.slice(11, 16)} UTC`;

/**
 * The partner's own account manager (team trial round 5): the enterprise's Commercial contact, edited on the General
 * tab. Shown under our AM and its history.
 */
function PartnerAm({ enterprise }: { enterprise: EnterpriseDetail }) {
  const c = enterprise.contacts.commercial;
  const copy = (text: string) =>
    void navigator.clipboard
      ?.writeText(text)
      .then(() => toast({ tone: "good", message: "Copied" }))
      .catch(() => undefined);
  const empty = !c.name && !c.phone && !c.emails.length;
  return (
    <section className="fsection am-partner">
      <header>
        <div className="fsection-title">
          <h2>Partner Account Manager</h2>
          <p className="muted small">
            {enterprise.name}&apos;s Account Manager on their side: the Commercial contact (edit it on the General tab).
          </p>
        </div>
      </header>
      {empty ? (
        <p className="muted">No commercial contact yet.</p>
      ) : (
        <div className="am-person">
          <Avatar name={c.name || c.emails[0] || "?"} size="md" />
          <div className="am-partner-info">
            <div className="strong">{c.name || "Name not set"}</div>
            {c.phone && (
              <a className="small" href={`tel:${c.phone}`}>
                {c.phone}
              </a>
            )}
            <div className="tag-row">
              {c.emails.map((m) => (
                <span key={m} className="chip-tag">
                  <a href={`mailto:${m}`}>{m}</a>
                  <button type="button" className="icon-btn" aria-label={`Copy ${m}`} onClick={() => copy(m)}>
                    <Icon name="copy" size={11} />
                  </button>
                </span>
              ))}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

/**
 * Account managers (record redesign, team trial round 4): the current AM in a card with Hand over, and the
 * assignment history as a timeline, newest first.
 */
export function AccountManagersTab({ enterprise }: SectionProps & { enterprise: EnterpriseDetail }) {
  const periods = useAmHistory(enterprise.id);
  const [open, setOpen] = useState(false);
  const now = Date.now();
  const list = [...(periods.data ?? [])].sort((a, b) => Date.parse(b.startsAt) - Date.parse(a.startsAt));
  const current = list.find((p) => Date.parse(p.startsAt) <= now && (!p.endsAt || Date.parse(p.endsAt) > now));
  return (
    <>
      <div className="am-layout">
        <section className="fsection am-current">
          <h3 className="fsub">Current account manager</h3>
          {current ? (
            <div className="am-person">
              <Avatar name={current.userName} size="md" />
              <div>
                <div className="strong">{current.userName}</div>
                <div className="muted small">Since {day(current.startsAt)}</div>
              </div>
            </div>
          ) : (
            <p className="muted">{enterprise.accountManagerName ?? "No account manager"}</p>
          )}
          <Button
            variant="primary"
            icon="users"
            className="am-handover"
            disabled={!!enterprise.archived}
            onClick={() => setOpen(true)}
          >
            Hand over to someone else
          </Button>
        </section>
        <section className="fsection am-history">
          <header>
            <div className="fsection-title">
              <h2>Assignment history</h2>
            </div>
          </header>
          {periods.isError && <p className="error-text">{(periods.error as Error).message}</p>}
          <ol className="am-timeline">
            {list.map((p, i) => {
              const start = Date.parse(p.startsAt);
              const isCurrent = p === current;
              const scheduled = start > now;
              return (
                <li key={`${p.userId}-${p.startsAt}`} className={isCurrent ? "current" : scheduled ? "scheduled" : ""}>
                  <span className="am-dot" aria-hidden="true" />
                  <div className="am-entry">
                    <div>
                      <span className="strong">{p.userName}</span>
                      {isCurrent && <span className="chip-tag blue">Current</span>}
                      {scheduled && <span className="chip-tag amber">Scheduled</span>}
                      <div className="muted small">
                        {p.note ?? (i === list.length - 1 ? "Initial assignment" : "Handover")}
                      </div>
                    </div>
                    <span className="muted small tnum am-when">
                      {dayTime(p.startsAt)} → {p.endsAt ? dayTime(p.endsAt) : "now"}
                    </span>
                  </div>
                </li>
              );
            })}
          </ol>
        </section>
      </div>
      <PartnerAm enterprise={enterprise} />
      {open && <HandoverDialog enterprise={enterprise} onClose={() => setOpen(false)} />}
    </>
  );
}
