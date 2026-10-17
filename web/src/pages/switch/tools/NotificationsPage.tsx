// Notification (§8): customer trunks (Enterprise Name, Customer Trunk Name, Category, Protocol,
// Capacity, Status) with Send Rate (modal Customer Send Rate Information: File Type Excel / CSV,
// Send Email), Send Tech Info and View Rate. Every e-mail sent shows in Email Logs.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { EmailLogRow, NotificationResult, TrunkListRow } from "@sms/contract";
import { fetchListPage, type ListPage } from "../../../api/hooks";
import { downloadRateSheet, useNotificationPreview, useSendRate, useSendTechInfo } from "../../../api/switchTools";
import { pageForPath } from "../../../nav/registry";
import { ListScreen } from "../../../page/ListScreen";
import { useTabNavigate } from "../../../shell/tabContext";
import { ask, toast } from "../../../ui/feedback";
import { Button, Modal, StatusDot } from "../../../ui/primitives";
import { problemText } from "../../routing/dialogs";
import { fmtWhen } from "../../reference/shared";
import { EMAIL_TYPE } from "./toolsModel";

const page = pageForPath("/switch/notifications")!;

function report(r: NotificationResult, what: string) {
  if (r.sent)
    toast({ tone: "good", message: `${what} sent to ${r.sent} trunk${r.sent === 1 ? "" : "s"} · see Email Logs` });
  for (const f of r.failed.slice(0, 3)) toast({ tone: "error", message: `${f.trunk}: ${f.reason}` });
  if (r.failed.length > 3) toast({ tone: "error", message: `${r.failed.length - 3} more failed` });
}

function SendRateDialog({ ids, done }: { ids: number[]; done: () => void }) {
  const [fileType, setFileType] = useState<"excel" | "csv">("excel");
  const [sendEmail, setSendEmail] = useState(true);
  const [busy, setBusy] = useState(false);
  const send = useSendRate();
  const preview = useNotificationPreview(ids[0]!, "send_rate");
  const submit = async () => {
    setBusy(true);
    try {
      if (sendEmail) report(await send.mutateAsync({ trunkIds: ids, fileType, sendEmail }), "Rate sheet");
      else for (const id of ids.slice(0, 10)) await downloadRateSheet(id, fileType);
      done();
    } catch (e) {
      toast({ tone: "error", message: problemText(e) });
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Customer Send Rate Information"
      width={620}
      onClose={done}
      footer={
        <>
          <span className="muted small">
            {ids.length} trunk{ids.length === 1 ? "" : "s"}
          </span>
          <span className="fb-spacer" />
          <Button onClick={done}>Cancel</Button>
          <Button
            variant="primary"
            icon={sendEmail ? "mail" : "download"}
            disabled={busy}
            onClick={() => void submit()}
          >
            {sendEmail ? "Send" : ids.length > 10 ? "Download first 10" : "Download"}
          </Button>
        </>
      }
    >
      <div className="field">
        <span>File Type</span>
        <div className="segmented small" role="radiogroup" aria-label="File type">
          {(["excel", "csv"] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="radio"
              aria-checked={fileType === t}
              className={fileType === t ? "on" : ""}
              onClick={() => setFileType(t)}
            >
              {t === "excel" ? "Excel" : "CSV"}
            </button>
          ))}
        </div>
      </div>
      <label className="toggle-inline">
        <input type="checkbox" checked={sendEmail} onChange={(e) => setSendEmail(e.target.checked)} />
        Send Email to each enterprise&apos;s Rates contact
      </label>
      {sendEmail && (
        <div className="mail-preview">
          {preview.data ? (
            <>
              <div className="small">
                <strong>To:</strong>{" "}
                {preview.data.recipients.join(", ") || <span className="tone-error">no contact</span>}
                {ids.length > 1 && <span className="muted"> (first trunk; each gets its own)</span>}
              </div>
              <div className="small">
                <strong>Subject:</strong> {preview.data.subject}
              </div>
              <pre>{preview.data.body}</pre>
            </>
          ) : (
            <span className="muted small">
              {preview.isError ? problemText(preview.error) : "Preparing the e-mail…"}
            </span>
          )}
        </div>
      )}
    </Modal>
  );
}

function TechInfoDialog({ ids, done }: { ids: number[]; done: () => void }) {
  const send = useSendTechInfo();
  const preview = useNotificationPreview(ids[0]!, "send_tech_info");
  return (
    <Modal
      title={`Send Tech Info to ${ids.length} trunk${ids.length === 1 ? "" : "s"}`}
      width={620}
      onClose={done}
      footer={
        <>
          <Button onClick={done}>Cancel</Button>
          <Button
            variant="primary"
            icon="mail"
            disabled={send.isPending}
            onClick={() =>
              send.mutate(ids, {
                onSuccess: (r) => {
                  report(r, "Tech info");
                  done();
                },
                onError: (e) => toast({ tone: "error", message: problemText(e) }),
              })
            }
          >
            Send
          </Button>
        </>
      }
    >
      <div className="mail-preview">
        {preview.data ? (
          <>
            <div className="small">
              <strong>To:</strong>{" "}
              {preview.data.recipients.join(", ") || <span className="tone-error">no contact</span>}
            </div>
            <div className="small">
              <strong>Subject:</strong> {preview.data.subject}
            </div>
            <pre>{preview.data.body}</pre>
          </>
        ) : (
          <span className="muted small">{preview.isError ? problemText(preview.error) : "Preparing the e-mail…"}</span>
        )}
      </div>
      <p className="muted small">The password is never sent by e-mail; share it separately.</p>
    </Modal>
  );
}

const openSendRate = (ids: number[]) => ask<void>((d) => <SendRateDialog ids={ids} done={() => d()} />);
const openTechInfo = (ids: number[]) => ask<void>((d) => <TechInfoDialog ids={ids} done={() => d()} />);
const viewRate = (id: number, t: "excel" | "csv") =>
  void downloadRateSheet(id, t).catch((e) => toast({ tone: "error", message: problemText(e) }));

function RecentEmails({ trunk }: { trunk: TrunkListRow }) {
  const navigate = useTabNavigate();
  const q = useQuery<ListPage<EmailLogRow>>({
    queryKey: ["list", "trunk-emails", trunk.id],
    queryFn: () =>
      fetchListPage<EmailLogRow>("email_logs", {
        filter: { logic: "and", conditions: [{ field: "customerTrunk", op: "eq", value: trunk.name }] },
        limit: 8,
        withTotal: false,
      }),
  });
  if (!q.data) return <p className="muted small">{q.isError ? problemText(q.error) : "Loading…"}</p>;
  if (!q.data.rows.length) return <p className="muted small">No e-mails for this trunk yet.</p>;
  return (
    <>
      <table className="mini-table">
        <tbody>
          {q.data.rows.map((l) => (
            <tr key={l.id}>
              <td className="small num">{fmtWhen(l.updatedAt)}</td>
              <td className="small">{EMAIL_TYPE[l.emailType]}</td>
              <td className="small">
                <StatusDot tone={l.status === "sent" ? "good" : "error"} /> {l.status === "sent" ? "Sent" : "Failed"}
              </td>
              <td className="small muted">{l.to.join(", ")}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <button type="button" className="link small" onClick={() => navigate("/switch/email-logs")}>
        All e-mail logs
      </button>
    </>
  );
}

export function NotificationsPage() {
  return (
    <ListScreen<TrunkListRow>
      list="customer_trunks"
      page={page}
      historyScope={null}
      initialState={{ visible: ["enterpriseName", "name", "category", "protocol", "tps", "status"] }}
      columns={{
        enterpriseName: { width: 240, render: (r) => <strong>{r.enterpriseName}</strong> },
        name: { width: 220 },
        category: { width: 140, render: (r) => r.category ?? <span className="muted">—</span> },
        protocol: { width: 100, render: (r) => r.protocol.toUpperCase() },
        tps: {
          width: 110,
          align: "right",
          render: (r) => <span className="num">{r.tps.toLocaleString("en-US")} TPS</span>,
        },
        status: {
          width: 110,
          render: (r) => (
            <span>
              <StatusDot tone={r.status === "active" ? "good" : "neutral"} />{" "}
              {r.status === "active" ? "Active" : "Inactive"}
            </span>
          ),
        },
      }}
      selection={{
        summary: (_rows, ids) => `${ids.size} trunk${ids.size === 1 ? "" : "s"} selected`,
        bulk: (ids, clear) => [
          { label: "Send Rate…", icon: "mail", onSelect: () => void openSendRate(ids).then(clear) },
          { label: "Send Tech Info…", icon: "send", onSelect: () => void openTechInfo(ids).then(clear) },
        ],
      }}
      detail={(r) => ({
        title: (
          <>
            <strong>{r.name}</strong>
            <span className="muted">
              {r.enterpriseName} · {r.protocol.toUpperCase()} · {r.tps} TPS
            </span>
          </>
        ),
        sections: [
          {
            key: "notify",
            label: "Notify",
            actions: (
              <>
                <Button small icon="mail" onClick={() => void openSendRate([r.id])}>
                  Send Rate
                </Button>
                <Button small icon="send" onClick={() => void openTechInfo([r.id])}>
                  Send Tech Info
                </Button>
                <Button small icon="download" onClick={() => viewRate(r.id, "excel")}>
                  View Rate (Excel)
                </Button>
                <Button small onClick={() => viewRate(r.id, "csv")}>
                  CSV
                </Button>
              </>
            ),
            content: <RecentEmails trunk={r} />,
          },
        ],
      })}
      shortcuts="↑↓ move · Space selects · Bulk edit: Send Rate, Send Tech Info"
    />
  );
}
