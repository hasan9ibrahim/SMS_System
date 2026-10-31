// Broadcast (§8): Business Company, Sender (one of its mailboxes), Subject, Contact Type
// (commercial / technical / rates / finance), Enterprise Type (customer / vendor / reciprocal), a rich
// text body and one attachment. The audience count shows before sending; each enterprise gets its own
// e-mail and every one shows in Email Logs. The grid lists past broadcasts.
import { useEffect, useState } from "react";
import type { BroadcastAudienceInput, BroadcastInput, BroadcastRow } from "@sms/contract";
import { useReference } from "../../../api/records";
import { useBroadcastAudience, useMailboxes, useSendBroadcast } from "../../../api/switchTools";
import { pageForPath } from "../../../nav/registry";
import { ListScreen } from "../../../page/ListScreen";
import { useTabNavigate } from "../../../shell/tabContext";
import { ask, toast } from "../../../ui/feedback";
import { MailEditor } from "../../../ui/MailEditor";
import { Button, Modal } from "../../../ui/primitives";
import { problemText } from "../../routing/dialogs";
import { fmtWhen } from "../../reference/shared";
import { toBase64 } from "./toolsModel";

const page = pageForPath("/switch/broadcast")!;
const muted = (v: string) => <span className="muted">{v}</span>;

type ContactType = BroadcastInput["contactTypes"][number];
type EnterpriseType = BroadcastInput["enterpriseTypes"][number];
const CONTACTS: { value: ContactType; label: string }[] = [
  { value: "commercial", label: "Commercial" },
  { value: "technical", label: "Technical" },
  { value: "rates", label: "Rates" },
  { value: "finance", label: "Finance" },
];
const ENTERPRISES: { value: EnterpriseType; label: string }[] = [
  { value: "customer", label: "Customer" },
  { value: "vendor", label: "Vendor" },
  { value: "reciprocal", label: "Bilateral" },
];
const MAX_ATTACHMENT = 5 * 1024 * 1024;

function Checks<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { value: T; label: string }[];
  value: T[];
  onChange: (v: T[]) => void;
}) {
  return (
    <div className="field">
      <span>{label}</span>
      <div className="multi-check">
        {options.map((o) => (
          <label key={o.value} className="toggle-inline">
            <input
              type="checkbox"
              checked={value.includes(o.value)}
              onChange={(e) =>
                onChange(
                  e.target.checked
                    ? options.map((x) => x.value).filter((x) => x === o.value || value.includes(x))
                    : value.filter((x) => x !== o.value),
                )
              }
            />
            {o.label}
          </label>
        ))}
      </div>
    </div>
  );
}

function ComposeDialog({ done }: { done: () => void }) {
  const ref = useReference();
  const companies = ref.data?.businessCompanies ?? [];
  const [companyId, setCompanyId] = useState<number | null>(null);
  const [sender, setSender] = useState("");
  const [subject, setSubject] = useState("");
  const [contactTypes, setContactTypes] = useState<ContactType[]>(["commercial"]);
  const [enterpriseTypes, setEnterpriseTypes] = useState<EnterpriseType[]>(["customer", "reciprocal"]);
  const [html, setHtml] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const send = useSendBroadcast();

  useEffect(() => {
    if (companyId === null && companies[0]) setCompanyId(companies[0].id);
  }, [companyId, companies]);
  const boxes = useMailboxes(companyId);
  useEffect(() => {
    const list = boxes.data?.mailboxes ?? [];
    if (list.length && !list.some((m) => m.email === sender)) setSender(list[0]!.email);
  }, [boxes.data, sender]);

  const audienceInput: BroadcastAudienceInput | null =
    companyId !== null && contactTypes.length && enterpriseTypes.length
      ? { businessCompanyId: companyId, contactTypes, enterpriseTypes }
      : null;
  const audience = useBroadcastAudience(audienceInput);
  const text = html
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .trim();
  const missing = !audienceInput
    ? "Pick at least one contact type and enterprise type"
    : !sender
      ? "Pick a sender"
      : !subject.trim()
        ? "Write a subject"
        : !text
          ? "Write the message"
          : file && file.size > MAX_ATTACHMENT
            ? "The attachment is larger than 5 MB"
            : null;

  const submit = async () => {
    if (!audienceInput || missing) return;
    const n = audience.data?.enterprises ?? 0;
    if (!window.confirm(`Send “${subject.trim()}” to ${n.toLocaleString("en-US")} enterprises?`)) return;
    try {
      const attachment = file
        ? { name: file.name, contentBase64: toBase64(new Uint8Array(await file.arrayBuffer())) }
        : null;
      const r = await send.mutateAsync({
        ...audienceInput,
        sender,
        subject: subject.trim(),
        bodyHtml: html,
        attachment,
      });
      toast({
        tone: r.failed ? "warning" : "good",
        message: `Sent to ${r.addresses.toLocaleString("en-US")} addresses at ${r.enterprises.toLocaleString("en-US")} enterprises${
          r.failed ? ` · ${r.failed} without an address` : ""
        }`,
      });
      done();
    } catch (e) {
      toast({ tone: "error", message: problemText(e) });
    }
  };

  return (
    <Modal
      title="New broadcast"
      width={900}
      onClose={done}
      footer={
        <>
          <span className="muted small">
            {missing ??
              (audience.data
                ? `${audience.data.enterprises.toLocaleString("en-US")} enterprises · ${audience.data.addresses.toLocaleString("en-US")} addresses`
                : audience.isError
                  ? problemText(audience.error)
                  : "Counting the audience…")}
          </span>
          <span className="fb-spacer" />
          <Button onClick={done}>Cancel</Button>
          <Button
            variant="primary"
            icon="send"
            disabled={!!missing || !audience.data?.enterprises || send.isPending}
            onClick={() => void submit()}
          >
            Send
          </Button>
        </>
      }
    >
      <div className="bc-form">
        <label className="field">
          <span>Business Company</span>
          <select value={companyId ?? ""} onChange={(e) => setCompanyId(Number(e.target.value))}>
            {companies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Sender</span>
          <select value={sender} onChange={(e) => setSender(e.target.value)}>
            {(boxes.data?.mailboxes ?? []).map((m) => (
              <option key={m.email} value={m.email}>
                {m.email} ({m.department})
              </option>
            ))}
          </select>
        </label>
        <label className="field bc-wide">
          <span>Subject</span>
          <input value={subject} maxLength={200} onChange={(e) => setSubject(e.target.value)} />
        </label>
        <Checks label="Contact Type" options={CONTACTS} value={contactTypes} onChange={setContactTypes} />
        <Checks label="Enterprise Type" options={ENTERPRISES} value={enterpriseTypes} onChange={setEnterpriseTypes} />
        <div className="field bc-wide">
          <span>Message</span>
          <MailEditor value={html} onChange={setHtml} businessCompanyId={companyId} />
        </div>
        <label className="field bc-wide">
          <span>Attachment (one file, up to 5 MB)</span>
          <input type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </label>
        {audience.data && audience.data.sample.length > 0 && (
          <p className="muted small bc-wide">
            Reaches {audience.data.sample.join(", ")}
            {audience.data.enterprises > audience.data.sample.length ? " and more" : ""}.
          </p>
        )}
      </div>
    </Modal>
  );
}

const openCompose = () => ask<void>((d) => <ComposeDialog done={() => d()} />);

export function BroadcastPage() {
  const navigate = useTabNavigate();
  return (
    <ListScreen<BroadcastRow>
      list="broadcasts"
      noExport
      page={page}
      noSelection
      historyScope={null}
      rowActions={() => [
        { label: "Email logs", icon: "mail", main: true, onSelect: () => navigate("/switch/email-logs") },
      ]}
      primary={{ label: "New broadcast", icon: "megaphone", onClick: () => void openCompose() }}
      columns={{
        subject: { width: 300, render: (r) => <strong>{r.subject}</strong> },
        businessCompany: { width: 200 },
        sender: { width: 220 },
        enterprises: {
          width: 110,
          align: "right",
          render: (r) => <span className="num">{r.enterprises.toLocaleString("en-US")}</span>,
        },
        addresses: {
          width: 110,
          align: "right",
          render: (r) => <span className="num">{r.addresses.toLocaleString("en-US")}</span>,
        },
        failed: {
          width: 110,
          align: "right",
          render: (r) => (r.failed ? <span className="num tone-warning">{r.failed}</span> : muted("0")),
        },
        sentBy: { width: 140, render: (r) => r.sentBy ?? muted("—") },
        sentAt: { width: 170, render: (r) => fmtWhen(r.sentAt) },
      }}
      detail={(r) => ({
        title: (
          <>
            <strong>{r.subject}</strong>
            <span className="muted">
              {r.sender} · {fmtWhen(r.sentAt)}
            </span>
          </>
        ),
        sections: [
          {
            key: "broadcast",
            label: "Broadcast",
            actions: (
              <Button small icon="mail" onClick={() => navigate("/switch/email-logs")}>
                Email logs
              </Button>
            ),
            content: (
              <dl className="kv">
                <dt>Business company</dt>
                <dd>{r.businessCompany}</dd>
                <dt>Audience</dt>
                <dd>
                  {r.contactTypes.join(", ")} contacts of {r.enterpriseTypes.join(", ")} enterprises
                </dd>
                <dt>Reached</dt>
                <dd>
                  {r.addresses.toLocaleString("en-US")} addresses at {r.enterprises.toLocaleString("en-US")} enterprises
                  {r.failed ? ` · ${r.failed} without an address` : ""}
                </dd>
                <dt>Attachment</dt>
                <dd>{r.attachment ?? "none"}</dd>
                <dt>Sent by</dt>
                <dd>{r.sentBy ?? "—"}</dd>
              </dl>
            ),
          },
        ],
      })}
      shortcuts="↑↓ move"
    />
  );
}
