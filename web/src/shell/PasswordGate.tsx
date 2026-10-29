// Monthly password change (§13.28) in the shell:
// - a top-bar reminder from the first reminder day (7, 3, 1 days by default) with Change now;
// - when the password expired, is temporary or must be changed, only the Change Password screen shows.
//   A session already open is sent there on its next action: any call answering 403
//   password_change_required raises the screen at once.
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { PASSWORD_REQUIRED_EVENT } from "../api/client";
import { useMe } from "../api/hooks";
import { useMyPasswordStatus } from "../api/security";
import { openMyPassword, PasswordChangeForm } from "../pages/admin/parts";
import { BrandLogo } from "../ui/BrandLogo";
import { Button } from "../ui/primitives";

/** True while only the Change Password screen may show. A 403 password_change_required refreshes the status at once. */
export function usePasswordBlocked(): boolean {
  const status = useMyPasswordStatus();
  const qc = useQueryClient();
  useEffect(() => {
    const on = () => void qc.invalidateQueries({ queryKey: ["password-status"] });
    window.addEventListener(PASSWORD_REQUIRED_EVENT, on);
    return () => window.removeEventListener(PASSWORD_REQUIRED_EVENT, on);
  }, [qc]);
  return !!status.data?.blocked;
}

const REASON = {
  expired: "Your password has expired.",
  temporary: "You signed in with a temporary password.",
  must_change: "An administrator asked you to change your password.",
} as const;

export function ChangePasswordScreen() {
  const { data: me } = useMe();
  const status = useMyPasswordStatus();
  const qc = useQueryClient();
  const state = status.data?.state;
  return (
    <div className="pw-gate" role="main">
      <div className="pw-gate-card">
        <BrandLogo height={36} className="pw-gate-brand" />
        <h1>Change your password</h1>
        <p>
          {state && state in REASON ? REASON[state as keyof typeof REASON] : "Your password must be changed."} Choose a
          new one to continue: no other page works until then.
        </p>
        {me ? (
          <PasswordChangeForm
            userId={me.id}
            onChanged={() => {
              void qc.invalidateQueries();
            }}
            wrap={(body, submit) => (
              <>
                {body}
                <div className="pw-gate-actions">{submit}</div>
              </>
            )}
          />
        ) : (
          <p className="muted">Loading…</p>
        )}
      </div>
    </div>
  );
}

export function PasswordBanner() {
  const { data: me } = useMe();
  const status = useMyPasswordStatus();
  const [hidden, setHidden] = useState(false);
  const s = status.data;
  if (!s || !s.banner || s.blocked || hidden || !me) return null;
  const when = s.daysLeft <= 0 ? "today" : s.daysLeft === 1 ? "tomorrow" : `in ${s.daysLeft} days`;
  return (
    <div className="pw-banner" role="status">
      <strong>Your password expires {when}</strong>
      <span className="muted small">
        ({s.expiresAt.slice(0, 10)}). After that, only the Change Password screen works.
      </span>
      <Button icon="lock" onClick={() => void openMyPassword(me.id)}>
        Change now
      </Button>
      <Button onClick={() => setHidden(true)}>Later</Button>
    </div>
  );
}
