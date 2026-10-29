// The Set Password screen a set-password link opens (team trial round 11, §13.28): /set-password#<token>. No sign-in:
// the token is the proof. The user picks a password under the usual rules (each ticks as it is met), then signs in
// on the sign-in screen as usual, 2FA included; the link never signs anyone in. The token sits after # so it never
// reaches a server log, and it leaves the address bar as soon as it is read.
import { useEffect, useState, type FormEvent } from "react";
import type { PasswordSetupInfo } from "@sms/contract";
import { checkPasswordSetup, completePasswordSetup } from "../api/admin";
import { ApiError } from "../api/client";
import { BrandLogo } from "../ui/BrandLogo";
import { Icon } from "../ui/Icon";
import { Button } from "../ui/primitives";

const message = (e: unknown) => (e instanceof ApiError ? e.message : "Something went wrong. Try again.");

export function SetPasswordScreen() {
  const [token] = useState(() => decodeURIComponent(location.hash.replace(/^#/, "")));
  const [info, setInfo] = useState<PasswordSetupInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [rules, setRules] = useState<PasswordSetupInfo["rules"]>([]);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    history.replaceState(null, "", location.pathname);
    if (!token) return setError("This link is incomplete. Open the whole link from the e-mail.");
    checkPasswordSetup(token, null)
      .then((i) => {
        setInfo(i);
        setRules(i.rules);
      })
      .catch((e: unknown) => setError(message(e)));
  }, [token]);

  // Each rule ticks as it is met (checked on the server: the last passwords and the leaked list live there).
  useEffect(() => {
    if (!info) return;
    const t = setTimeout(() => {
      checkPasswordSetup(token, password || null)
        .then((i) => setRules(i.rules))
        .catch(() => undefined);
    }, 300);
    return () => clearTimeout(t);
  }, [password, info, token]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    completePasswordSetup({ token, password, confirmPassword: confirm })
      .then(() => setDone(true))
      .catch((err: unknown) => {
        const errors = err instanceof ApiError ? (err.problem.errors as { message: string }[] | undefined) : undefined;
        setError(errors?.length ? errors.map((x) => x.message).join("; ") : message(err));
      })
      .finally(() => setBusy(false));
  };

  const allMet = rules.length > 0 && rules.every((r) => r.met);
  return (
    <div className="pw-gate" role="main">
      <form className="pw-gate-card signin-card" onSubmit={submit}>
        <BrandLogo height={36} className="pw-gate-brand" />
        {done ? (
          <>
            <h1>Password set</h1>
            <p className="muted">Sign in with your username, your new password and the sign-in code.</p>
            <div className="pw-gate-actions">
              <Button variant="primary" type="button" onClick={() => location.assign("/")}>
                Go to sign-in
              </Button>
            </div>
          </>
        ) : !info ? (
          <>
            <h1>Set your password</h1>
            {error ? <p className="error-text">{error}</p> : <p className="muted">Checking the link…</p>}
          </>
        ) : (
          <>
            <h1>Set your password</h1>
            <p className="muted">
              Hello {info.firstName}. Choose the password for <strong>{info.username}</strong>. This link works until{" "}
              {info.expiresAt.slice(0, 16).replace("T", " ")} UTC.
            </p>
            <label className="signin-field">
              <span>New password</span>
              <input
                type="password"
                autoFocus
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            <ul className="pw-rules" aria-live="polite">
              {rules.map((r) => (
                <li key={r.key} className={r.met ? "met" : ""}>
                  <Icon name={r.met ? "check" : "minus"} size={13} /> {r.label}
                </li>
              ))}
            </ul>
            <label className="signin-field">
              <span>Repeat it</span>
              <input
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
            </label>
            {confirm && confirm !== password && <p className="error-text">The two passwords differ.</p>}
            {error && <p className="error-text">{error}</p>}
            <div className="pw-gate-actions">
              <Button variant="primary" type="submit" disabled={!allMet || confirm !== password || busy}>
                Set password
              </Button>
            </div>
          </>
        )}
      </form>
    </div>
  );
}
