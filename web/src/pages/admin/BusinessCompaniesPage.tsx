// Business Company (§11): Info ID, Name, Description, Base Currency, TPS Limit, Updated By / Time. The
// form has five parts: the company (SMPP IP / port shown in tech-info e-mails, invoice number start),
// default e-mail templates per type, address and bank, one sender block per department mailbox
// (SMTP and OAuth; passwords and client secrets are write-only, blank keeps the stored one; Check SMTP
// Connection is simulated) and the logo and format files with the Format File Variables help. Clone
// copies everything except secrets; delete is blocked by live enterprises or users (§13.29).
import { useState } from "react";
import type {
  BusinessCompanyInput,
  BusinessCompanyRecord,
  BusinessCompanyRow,
  EmailTemplateRow,
  MailboxInput,
  SmtpCheckResult,
} from "@sms/contract";
import {
  checkSmtp,
  downloadCompanyFile,
  useAllRows,
  useBusinessCompany,
  useCloneBusinessCompany,
  useFormatVariables,
  useSaveBusinessCompany,
  useUploadCompanyFile,
} from "../../api/admin";
import { useMe } from "../../api/hooks";
import { useReference, useRestore } from "../../api/records";
import { isAdminUser, useDeleteRecord } from "../../records/parts";
import { FormField, NumberField, SelectField, TextArea, TextField, useForm, type FormApi } from "../../form/form";
import { HistoryList, useNotifySaved } from "../../history/undo";
import { pageForPath } from "../../nav/registry";
import { ListScreen } from "../../page/ListScreen";
import { ask, toast } from "../../ui/feedback";
import { Button, Modal, StatusDot } from "../../ui/primitives";
import { problemText } from "../routing/dialogs";
import { fmtWhen, RecordActions } from "../reference/shared";
import { toBase64 } from "../switch/tools/toolsModel";
import {
  blankCompany,
  blankMailbox,
  companyInput,
  FILE_KINDS,
  MAILBOX_DEPARTMENTS,
  SENDER_SLOTS,
  senderAddress,
  TEMPLATE_SLOTS,
  countryOptions,
} from "./adminModel";
import { Kv } from "./parts";

const page = pageForPath("/admin/business-companies")!;
type Part = "company" | "templates" | "address" | "mailboxes" | "senders" | "files";
const PARTS: { key: Part; label: string }[] = [
  { key: "company", label: "Company" },
  { key: "templates", label: "Default templates" },
  { key: "address", label: "Address & bank" },
  { key: "mailboxes", label: "Mailboxes" },
  { key: "senders", label: "Senders" },
  { key: "files", label: "Format files" },
];

function MailboxBlock({
  form,
  index,
  stored,
  companyId,
}: {
  form: FormApi<BusinessCompanyInput>;
  index: number;
  stored: BusinessCompanyRecord["mailboxes"][number] | undefined;
  companyId: number | null;
}) {
  const p = `mailboxes.${index}`;
  const m = form.values.mailboxes[index]!;
  const [check, setCheck] = useState<SmtpCheckResult | null>(null);
  const [checking, setChecking] = useState(false);
  const runCheck = () => {
    setChecking(true);
    checkSmtp({ businessCompanyId: companyId, mailbox: m })
      .then(setCheck, (e: unknown) => toast({ tone: "error", message: problemText(e) }))
      .finally(() => setChecking(false));
  };
  const dept = MAILBOX_DEPARTMENTS.find((d) => d.value === m.department)?.label ?? m.department;
  return (
    <section className="fsection mailbox">
      <header>
        <h2>{dept} mailbox</h2>
        <span className="muted small">{m.smtpEmail}</span>
        <span className="fb-spacer" />
        <Button small icon="send" disabled={checking} onClick={runCheck}>
          Check SMTP Connection
        </Button>
        <Button
          small
          icon="trash"
          onClick={() =>
            form.set(
              "mailboxes",
              form.values.mailboxes.filter((_, i) => i !== index),
            )
          }
        >
          Remove
        </Button>
      </header>
      <div className="fgrid cols-3">
        <TextField form={form} path={`${p}.name`} label="Name" maxLength={120} />
        <TextField form={form} path={`${p}.phone`} label="Phone" type="tel" maxLength={50} />
        <TextField form={form} path={`${p}.smtpEmail`} label="SMTP Email" type="email" required maxLength={200} />
        <SelectField
          form={form}
          path={`${p}.smtpSecure`}
          label="SMTP Secure"
          required
          options={[
            { value: "starttls", label: "STARTTLS" },
            { value: "ssl", label: "SSL / TLS" },
            { value: "none", label: "None" },
          ]}
        />
        <TextField form={form} path={`${p}.smtpHost`} label="SMTP Host" required maxLength={200} />
        <NumberField form={form} path={`${p}.smtpPort`} label="SMTP Port" required min={1} max={65535} step={1} />
        <TextField form={form} path={`${p}.smtpUsername`} label="SMTP UserName" maxLength={200} />
        <TextField
          form={form}
          path={`${p}.smtpPassword`}
          label="SMTP Password"
          type="password"
          maxLength={200}
          autoComplete="new-password"
          placeholder={stored?.hasSmtpPassword ? "•••••• stored – type to replace" : "not set"}
        />
        <TextField form={form} path={`${p}.extension`} label="Extension Number" maxLength={20} />
        <TextField form={form} path={`${p}.skypeName`} label="Skype Name" maxLength={100} />
        <TextField form={form} path={`${p}.clientId`} label="Client ID" required maxLength={200} />
        <TextField
          form={form}
          path={`${p}.clientSecret`}
          label="Client Secret"
          type="password"
          required={!stored?.hasClientSecret}
          maxLength={500}
          autoComplete="new-password"
          placeholder={stored?.hasClientSecret ? "•••••• stored – type to replace" : "required"}
        />
        <FormField
          label="OAuth Redirect URIs (one per line)"
          required
          wide
          error={form.error(`${p}.oauthRedirectUris`)}
        >
          <textarea
            rows={2}
            value={m.oauthRedirectUris.join("\n")}
            onChange={(e) => form.set(`${p}.oauthRedirectUris`, e.target.value.split(/\r?\n/))}
          />
        </FormField>
      </div>
      {check && (
        <div className={`smtp-check ${check.ok ? "ok" : "bad"}`} role="status">
          <strong>{check.message}</strong>
          <ul>
            {check.steps.map((s) => (
              <li key={s.step}>
                <StatusDot tone={s.ok ? "good" : s.detail === "skipped" ? "neutral" : "error"} /> {s.step}:{" "}
                <span className="muted">{s.detail}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function FilesPart({ record }: { record: BusinessCompanyRecord }) {
  const upload = useUploadCompanyFile();
  const vars = useFormatVariables();
  const notifySaved = useNotifySaved();
  const onFile = async (kind: (typeof FILE_KINDS)[number]["kind"], file: File | undefined) => {
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) return toast({ tone: "error", message: "The file is larger than 10 MB" });
    try {
      const r = await upload.mutateAsync({
        id: record.id,
        kind,
        name: file.name,
        contentBase64: toBase64(new Uint8Array(await file.arrayBuffer())),
      });
      if (r.change) notifySaved(r.change, `Uploaded ${file.name}`);
    } catch (e) {
      toast({ tone: "error", message: problemText(e) });
    }
  };
  return (
    <div className="bc-files">
      <table className="simple-table">
        <thead>
          <tr>
            <th>File</th>
            <th>Current</th>
            <th>Uploaded</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {FILE_KINDS.map((k) => {
            const f = record.files.find((x) => x.kind === k.kind);
            return (
              <tr key={k.kind}>
                <td>{k.label}</td>
                <td>
                  {f ? (
                    <button
                      type="button"
                      className="link-btn"
                      onClick={() => void downloadCompanyFile(record.id, k.kind, f.name)}
                    >
                      {f.name}
                    </button>
                  ) : (
                    <span className="tone-warning">missing</span>
                  )}
                  {f && <span className="muted small"> · {(f.size / 1024).toFixed(1)} KB</span>}
                </td>
                <td className="muted small">
                  {f ? `${fmtWhen(f.uploadedAt)}${f.uploadedBy ? ` by ${f.uploadedBy}` : ""}` : "—"}
                </td>
                <td>
                  <label className="btn btn-sm">
                    Upload…
                    <input
                      type="file"
                      accept={k.accept}
                      hidden
                      disabled={upload.isPending}
                      onChange={(e) => {
                        void onFile(k.kind, e.target.files?.[0]);
                        e.target.value = "";
                      }}
                    />
                  </label>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <details className="format-help" open>
        <summary>Format File Variables</summary>
        <div className="format-vars">
          {(vars.data?.formats ?? []).map((f) => (
            <div key={f.kind}>
              <strong>{f.label}</strong>
              <ul>
                {f.variables.map((v) => (
                  <li key={v.key}>
                    <code>{`{${v.key}}`}</code> <span className="muted">{v.description}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}

function CompanyDialog({ record, done }: { record: BusinessCompanyRecord | null; done: () => void }) {
  const ref = useReference();
  const templates = useAllRows<EmailTemplateRow>("email_templates");
  const form = useForm<BusinessCompanyInput>(record ? companyInput(record) : blankCompany());
  const save = useSaveBusinessCompany();
  const notifySaved = useNotifySaved();
  const [part, setPart] = useState<Part>("company");
  const [error, setError] = useState<string | null>(null);
  const v = form.values;
  const currencies = (ref.data?.currencies ?? []).map((c) => ({ value: c.iso, label: `${c.iso} – ${c.name}` }));
  const errorParts = new Set<Part>(
    Object.keys(form.errors).map((k) =>
      k.startsWith("mailboxes")
        ? "mailboxes"
        : k.startsWith("defaultTemplates")
          ? "templates"
          : k.startsWith("senders")
            ? "senders"
            : k.startsWith("address") || k.startsWith("bank")
              ? "address"
              : "company",
    ),
  );
  const missing = MAILBOX_DEPARTMENTS.filter((d) => !v.mailboxes.some((m) => m.department === d.value));
  return (
    <Modal
      title={record ? `Edit ${record.name}` : "Add business company"}
      width={1000}
      onClose={done}
      footer={
        <>
          {error && <span className="error-text small">{error}</span>}
          <span className="fb-spacer" />
          <Button onClick={done}>Cancel</Button>
          <Button
            variant="primary"
            disabled={save.isPending}
            onClick={() =>
              save.mutate(
                { id: record?.id ?? null, input: v },
                {
                  onSuccess: (r) => {
                    if (r.change) notifySaved(r.change, `Saved ${r.record.name}`);
                    done();
                  },
                  onError: (e) => setError(form.fail(e)),
                },
              )
            }
          >
            {record ? "Save" : "Add company"}
          </Button>
        </>
      }
    >
      <div className="segmented small bc-parts" role="tablist" aria-label="Business company form">
        {PARTS.map((x) => (
          <button
            key={x.key}
            type="button"
            role="tab"
            aria-selected={part === x.key}
            className={part === x.key ? "on" : ""}
            onClick={() => setPart(x.key)}
          >
            {x.label}
            {errorParts.has(x.key) && <span className="tone-error"> •</span>}
          </button>
        ))}
      </div>
      <div className="bc-part">
        {part === "company" && (
          <div className="fgrid cols-3">
            <TextField form={form} path="name" label="Name" required maxLength={120} />
            <SelectField form={form} path="baseCurrency" label="Base Currency" required options={currencies} />
            <NumberField form={form} path="tpsLimit" label="TPS Limit" min={1} max={100000} step={1} />
            <TextField
              form={form}
              path="website"
              label="Website"
              maxLength={200}
              placeholder="https://www.company.example"
            />
            <TextField form={form} path="smppHost" label="SMPP IP" maxLength={200} hint="Shown in tech-info e-mails" />
            <NumberField form={form} path="smppPort" label="SMPP Port" min={1} max={65535} step={1} />
            <NumberField
              form={form}
              path="invoiceNumberStart"
              label="Invoice Number (sequence start)"
              required
              min={1}
              step={1}
            />
            <TextField form={form} path="companyIp" label="Business Company IP" maxLength={45} />
            <TextField
              form={form}
              path="customerRateFileName"
              label="Customer Rate File Name"
              maxLength={200}
              hint="Variables {company} {enterprise} {trunk} {date}"
            />
            <TextArea form={form} path="description" label="Description" rows={2} />
          </div>
        )}
        {part === "templates" && (
          <div className="fgrid cols-3">
            {TEMPLATE_SLOTS.map((t) => (
              <SelectField
                key={t.key}
                form={form}
                path={`defaultTemplates.${t.key}`}
                label={t.label}
                placeholder="Shared default"
                options={(templates.data ?? [])
                  .filter(
                    (x) =>
                      x.emailType === t.type && (x.businessCompanyId == null || x.businessCompanyId === record?.id),
                  )
                  .map((x) => ({ value: x.id, label: x.name }))}
              />
            ))}
          </div>
        )}
        {part === "address" && (
          <>
            <h3 className="part-title">Address</h3>
            <div className="fgrid cols-3">
              <TextField form={form} path="address.line1" label="Address Line 1" maxLength={200} />
              <TextField form={form} path="address.line2" label="Address Line 2" maxLength={200} />
              <TextField form={form} path="address.city" label="City" maxLength={100} />
              <TextField form={form} path="address.state" label="State" maxLength={100} />
              <SelectField
                form={form}
                path="address.countryIso"
                label="Country"
                options={countryOptions(ref.data?.countries ?? [])}
              />
              <TextField form={form} path="address.zip" label="ZIP" maxLength={20} />
            </div>
            <h3 className="part-title">Bank</h3>
            <div className="fgrid cols-3">
              <TextField form={form} path="bank.beneficiaryName" label="Beneficiary Name" maxLength={200} />
              <TextField form={form} path="bank.beneficiaryAddress" label="Beneficiary Address" maxLength={300} />
              <TextField form={form} path="bank.bankName" label="Bank" maxLength={200} />
              <TextField form={form} path="bank.bankAddress" label="Bank Address" maxLength={300} />
              <SelectField form={form} path="bank.currency" label="Currency" options={currencies} />
              <TextField form={form} path="bank.accountNumber" label="Account Number" maxLength={60} />
              <TextField form={form} path="bank.iban" label="IBAN" maxLength={40} />
              <TextField form={form} path="bank.swift" label="Swift" maxLength={11} />
            </div>
          </>
        )}
        {part === "mailboxes" && (
          <>
            {v.mailboxes.map((m, i) => (
              <MailboxBlock
                key={m.department}
                form={form}
                index={i}
                companyId={record?.id ?? null}
                stored={record?.mailboxes.find((x) => x.department === m.department)}
              />
            ))}
            {missing.length > 0 && (
              <div className="add-mailbox">
                <span className="muted small">Add a mailbox:</span>
                {missing.map((d) => (
                  <Button
                    key={d.value}
                    small
                    icon="plus"
                    onClick={() =>
                      form.set("mailboxes", [
                        ...v.mailboxes,
                        blankMailbox(d.value as MailboxInput["department"], v.website),
                      ])
                    }
                  >
                    {d.label}
                  </Button>
                ))}
              </div>
            )}
          </>
        )}
        {part === "senders" && (
          <>
            <p className="muted small">
              Which mailbox each kind of e-mail is sent from, for partners of this company. When the chosen department
              has no mailbox, its default department&apos;s mailbox is used.
            </p>
            <div className="fgrid cols-3">
              {SENDER_SLOTS.map((x) => (
                <SelectField
                  key={x.key}
                  form={form}
                  path={`senders.${x.key}`}
                  label={x.label}
                  options={MAILBOX_DEPARTMENTS}
                  hint={`${x.hint} · from ${senderAddress(v, x.key) ?? "—"}`}
                />
              ))}
            </div>
          </>
        )}
        {part === "files" &&
          (record ? (
            <FilesPart record={record} />
          ) : (
            <p className="muted">Save the company first, then upload its logo and format files.</p>
          ))}
      </div>
    </Modal>
  );
}

const openDialog = (record: BusinessCompanyRecord | null) =>
  ask<void>((d) => <CompanyDialog record={record} done={() => d()} />);

/** Loads the full record (same query as the detail panel), then shows the editor: Edit from the action bar. */
function LoadAndEdit({ id, done }: { id: number; done: () => void }) {
  const rec = useBusinessCompany(id);
  if (rec.data) return <CompanyDialog record={rec.data} done={done} />;
  return (
    <Modal title="Edit business company" width={420} onClose={done}>
      <p className={rec.error ? "error-text" : "muted"}>{rec.error ? problemText(rec.error) : "Loading…"}</p>
    </Modal>
  );
}
const editById = (id: number) => ask<void>((d) => <LoadAndEdit id={id} done={() => d()} />);

function CompanyDetail({ r, part }: { r: BusinessCompanyRow; part: "info" | "mailboxes" | "files" }) {
  const rec = useBusinessCompany(r.id);
  const d = rec.data;
  if (!d) return <p className="muted">Loading…</p>;
  if (part === "files") return <FilesPart record={d} />;
  if (part === "mailboxes")
    return (
      <table className="simple-table">
        <thead>
          <tr>
            <th>Department</th>
            <th>Sender</th>
            <th>Sends</th>
            <th>SMTP</th>
            <th>Secrets</th>
            <th>Last check</th>
          </tr>
        </thead>
        <tbody>
          {d.mailboxes.map((m) => (
            <tr key={m.department}>
              <td>{MAILBOX_DEPARTMENTS.find((x) => x.value === m.department)?.label}</td>
              <td>
                {m.smtpEmail}
                {m.name && <span className="muted small"> · {m.name}</span>}
              </td>
              <td className="small">
                {SENDER_SLOTS.filter((x) => senderAddress(d, x.key) === m.smtpEmail)
                  .map((x) => x.label)
                  .join(", ") || <span className="muted">—</span>}
              </td>
              <td className="mono small">
                {m.smtpHost}:{m.smtpPort} ({m.smtpSecure})
              </td>
              <td className="small">
                {m.hasSmtpPassword ? "password ✓" : <span className="tone-warning">no password</span>} ·{" "}
                {m.hasClientSecret ? "secret ✓" : <span className="tone-error">no secret</span>}
              </td>
              <td className="small">
                {m.lastCheckAt ? (
                  <>
                    <StatusDot tone={m.lastCheckOk ? "good" : "error"} /> {fmtWhen(m.lastCheckAt)}
                  </>
                ) : (
                  <span className="muted">never</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  const tpl = Object.values(d.defaultTemplates).filter((x) => x != null).length;
  return (
    <Kv
      items={[
        ["Base currency", d.baseCurrency],
        ["TPS limit", d.tpsLimit?.toLocaleString("en-US") ?? null],
        ["Website", d.website],
        ["SMPP", d.smppHost ? `${d.smppHost}:${d.smppPort ?? ""}` : null],
        ["Invoice numbers from", d.invoiceNumberStart.toLocaleString("en-US")],
        [
          "Address",
          [d.address.line1, d.address.line2, d.address.city, d.address.state, d.address.zip, d.address.countryIso]
            .filter(Boolean)
            .join(", "),
        ],
        ["Bank", [d.bank.bankName, d.bank.iban, d.bank.swift].filter(Boolean).join(" · ")],
        ["Default templates", `${tpl} of ${TEMPLATE_SLOTS.length} set (the rest use the shared default)`],
        ["Enterprises / users", `${d.enterprises.toLocaleString("en-US")} / ${d.users}`],
        ["Updated", `${fmtWhen(d.updatedAt)}${d.updatedBy ? ` by ${d.updatedBy}` : ""}`],
      ]}
    />
  );
}

/** Asks for the copy's name and clones the company (secrets are not copied). */
function cloneCompany(
  clone: ReturnType<typeof useCloneBusinessCompany>,
  notifySaved: ReturnType<typeof useNotifySaved>,
  r: BusinessCompanyRow,
) {
  const name = window.prompt("Name of the copy", `${r.name} (copy)`);
  if (name?.trim())
    clone.mutate(
      { id: r.id, name: name.trim() },
      {
        onSuccess: (x) => x.change && notifySaved(x.change, `Cloned as ${x.record.name}; enter its mailbox secrets`),
        onError: (e) => toast({ tone: "error", message: problemText(e) }),
      },
    );
}

function CompanyActions({ r }: { r: BusinessCompanyRow }) {
  const rec = useBusinessCompany(r.archivedAt ? null : r.id);
  const clone = useCloneBusinessCompany();
  const notifySaved = useNotifySaved();
  return (
    <>
      {!r.archivedAt && (
        <Button small icon="copy" disabled={clone.isPending} onClick={() => cloneCompany(clone, notifySaved, r)}>
          Clone
        </Button>
      )}
      <RecordActions
        kind="business_company"
        id={r.id}
        name={r.name}
        archived={!!r.archivedAt}
        onEdit={rec.data ? () => void openDialog(rec.data!) : undefined}
      />
    </>
  );
}

export function BusinessCompaniesPage() {
  const clone = useCloneBusinessCompany();
  const notifySaved = useNotifySaved();
  const { data: me } = useMe();
  const admin = isAdminUser(me?.permissions);
  const deleteOne = useDeleteRecord();
  const restore = useRestore("business_company");
  return (
    <ListScreen<BusinessCompanyRow>
      list="business_companies"
      page={page}
      noSelection
      historyScope={{ entityTypes: ["business_company", "business_company_file"] }}
      primary={{ label: "Add company", icon: "plus", onClick: () => void openDialog(null) }}
      rowActions={(r) => [
        {
          label: "Edit",
          icon: "file",
          main: true,
          disabled: !!r.archivedAt,
          hint: r.archivedAt ? "Deleted company: restore it first" : undefined,
          onSelect: () => void editById(r.id),
        },
        {
          label: "Clone",
          icon: "copy",
          disabled: !!r.archivedAt || clone.isPending,
          hint: r.archivedAt ? "Deleted company: restore it first" : "Copies everything except secrets",
          onSelect: () => cloneCompany(clone, notifySaved, r),
        },
        "separator",
        r.archivedAt
          ? {
              label: "Restore",
              icon: "undo",
              disabled: !admin || restore.isPending,
              hint: admin ? undefined : "Deleted. An administrator can restore it.",
              onSelect: () =>
                restore.mutate(r.id, {
                  onSuccess: (x) => x.change && notifySaved(x.change, `Restored ${r.name}`),
                  onError: (e) => toast({ tone: "error", message: problemText(e) }),
                }),
            }
          : {
              label: "Delete…",
              icon: "trash",
              danger: true,
              onSelect: () => void deleteOne("business_company", r.id, r.name),
            },
      ]}
      columns={{
        id: { width: 90 },
        name: { width: 240, render: (r) => <strong>{r.name}</strong> },
        description: { width: 320 },
        baseCurrency: { width: 120 },
        tpsLimit: {
          width: 110,
          align: "right",
          render: (r) => <span className="num">{r.tpsLimit?.toLocaleString("en-US") ?? "—"}</span>,
        },
        enterprises: { width: 110, align: "right", render: (r) => <span className="num">{r.enterprises}</span> },
        users: { width: 90, align: "right", render: (r) => <span className="num">{r.users}</span> },
        updatedBy: { width: 150 },
        updatedAt: { width: 170, render: (r) => fmtWhen(r.updatedAt) },
      }}
      rowClass={(r) => (r.archivedAt ? "row-muted" : undefined)}
      detail={(r) => ({
        title: (
          <>
            <strong>{r.name}</strong>
            <span className="muted">
              {r.baseCurrency} · {r.enterprises} enterprises · {r.mailboxCount} mailboxes
            </span>
          </>
        ),
        sections: [
          {
            key: "info",
            label: "Company",
            actions: <CompanyActions r={r} />,
            content: <CompanyDetail r={r} part="info" />,
          },
          { key: "mailboxes", label: "Mailboxes", content: <CompanyDetail r={r} part="mailboxes" /> },
          { key: "files", label: "Format files", content: <CompanyDetail r={r} part="files" /> },
          {
            key: "history",
            label: "History",
            content: (
              <HistoryList scope={{ entityTypes: ["business_company", "business_company_file"], entityId: r.id }} />
            ),
          },
        ],
      })}
      shortcuts="↑↓ move · Ctrl+Z undo"
    />
  );
}
