// Staff sign-in (backend step 9, §13.28): username and password, then the 2FA code at every login (product owner
// 2026-10-25): from the authenticator app, or the code e-mailed to the user (with Send again). Shown whenever the
// server answers 401 sign_in_required; after signing in the window reloads so every page starts as this user.
import { useEffect, useState, type FormEvent } from "react";
import type { SignInResult } from "@sms/contract";
import { api, ApiError, SIGN_IN_REQUIRED_EVENT, unwrap } from "../api/client";
import { BrandLogo } from "../ui/BrandLogo";
import { Button } from "../ui/primitives";
import { UsernameHint, looksLikeCode } from "../ui/UsernameHint";

/** True once any call answered 401 sign_in_required (no session, or it ended: idle 8 h, 24 h, signed out elsewhere). */
export function useSignInRequired(): boolean {
  const [required, setRequired] = useState(false);
  useEffect(() => {
    const on = () => setRequired(true);
    window.addEventListener(SIGN_IN_REQUIRED_EVENT, on);
    return () => window.removeEventListener(SIGN_IN_REQUIRED_EVENT, on);
  }, []);
  return required;
}

/** Ends this session and shows the sign-in screen. */
export async function signOut() {
  try {
    await api.DELETE("/session");
  } finally {
    location.reload();
  }
}

const message = (e: unknown) => (e instanceof ApiError ? e.message : "Something went wrong. Try again.");


export function SignInScreen() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<SignInResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (call: () => Promise<SignInResult>) => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const res = await call();
      if (res.status === "signed_in") location.reload();
      else setStep(res);
    } catch (e) {
      // An expired challenge (10 minutes, 5 tries) goes back to the password.
      if (e instanceof ApiError && e.problem.code === "challenge_expired") {
        setStep(null);
        setCode("");
      }
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  const submitPassword = (e: FormEvent) => {
    e.preventDefault();
    void run(() => unwrap(api.POST("/session", { body: { username, password } })));
  };
  const submitCode = (e: FormEvent) => {
    e.preventDefault();
    if (step?.challenge)
      void run(() => unwrap(api.POST("/session/code", { body: { challenge: step.challenge!, code } })));
  };
  const resend = async () => {
    if (!step?.challenge) return;
    setError(null);
    try {
      const res = await unwrap(api.POST("/session/code/resend", { body: { challenge: step.challenge } }));
      setStep(res);
      setNote(`A new code was sent to ${res.sentTo}.`);
    } catch (e) {
      setError(message(e));
    }
  };

  return (
    <div className="pw-gate" role="main">
      {!step ? (
        <form className="pw-gate-card signin-card" onSubmit={submitPassword}>
          <BrandLogo height={36} className="pw-gate-brand" />
          <h1>Sign in</h1>
          <label className="signin-field">
            <span>Username</span>
            <input
              autoFocus
              id="username"
              name="username"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              aria-describedby={looksLikeCode(username) ? "username-code-hint" : undefined}
            />
          </label>
          {/* A browser that saved an earlier sign-in code as the username fills it in here (§13.28); the code step
              no longer lets that happen, but an entry saved before stays until the user corrects it. */}
          {looksLikeCode(username) && (
            <p id="username-code-hint" className="muted small">
              This looks like a sign-in code, not a username. If your browser filled it in, type your username instead
              and let the browser update its saved login.
            </p>
          )}
          <label className="signin-field">
            <span>Password</span>
            <input
              type="password"
              id="current-password"
              name="current-password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          {error && <p className="error-text">{error}</p>}
          <div className="pw-gate-actions">
            <Button variant="primary" type="submit" disabled={!username || !password || busy}>
              Sign in
            </Button>
          </div>
          <p className="muted small">
            Forgot your password? Ask an administrator for a temporary one or an e-mailed set-password link.
          </p>
        </form>
      ) : (
        <form className="pw-gate-card signin-card" onSubmit={submitCode}>
          {/* The password is saved with this username, not with the code typed below (§13.28). */}
          <UsernameHint username={username} />
          <BrandLogo height={36} className="pw-gate-brand" />
          <h1>Enter your code</h1>
          <p className="muted">
            {step.method === "authenticator"
              ? "Open your authenticator app and enter the 6-digit code for Xpert (shown as SMS Platform if you set it up before the new name)."
              : `We e-mailed a 6-digit code to ${step.sentTo}. It works for 10 minutes.`}
          </p>
          <label className="signin-field">
            <span>Code</span>
            <input
              autoFocus
              id="one-time-code"
              name="one-time-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            />
          </label>
          {error && <p className="error-text">{error}</p>}
          {note && <p className="muted small">{note}</p>}
          <div className="pw-gate-actions signin-actions">
            <Button
              type="button"
              onClick={() => {
                setStep(null);
                setCode("");
                setError(null);
              }}
            >
              Back
            </Button>
            {step.method === "email" && (
              <Button type="button" onClick={() => void resend()}>
                Send again
              </Button>
            )}
            <Button variant="primary" type="submit" disabled={code.length !== 6 || busy}>
              Sign in
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
