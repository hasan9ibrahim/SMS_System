// E-mail password links (team trial round 11, §13.28): from Users (one user or the selected ones) and from an applied
// Migration Center import (the users it created). Each user gets a single-use link that works for 72 hours to choose
// a password; it never signs anyone in. The result names the users skipped and the addresses that got links for
// several users, since whoever reads that mailbox can use them.
import { useState } from "react";
import type { PasswordLinksResult } from "@sms/contract";
import { useSendPasswordLinks } from "../../api/admin";
import { problemText } from "../routing/dialogs";
import { ask, toast } from "../../ui/feedback";
import { Button, Modal } from "../../ui/primitives";

function PasswordLinksDialog({ ids, what, done }: { ids: number[]; what: string; done: () => void }) {
  const send = useSendPasswordLinks();
  const [result, setResult] = useState<PasswordLinksResult | null>(null);
  const go = () =>
    send.mutate(ids, {
      onSuccess: (r) => {
        setResult(r);
        if (!r.skipped.length && !r.sharedEmails.length) {
          toast({ tone: "good", message: `Password link e-mailed to ${r.sent} user${r.sent === 1 ? "" : "s"}` });
          done();
        }
      },
      onError: (e) => toast({ tone: "error", message: problemText(e) }),
    });
  return (
    <Modal
      title="E-mail password links"
      onClose={done}
      width={520}
      footer={
        result ? (
          <Button variant="primary" onClick={done}>
            Close
          </Button>
        ) : (
          <>
            <Button onClick={done}>Cancel</Button>
            <Button variant="primary" disabled={send.isPending} onClick={go}>
              {send.isPending ? "Sending…" : `E-mail ${ids.length === 1 ? "the link" : `${ids.length} links`}`}
            </Button>
          </>
        )
      }
    >
      {!result ? (
        <>
          <p className="small">
            {what} get{ids.length === 1 ? "s" : ""} an e-mail with a link to choose a password. Each link works once, for
            72 hours, and replaces any earlier link. It does not sign them in: they then sign in as usual, with the
            sign-in code.
          </p>
          <p className="small muted">
            Send it only to addresses the user alone reads: whoever opens the link sets the password.
          </p>
        </>
      ) : (
        <>
          <p className="small">
            <strong>{result.sent}</strong> link{result.sent === 1 ? "" : "s"} e-mailed; they work until{" "}
            {result.expiresAt.slice(0, 16).replace("T", " ")} UTC.
          </p>
          {result.sharedEmails.length > 0 && (
            <div className="small">
              <p className="tone-warning">
                These addresses got links for several users: whoever reads that mailbox can set those passwords. Give
                each user their own address, or set a temporary password for them instead.
              </p>
              <ul>
                {result.sharedEmails.map((s) => (
                  <li key={s.email}>
                    {s.email}: {s.usernames.join(", ")}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {result.skipped.length > 0 && (
            <div className="small">
              <p>Not sent:</p>
              <ul>
                {result.skipped.map((s) => (
                  <li key={s.userId}>
                    {s.username}: {s.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </Modal>
  );
}

/** Opens the dialog for these users; `what` names them in the text ("test.user", "17 users"). */
export const openPasswordLinks = (ids: number[], what: string) =>
  ask<void>((d) => <PasswordLinksDialog ids={ids} what={what} done={() => d()} />);
