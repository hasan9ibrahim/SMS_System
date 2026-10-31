// Shared Admin pieces (§11, §13.28): the live password-rule checklist, the temporary password dialog
// (Change Others Passwd, users and portal logins), the signed-in user's own password change and the
// status cell.
import { useEffect, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { PasswordCheckInput } from "@sms/contract";
import { sendMyPasswordCode, useChangeMyPassword, usePasswordCheck } from "../../api/admin";
import { useMyPasswordStatus } from "../../api/security";
import { useMe } from "../../api/hooks";
import { ApiError } from "../../api/client";
import { problemFields } from "../../api/problems";
import { ask, toast } from "../../ui/feedback";
import { Icon } from "../../ui/Icon";
import { Button, Modal, StatusDot } from "../../ui/primitives";
import { UsernameHint } from "../../ui/UsernameHint";
import { problemText } from "../routing/dialogs";

export const statusCell = (status: "active" | "inactive") => (
  <span>
    <StatusDot tone={status === "active" ? "good" : "neutral"} /> {status === "active" ? "Active" : "Inactive"}
  </span>
);

function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** §13.28: each rule ticks as it is met while the password is typed. */
export function PasswordRules({ input }: { input: PasswordCheckInput }) {
  const debounced = useDebounced(input);
  const check = usePasswordCheck(debounced.password ? debounced : null);
  const rules = check.data?.rules ?? [
    { key: "length", label: "At least 12 characters", met: false },
    { key: "not_name", label: "Not your username or name", met: false },
    { key: "not_recent", label: "Not one of your last 12 passwords", met: false },
    { key: "not_leaked", label: "Not on a known-leaked password list", met: false },
  ];
  return (
    <ul className="pw-rules" aria-live="polite">
      {rules.map((r) => {
        const met = !!input.password && r.met && debounced.password === input.password;
        return (
          <li key={r.key} className={met ? "met" : ""}>
            <Icon name={met ? "check" : "minus"} size={13} /> {r.label}
          </li>
        );
      })}
    </ul>
  );
}

function PasswordInput({
  label,
  value,
  onChange,
  error,
  autoFocus,
  autoComplete = "new-password",
  name,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  error?: string | undefined;
  autoFocus?: boolean;
  autoComplete?: string;
  /** Stable name for password managers (current-password, new-password, confirm-password). */
  name?: string;
}) {
  const [show, setShow] = useState(false);
  return (
    <label className={`field${error ? " invalid" : ""}`}>
      <span>{label}</span>
      <span className="pw-input">
        <input
          type={show ? "text" : "password"}
          value={value}
          maxLength={200}
          autoFocus={autoFocus}
          autoComplete={autoComplete}
          name={name}
          onChange={(e) => onChange(e.target.value)}
        />
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShow((s) => !s)}>
          {show ? "Hide" : "Show"}
        </button>
      </span>
      {error && <span className="ff-error">{error}</span>}
    </label>
  );
}

const fieldErrors = (e: unknown): Record<string, string> => {
  const out: Record<string, string> = {};
  if (e instanceof ApiError) for (const x of problemFields(e.problem)) out[x.path || "/"] ??= x.message;
  return out;
};

/** Change Others Passwd (§11, §13.28): a temporary password valid 24 hours. */
function TempPasswordDialog({
  who,
  checkInput,
  save,
  done,
}: {
  who: string;
  checkInput: Omit<PasswordCheckInput, "password">;
  save: (input: { password: string; confirmPassword: string }) => Promise<unknown>;
  done: () => void;
}) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      await save({ password, confirmPassword: confirm });
      toast({ tone: "good", message: `Temporary password set for ${who}. It is valid 24 hours.` });
      done();
    } catch (e) {
      setErrors(fieldErrors(e));
      if (!Object.keys(fieldErrors(e)).length) toast({ tone: "error", message: problemText(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={`Change password – ${who}`}
      width={480}
      onClose={done}
      footer={
        <>
          <Button onClick={done}>Cancel</Button>
          <Button
            variant="primary"
            icon="key"
            disabled={busy || !password || password !== confirm}
            onClick={() => void submit()}
          >
            Set temporary password
          </Button>
        </>
      }
    >
      <p className="muted small">
        Valid 24 hours, changed at first login. Open sessions are signed out.
      </p>
      <div className="fgrid cols-1">
        <PasswordInput
          label="New Password *"
          value={password}
          onChange={setPassword}
          error={errors["/password"]}
          autoFocus
        />
        <PasswordInput
          label="Confirm Password *"
          value={confirm}
          onChange={setConfirm}
          error={
            errors["/confirmPassword"] ?? (confirm && confirm !== password ? "the passwords do not match" : undefined)
          }
        />
        <PasswordRules input={{ ...checkInput, password }} />
      </div>
    </Modal>
  );
}

export const openTempPassword = (
  who: string,
  checkInput: Omit<PasswordCheckInput, "password">,
  save: (input: { password: string; confirmPassword: string }) => Promise<unknown>,
) => ask<void>((d) => <TempPasswordDialog who={who} checkInput={checkInput} save={save} done={() => d()} />);

/**
 * The Change Password form (§13.28): current password, new password with each rule as it is met, and a code -
 * always (decided 2026-10-24, R6): the authenticator code when 2FA is on, otherwise a code e-mailed on request.
 * `wrap` places it in a dialog or on the blocking Change Password screen.
 */
export function PasswordChangeForm({
  userId,
  onChanged,
  wrap,
}: {
  userId: number;
  onChanged: () => void;
  wrap: (body: ReactNode, submit: ReactNode) => ReactNode;
}) {
  const change = useChangeMyPassword();
  const qc = useQueryClient();
  const { data: me } = useMe();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [code, setCode] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const status = useMyPasswordStatus();
  const totp = status.data?.totpEnabled ?? false;
  const [sent, setSent] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const sendCode = () => {
    setSending(true);
    sendMyPasswordCode()
      .then((r) => {
        setSent(r.sentTo);
        setErrors((e) => ({ ...e, "/emailCode": "" }));
      })
      .catch((e: unknown) => toast({ tone: "error", message: problemText(e) }))
      .finally(() => setSending(false));
  };
  const codeKey = totp ? "/totpCode" : "/emailCode";
  const submit = () =>
    change.mutate(
      {
        currentPassword: current,
        newPassword: next,
        totpCode: totp ? code.trim() || null : null,
        emailCode: totp ? null : code.trim() || null,
      },
      {
        onSuccess: (r) => {
          toast({
            tone: "good",
            message: `Password changed. ${r.signedOutSessions ? `${r.signedOutSessions} other session(s) signed out. ` : ""}Next change by ${r.expiresAt.slice(0, 10)}.`,
          });
          // The top-bar reminder and the Change Password screen follow the new expiry (§13.28).
          void qc.invalidateQueries({ queryKey: ["password-status"] });
          onChanged();
        },
        onError: (e) => {
          setErrors(fieldErrors(e));
          if (!Object.keys(fieldErrors(e)).length) toast({ tone: "error", message: problemText(e) });
        },
      },
    );
  return wrap(
    <div className="fgrid cols-1">
      {/* The new password is saved for this username, not for the code typed below (§13.28). */}
      {me && <UsernameHint username={me.username} />}
      <PasswordInput
        label="Current password *"
        value={current}
        onChange={setCurrent}
        error={errors["/currentPassword"]}
        autoComplete="current-password"
        name="current-password"
        autoFocus
      />
      <PasswordInput
        label="New password *"
        value={next}
        onChange={setNext}
        error={errors["/newPassword"]}
        name="new-password"
      />
      <PasswordInput
        label="Confirm new password *"
        value={confirm}
        name="confirm-password"
        onChange={setConfirm}
        error={confirm && confirm !== next ? "the passwords do not match" : undefined}
      />
      <PasswordRules input={{ password: next, userId }} />
      <label className={`field${errors[codeKey] ? " invalid" : ""}`}>
        <span>{totp ? "2FA code (from your authenticator app) *" : "Code sent to your e-mail *"}</span>
        <span className="pw-code">
          <input
            name="one-time-code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
          />
          {!totp && (
            <Button icon="mail" onClick={sendCode} disabled={sending || status.isLoading}>
              {sent ? "Send again" : "Send code"}
            </Button>
          )}
        </span>
        {errors[codeKey] && <span className="ff-error">{errors[codeKey]}</span>}
        {!totp && sent && !errors[codeKey] && (
          <span className="muted small">Sent to {sent}. It works for 10 minutes.</span>
        )}
      </label>
      <p className="muted small">Changing the password signs you out of every other session and device.</p>
    </div>,
    <Button
      variant="primary"
      icon="lock"
      disabled={change.isPending || !current || !next || next !== confirm || code.length !== 6}
      onClick={submit}
    >
      Change password
    </Button>,
  );
}

function MyPasswordDialog({ userId, done }: { userId: number; done: () => void }) {
  return (
    <PasswordChangeForm
      userId={userId}
      onChanged={done}
      wrap={(body, submit) => (
        <Modal
          title="Change my password"
          width={480}
          onClose={done}
          footer={
            <>
              <Button onClick={done}>Cancel</Button>
              {submit}
            </>
          }
        >
          {body}
        </Modal>
      )}
    />
  );
}

export const openMyPassword = (userId: number) =>
  ask<void>((d) => <MyPasswordDialog userId={userId} done={() => d()} />);

export function Kv({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="kv">
      {items.map(([k, v]) => (
        <div key={k} style={{ display: "contents" }}>
          <dt>{k}</dt>
          <dd>{v ?? <span className="muted">—</span>}</dd>
        </div>
      ))}
    </dl>
  );
}
