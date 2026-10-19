// Email Logs (§8): Info ID, Enterprise, Customer Trunk, Vendor Trunk, Email Type, Status, Rate Date,
// File, Error, To / CC Address, Updated By / Time; the detail shows the e-mail itself, as designed (§11).
import type { EmailLogRow } from "@sms/contract";
import { downloadCsv } from "../../../api/masterData";
import { useEmailLog } from "../../../api/switchTools";
import { toListQuery } from "../../../grid/filterModel";
import { pageForPath } from "../../../nav/registry";
import { ListScreen } from "../../../page/ListScreen";
import { toast } from "../../../ui/feedback";
import { MailFrame } from "../../../ui/MailPreview";
import { StatusDot } from "../../../ui/primitives";
import { problemText } from "../../routing/dialogs";
import { fmtWhen } from "../../reference/shared";
import { EMAIL_TYPE } from "./toolsModel";

const page = pageForPath("/switch/email-logs")!;
const muted = (v: string) => <span className="muted">{v}</span>;

function EmailView({ id }: { id: number }) {
  const q = useEmailLog(id);
  const m = q.data;
  if (!m) return <p className="muted">{q.isError ? problemText(q.error) : "Loading…"}</p>;
  return (
    <div className="mail-preview">
      <div className="small">
        <strong>From:</strong> {m.sender ?? "—"}
      </div>
      <div className="small">
        <strong>To:</strong> {m.to.join(", ") || "—"}
        {m.cc.length > 0 && (
          <>
            {" "}
            · <strong>CC:</strong> {m.cc.join(", ")}
          </>
        )}
      </div>
      <div className="small">
        <strong>Subject:</strong> {m.subject}
      </div>
      {m.file && (
        <div className="small">
          <strong>File:</strong> {m.file}
        </div>
      )}
      {m.error && <div className="small tone-error">{m.error}</div>}
      {m.inlineImages.length > 0 && (
        <div className="small muted">
          {m.inlineImages.length} image{m.inlineImages.length === 1 ? "" : "s"} embedded in the e-mail
        </div>
      )}
      {m.bodyHtml ? (
        // The e-mail as sent (§11): the designed HTML, in a sandboxed frame.
        <MailFrame html={m.bodyHtml} height={520} />
      ) : (
        <pre>{m.body || "(no body kept)"}</pre>
      )}
    </div>
  );
}

export function EmailLogsPage() {
  return (
    <ListScreen<EmailLogRow>
      list="email_logs"
      page={page}
      noSelection
      historyScope={null}
      onExport={(s) =>
        void downloadCsv("/email-logs/export", toListQuery(s)).catch((e) =>
          toast({ tone: "error", message: problemText(e) }),
        )
      }
      columns={{
        id: { width: 90 },
        enterprise: { width: 210, render: (r) => r.enterprise ?? muted("—") },
        customerTrunk: { width: 170, render: (r) => r.customerTrunk ?? muted("—") },
        vendorTrunk: { width: 170, render: (r) => r.vendorTrunk ?? muted("—") },
        emailType: { width: 170, render: (r) => EMAIL_TYPE[r.emailType] },
        status: {
          width: 100,
          render: (r) => (
            <span>
              <StatusDot tone={r.status === "sent" ? "good" : "error"} /> {r.status === "sent" ? "Sent" : "Failed"}
            </span>
          ),
        },
        rateDate: { width: 110, render: (r) => r.rateDate ?? muted("—") },
        file: { width: 200, render: (r) => r.file ?? muted("—") },
        error: {
          width: 240,
          render: (r) =>
            r.error ? (
              <span className="tone-error" title={r.error}>
                {r.error}
              </span>
            ) : (
              muted("—")
            ),
        },
        to: { width: 240, render: (r) => r.to.join(", ") || muted("—") },
        updatedBy: { width: 130, render: (r) => r.updatedBy ?? muted("platform") },
        updatedAt: { width: 170, render: (r) => fmtWhen(r.updatedAt) },
      }}
      detail={(r) => ({
        title: (
          <>
            <strong>{r.subject}</strong>
            <span className="muted">
              {EMAIL_TYPE[r.emailType]} · {fmtWhen(r.updatedAt)}
            </span>
          </>
        ),
        sections: [{ key: "email", label: "E-mail", content: <EmailView id={r.id} /> }],
      })}
      shortcuts="↑↓ move"
    />
  );
}
