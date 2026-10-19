// Visibility preview (§13.17): while an administrator views the system as another user (X-View-As),
// a strip under the tabs says whose view it is and which policy applies, with a way back.
import { useState } from "react";
import { getViewAs } from "../api/client";
import { useMyVisibility } from "../api/visibility";
import { effectiveLine } from "../pages/admin/visibility/visibilityModel";
import { usePreviewAs } from "../pages/admin/visibility/VisibilityPage";
import { ListLookup } from "../records/parts";
import { Button, Modal } from "../ui/primitives";

export function ViewAsBanner() {
  const v = useMyVisibility();
  const previewAs = usePreviewAs();
  if (!getViewAs() || !v.data?.viewAs) return null;
  return (
    <div className="viewas-banner" role="status">
      <strong>Previewing as {v.data.userName}</strong>
      <span>{effectiveLine(v.data)}</span>
      <span className="muted small">
        Lists, records, search and exports answer as this user sees them; live feeds do not.
      </span>
      <Button onClick={() => previewAs(null)}>End preview</Button>
    </div>
  );
}

/** Picks a user to preview as (administrators). */
export function ViewAsDialog({ done }: { done: (v: null) => void }) {
  const previewAs = usePreviewAs();
  const [user, setUser] = useState<{ id: number; name: string } | null>(null);
  return (
    <Modal
      title="View as user"
      onClose={() => done(null)}
      footer={
        <>
          <Button onClick={() => done(null)}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!user}
            onClick={() => {
              previewAs(user);
              done(null);
            }}
          >
            Preview
          </Button>
        </>
      }
    >
      <div className="field">
        <span>User</span>
        <ListLookup<{ id: number; displayName: string; username: string; isAccountManager: boolean }>
          list="users"
          value={user?.id ?? null}
          onChange={(r) => setUser(r ? { id: r.id, name: r.displayName } : null)}
          labelOf={(r) => `${r.displayName} (${r.username})`}
          detailOf={(r) => (r.isAccountManager ? "Account manager" : "")}
          placeholder="Choose a user…"
        />
      </div>
      <p className="muted small">
        See the system with that user&apos;s visibility policy (§13.17): others&apos; enterprises masked, hidden values
        withheld. Your own rights do not change; saves to masked records are refused.
      </p>
    </Modal>
  );
}
