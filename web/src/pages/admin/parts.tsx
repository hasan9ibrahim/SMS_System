// Shared Admin pieces (§11, §13.28): the live password-rule checklist, the temporary password dialog
// (Change Others Passwd, users and portal logins), the signed-in user's own password change and the
// status cell.
import { useEffect, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { PasswordCheckInput } from "@sms/contract";
import { useChangeMyPassword, usePasswordCheck } from "../../api/admin";
import { ApiError } from "../../api/client";
import { ask, toast } from "../../ui/feedback";
import { Icon } from "../../ui/Icon";
import { Button, Modal, StatusDot } from "../../ui/primitives";
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
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  error?: string | undefined;
  autoFocus?: boolean;
  autoComplete?: string;
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
  if (e instanceof ApiError)
    for (const x of (e.problem.errors ?? []) as { path: string; message: string }[]) out[x.path] ??= x.message;
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
        The user must change it at first login. It is valid 24 hours, and their open sessions are signed out (§13.28).
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

/** §13.28: my own change - current password, the 2FA code, the rules; other sessions sign out. */
/**
 * The Change Password form (§13.28): current password, new password with each rule as it is met, and
 * the 2FA code. `wrap` places it in a dialog or on the blocking Change Password screen.
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
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [code, setCode] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const submit = () =>
    change.mutate(
      { currentPassword: current, newPassword: next, totpCode: code.trim() || null },
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
      <PasswordInput
        label="Current password *"
        value={current}
        onChange={setCurrent}
        error={errors["/currentPassword"]}
        autoComplete="current-password"
        autoFocus
      />
      <PasswordInput label="New password *" value={next} onChange={setNext} error={errors["/newPassword"]} />
      <PasswordInput
        label="Confirm new password *"
        value={confirm}
        onChange={setConfirm}
        error={confirm && confirm !== next ? "the passwords do not match" : undefined}
      />
      <PasswordRules input={{ password: next, userId }} />
      <label className={`field${errors["/totpCode"] ? " invalid" : ""}`}>
        <span>2FA code (from your authenticator app)</span>
        <input
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
        />
        {errors["/totpCode"] && <span className="ff-error">{errors["/totpCode"]}</span>}
      </label>
      <p className="muted small">Changing the password signs you out of every other session and device.</p>
    </div>,
    <Button
      variant="primary"
      icon="lock"
      disabled={change.isPending || !current || !next || next !== confirm}
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
