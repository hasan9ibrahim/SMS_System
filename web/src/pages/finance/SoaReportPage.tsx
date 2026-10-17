// SOA Report (§7): every Queue SOA Export and Send Email run with ID, Enterprise, From / To Date,
// Invoice Type, File Type, Status, Error, Download and Created Time, plus whom it was e-mailed to;
// per-row Send Email (modal Send SOA Email Notification: Enterprise, Template). A sent copy never
// changes: the file is the statement as it was when the report ran.
import { useState } from "react";
import type { EmailTemplateRow, SoaReportRow } from "@sms/contract";
import { downloadSoaReport, useSendSoaReport } from "../../api/soa";
import { pageForPath } from "../../nav/registry";
import { ListScreen } from "../../page/ListScreen";
import { ListLookup } from "../../records/parts";
import { useTabNavigate } from "../../shell/tabContext";
import { ask, toast } from "../../ui/feedback";
import { Icon } from "../../ui/Icon";
import { Button, Modal, StatusDot } from "../../ui/primitives";
import { problemText } from "../routing/dialogs";
import { fmtWhen } from "../reference/shared";
import { balanceWords, money } from "./financeModel";

const page = pageForPath("/finance/soa-report")!;
const muted = (v: string) => <span className="muted">{v}</span>;
const STATUS = {
  pending: { label: "Pending", tone: "neutral" },
  inprogress: { label: "Inprogress", tone: "accent" },
  success: { label: "Success", tone: "good" },
  failed: { label: "Failed", tone: "error" },
} as const;

const download = (id: number) =>
  void downloadSoaReport(id).catch((e) => toast({ tone: "error", message: problemText(e) }));

function SendDialog({ row, done }: { row: SoaReportRow; done: () => void }) {
  const [templateId, setTemplateId] = useState<number | null>(1);
  const send = useSendSoaReport();
  return (
    <Modal
      title="Send SOA Email Notification"
      width={520}
      onClose={done}
      footer={
        <>
          <Button onClick={done}>Cancel</Button>
          <Button
            variant="primary"
            icon="mail"
            disabled={!templateId || send.isPending}
            onClick={() =>
              send.mutate(
                { id: row.id, templateId: templateId! },
                {
                  onSuccess: (r) => {
                    toast({ tone: "good", message: `SOA e-mailed to ${r.emailTo.join(", ")}` });
                    done();
                  },
                  onError: (e) => toast({ tone: "error", message: problemText(e) }),
                },
              )
            }
          >
            Send
          </Button>
        </>
      }
    >
      <label className="field">
        <span>Enterprise</span>
        <input value={row.enterprise} readOnly />
      </label>
      <div className="field">
        <span>
          Template<span className="req">*</span>
        </span>
        <ListLookup<EmailTemplateRow>
          list="email_templates"
          value={templateId}
          onChange={(t) => setTemplateId(t?.id ?? null)}
          labelOf={(t) => t.name}
          detailOf={(t) => t.subject}
          fixed={[{ field: "emailType", op: "in", values: ["soa_statement", "send_soa"] }]}
        />
      </div>
      <p className="muted small">
        Sends this report&apos;s {row.fileType === "pdf" ? "PDF" : "Excel file"} for {row.from} → {row.to} to the
        partner&apos;s billing contacts.
      </p>
    </Modal>
  );
}

export function SoaReportPage() {
  const navigate = useTabNavigate();
  return (
    <ListScreen<SoaReportRow>
      list="soa_reports"
      page={page}
      noSelection
      historyScope={null}
      primary={{ label: "New SOA", icon: "plus", onClick: () => navigate("/finance/soa") }}
      columns={{
        id: { width: 80 },
        enterprise: { width: 230, render: (r) => <strong>{r.enterprise}</strong> },
        from: { width: 110 },
        to: { width: 110 },
        invoiceType: { width: 100, render: (r) => r.invoiceType.charAt(0).toUpperCase() + r.invoiceType.slice(1) },
        fileType: { width: 90, render: (r) => (r.fileType === "pdf" ? "PDF" : "Excel") },
        purpose: { width: 90, render: (r) => (r.purpose === "email" ? "E-mail" : "Export") },
        status: {
          width: 120,
          render: (r) => (
            <span>
              <StatusDot tone={STATUS[r.status].tone} /> {STATUS[r.status].label}
            </span>
          ),
        },
        error: {
          width: 260,
          render: (r) =>
            r.error ? (
              <span className="tone-error" title={r.error}>
                {r.error}
              </span>
            ) : (
              muted("—")
            ),
        },
        emailedAt: { width: 185, render: (r) => (r.emailedAt ? fmtWhen(r.emailedAt) : muted("—")) },
        createdAt: { width: 185, render: (r) => fmtWhen(r.createdAt) },
      }}
      trailing={{
        header: "Download · Action",
        width: 130,
        render: (r) => (
          <span className="row-icons">
            <button
              type="button"
              className="icon-btn"
              aria-label={`Download SOA ${r.id}`}
              title="Download"
              disabled={r.status !== "success"}
              onClick={(e) => {
                e.stopPropagation();
                download(r.id);
              }}
            >
              <Icon name="download" size={13} />
            </button>
            <button
              type="button"
              className="icon-btn"
              aria-label={`Send SOA ${r.id} by e-mail`}
              title="Send Email"
              disabled={r.status !== "success"}
              onClick={(e) => {
                e.stopPropagation();
                void ask<void>((d) => <SendDialog row={r} done={() => d()} />);
              }}
            >
              <Icon name="mail" size={13} />
            </button>
          </span>
        ),
      }}
      detail={(r) => ({
        title: (
          <>
            <strong>
              SOA {r.id} · {r.enterprise}
            </strong>
            <span className="muted">
              {r.from} → {r.to}
            </span>
          </>
        ),
        sections: [
          {
            key: "report",
            label: "Report",
            actions: (
              <>
                <Button small icon="download" disabled={r.status !== "success"} onClick={() => download(r.id)}>
                  Download
                </Button>
                <Button
                  small
                  icon="mail"
                  disabled={r.status !== "success"}
                  onClick={() => void ask<void>((d) => <SendDialog row={r} done={() => d()} />)}
                >
                  Send Email
                </Button>
                <Button
                  small
                  icon="file"
                  onClick={() => navigate(`/finance/soa?enterprises=${r.enterpriseId}`)}
                  title="Open the SOA screen for this enterprise"
                >
                  Open SOA
                </Button>
              </>
            ),
            content: (
              <dl className="kv">
                <dt>Status</dt>
                <dd>
                  <StatusDot tone={STATUS[r.status].tone} /> {STATUS[r.status].label}
                  {r.error && <div className="tone-error small">{r.error}</div>}
                </dd>
                <dt>Statement</dt>
                <dd>
                  {r.from} → {r.to} · invoice type {r.invoiceType} · {r.fileType === "pdf" ? "PDF" : "Excel"}
                </dd>
                <dt>Closing balance</dt>
                <dd>
                  {r.closingBalance === null ? (
                    "—"
                  ) : (
                    <>
                      <span className={`num ${balanceWords(r.closingBalance, "customer").tone}`}>
                        {money(r.closingBalance, r.currency)}
                      </span>{" "}
                      <span className="muted small">{balanceWords(r.closingBalance, "customer").text}</span>
                    </>
                  )}
                </dd>
                <dt>E-mail</dt>
                <dd>
                  {r.emailedAt
                    ? `${fmtWhen(r.emailedAt)} to ${r.emailTo.join(", ")}${r.template ? ` · ${r.template}` : ""}`
                    : "not e-mailed"}
                </dd>
                <dt>Created</dt>
                <dd>
                  {fmtWhen(r.createdAt)} {r.createdBy ? `by ${r.createdBy}` : "(scheduled)"}
                  {r.finishedAt && <span className="muted small"> · done {fmtWhen(r.finishedAt)}</span>}
                </dd>
              </dl>
            ),
          },
        ],
      })}
      shortcuts="↑↓ move"
    />
  );
}
