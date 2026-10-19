// How an e-mail looks (§11, team trial round 1): in the system and modern mail apps, in classic Outlook
// for Windows (an approximation of its Word engine), and on a phone, with what will differ and where.
// Every view is a sandboxed frame: template HTML never runs in the app.
import { useState } from "react";
import type { EmailCompatIssue, EmailTemplatePreview } from "@sms/contract";
import { CLIENT_LABEL, isHtml } from "./mailModel";

/** One e-mail document in a sandboxed frame; plain HTML fragments get a neutral body. */
export function MailFrame({
  subject,
  html,
  height = 480,
  width,
}: {
  subject?: string;
  html: string;
  height?: number;
  width?: number;
}) {
  const doc = /<html[\s>]/i.test(html)
    ? html
    : `<!doctype html><meta charset="utf-8"><body style="font:13px/1.5 Arial,Helvetica,sans-serif;margin:10px;color:#1f2937">${html}</body>`;
  return (
    <div className="mail-preview">
      {subject !== undefined && (
        <div className="small">
          <strong>Subject:</strong> {subject}
        </div>
      )}
      <iframe
        className="mail-frame"
        title="E-mail preview"
        sandbox=""
        srcDoc={doc}
        style={{ height, ...(width ? { width, margin: "0 auto", display: "block" } : {}) }}
      />
    </div>
  );
}

/** An e-mail body in a preview: designed (HTML) bodies as they look, plain text as text. */
export function MailBody({ body, height = 380 }: { body: string; height?: number }) {
  return isHtml(body) ? <MailFrame html={body} height={height} /> : <pre>{body}</pre>;
}

type View = "system" | "outlook" | "phone";
const VIEWS: { key: View; label: string; hint: string }[] = [
  {
    key: "system",
    label: "In the system",
    hint: "As the system shows it in Email Logs, and as new Outlook, Outlook on the web, Outlook for Mac, Gmail and Apple Mail show it.",
  },
  {
    key: "outlook",
    label: "Outlook for Windows",
    hint: "An approximation of classic Outlook 2016–2021 / Microsoft 365 on Windows, which draws e-mails with Word: what it ignores is removed here. Send a test to see the real thing.",
  },
  { key: "phone", label: "Phone", hint: "A 375 px wide screen (Outlook and Mail apps on a phone)." },
];

export function IssueList({ issues }: { issues: EmailCompatIssue[] }) {
  if (!issues.length)
    return (
      <p className="small tone-good">No compatibility problems found: it should look the same in every mail app.</p>
    );
  return (
    <ul className="mail-issues">
      {issues.map((i) => (
        <li key={i.feature + i.message} className={i.level === "warning" ? "warn" : ""}>
          <span className={`mail-issue-level ${i.level}`}>{i.level === "warning" ? "Check" : "Note"}</span>
          <span>
            {i.message}
            {i.count > 1 && <span className="muted"> ({i.count} places)</span>}
            <span className="mail-clients">
              {i.clients.map((c) => (
                <span key={c} className="chip small">
                  {CLIENT_LABEL[c] ?? c}
                </span>
              ))}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** The three views and the compatibility list for a template preview. */
export function MailPreview({ preview, sender }: { preview: EmailTemplatePreview; sender?: string | null }) {
  const [view, setView] = useState<View>("system");
  const current = VIEWS.find((v) => v.key === view)!;
  const warnings = preview.issues.filter((i) => i.level === "warning").length;
  return (
    <div className="mail-views">
      <div className="segmented small" role="tablist" aria-label="Preview">
        {VIEWS.map((v) => (
          <button
            key={v.key}
            type="button"
            role="tab"
            aria-selected={view === v.key}
            className={view === v.key ? "on" : ""}
            onClick={() => setView(v.key)}
          >
            {v.label}
          </button>
        ))}
      </div>
      <p className="muted small">{current.hint}</p>
      <div className={`mail-chrome ${view}`}>
        <div className="mail-chrome-head small">
          {sender && (
            <div>
              <span className="muted">From</span> {sender}
            </div>
          )}
          <div>
            <span className="muted">Subject</span> <strong>{preview.subject || "(no subject)"}</strong>
          </div>
        </div>
        <MailFrame
          html={view === "outlook" ? preview.outlookHtml : preview.emailHtml}
          height={view === "phone" ? 560 : 460}
          width={view === "phone" ? 375 : undefined}
        />
      </div>
      <h4 className="mail-issues-title">
        Compatibility{" "}
        {warnings > 0 ? (
          <span className="tone-warning">· {warnings} to check</span>
        ) : (
          <span className="muted">· {preview.issues.length} notes</span>
        )}
      </h4>
      <IssueList issues={preview.issues} />
    </div>
  );
}
