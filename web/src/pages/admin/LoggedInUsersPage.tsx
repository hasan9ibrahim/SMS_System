// Logged In Users (§11): Logged In At, User, User Type (Wholesale / Customer), IP Address, Location,
// Device, OS, Browser, with a per-row Force logout. The session making the request is marked and
// cannot be ended here.
import type { UserSessionRow } from "@sms/contract";
import { useEndSession } from "../../api/admin";
import { pageForPath } from "../../nav/registry";
import { ListScreen } from "../../page/ListScreen";
import { toast } from "../../ui/feedback";
import { Button } from "../../ui/primitives";
import { problemText } from "../routing/dialogs";
import { fmtWhen } from "../reference/shared";
import { Kv } from "./parts";

const page = pageForPath("/admin/logged-in")!;
const DEVICE = { desktop: "Desktop", mobile: "Mobile", tablet: "Tablet", bot: "Bot" } as const;

function LogoutButton({ r }: { r: UserSessionRow }) {
  const end = useEndSession();
  if (r.current) return <span className="muted small">This session</span>;
  return (
    <Button
      small
      icon="logout"
      disabled={end.isPending}
      onClick={(e) => {
        e.stopPropagation();
        if (!window.confirm(`Sign ${r.displayName} out of this session (${r.ip})?`)) return;
        end.mutate(r.id, {
          onSuccess: () => toast({ tone: "good", message: `${r.displayName} was signed out` }),
          onError: (err) => toast({ tone: "error", message: problemText(err) }),
        });
      }}
    >
      Force logout
    </Button>
  );
}

export function LoggedInUsersPage() {
  return (
    <ListScreen<UserSessionRow>
      list="user_sessions"
      page={page}
      noSelection
      historyScope={null}
      columns={{
        loggedInAt: { width: 170, render: (r) => fmtWhen(r.loggedInAt) },
        displayName: {
          width: 220,
          render: (r) => (
            <span>
              <strong>{r.displayName}</strong>
              {r.current && <span className="chip-mini">you</span>}
            </span>
          ),
        },
        userKind: { width: 120, render: (r) => (r.userKind === "staff" ? "Wholesale" : "Customer") },
        ip: { width: 150, render: (r) => <span className="mono">{r.ip}</span> },
        location: { width: 160 },
        device: { width: 100, render: (r) => DEVICE[r.device] },
        os: { width: 130 },
        browser: { width: 130 },
        lastSeenAt: { width: 170, render: (r) => fmtWhen(r.lastSeenAt) },
      }}
      trailing={{ header: "Action", width: 140, render: (r) => <LogoutButton r={r} /> }}
      detail={(r) => ({
        title: (
          <>
            <strong>{r.displayName}</strong>
            <span className="muted">
              {r.username} · {r.userKind === "staff" ? "Wholesale" : `Customer of ${r.enterprise ?? "—"}`}
            </span>
          </>
        ),
        sections: [
          {
            key: "session",
            label: "Session",
            actions: <LogoutButton r={r} />,
            content: (
              <Kv
                items={[
                  ["Logged in", fmtWhen(r.loggedInAt)],
                  ["Last seen", fmtWhen(r.lastSeenAt)],
                  ["IP address", r.ip],
                  ["Location", r.location],
                  ["Device", `${DEVICE[r.device]} · ${r.os} · ${r.browser}`],
                  ["Enterprise", r.enterprise],
                ]}
              />
            ),
          },
        ],
      })}
      shortcuts="↑↓ move"
    />
  );
}
