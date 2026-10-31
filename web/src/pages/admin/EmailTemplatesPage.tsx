// Email Template (§11): Info ID, Name, Email Type, Subject, Business Company. Form: Name, Email Type,
// Subject, Body (rich text or plain text with {placeholders}). The placeholders of the chosen type are
// chips that insert at the caret, and the preview fills them with fake sample values. Clone copies a
// template; one in use by a business company, traffic alert or SOA report cannot be deleted (§13.29).
import { useEffect, useMemo, useState } from "react";
import type {
  EmailTemplateInput,
  EmailTemplatePreviewInput,
  EmailTemplateRecord,
  EmailTemplateRow,
} from "@sms/contract";
import {
  useCloneEmailTemplate,
  useEmailPlaceholders,
  useEmailTemplate,
  useSaveEmailTemplate,
  useTemplatePreview,
  useTestEmailTemplate,
} from "../../api/admin";
import { useMe } from "../../api/hooks";
import { useReference, useRestore } from "../../api/records";
import { isAdminUser, useDeleteRecord } from "../../records/parts";
import { SelectField, TextField, useForm } from "../../form/form";
import { HistoryList, useNotifySaved } from "../../history/undo";
import { pageForPath } from "../../nav/registry";
import { ListScreen } from "../../page/ListScreen";
import { ask, toast } from "../../ui/feedback";
import { Button, Modal } from "../../ui/primitives";
import { problemText } from "../routing/dialogs";
import { fmtWhen, RecordActions } from "../reference/shared";
import { MailEditor } from "../../ui/MailEditor";
import { MailPreview } from "../../ui/MailPreview";
import { TEMPLATE_TYPE } from "./adminModel";
import { Kv } from "./parts";

const page = pageForPath("/admin/email-templates")!;
const TYPES = Object.entries(TEMPLATE_TYPE).map(([value, label]) => ({ value, label }));

/** Waits until typing pauses before asking for a new preview. */
function useSettled<T>(value: T, ms = 400): T {
  const key = JSON.stringify(value);
  const [settled, setSettled] = useState(key);
  useEffect(() => {
    const t = setTimeout(() => setSettled(key), ms);
    return () => clearTimeout(t);
  }, [key, ms]);
  return useMemo(() => JSON.parse(settled) as T, [settled]);
}

/** Sends the template, filled with sample values, to real addresses to check it in Outlook (§11). */
function TestDialog({ input, done }: { input: EmailTemplatePreviewInput; done: () => void }) {
  const [to, setTo] = useState("");
  const test = useTestEmailTemplate();
  const list = to
    .split(/[\s,;]+/)
    .map((x) => x.trim())
    .filter(Boolean);
  const valid = list.length > 0 && list.length <= 5 && list.every((x) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x));
  return (
    <Modal
      title="Send a test e-mail"
      width={480}
      onClose={done}
      footer={
        <>
          <span className="fb-spacer" />
          <Button onClick={done}>Close</Button>
          <Button
            variant="primary"
            icon="send"
            disabled={!valid || test.isPending}
            onClick={() =>
              test.mutate(
                { ...input, to: list },
                {
                  onSuccess: (r) =>
                    toast({
                      tone: r.status === "sent" ? "good" : "error",
                      message:
                        r.status === "sent"
                          ? `Test sent${r.sender ? ` from ${r.sender}` : ""} with ${r.inlineImages} embedded image${r.inlineImages === 1 ? "" : "s"} (Email Logs #${r.emailLogId})`
                          : `The test failed – see Email Logs #${r.emailLogId}`,
                    }),
                  onError: (e) => toast({ tone: "error", message: problemText(e) }),
                },
              )
            }
          >
            Send test
          </Button>
        </>
      }
    >
      <label className="ff wide">
        <span className="ff-label">To (up to 5 addresses)</span>
        <input type="text" value={to} placeholder="you@company.example" onChange={(e) => setTo(e.target.value)} />
      </label>
      <p className="muted small">Trial: written to Email Logs, not sent.</p>
    </Modal>
  );
}

function TemplateDialog({ record, done }: { record: EmailTemplateRecord | null; done: () => void }) {
  const ref = useReference();
  const placeholders = useEmailPlaceholders();
  const form = useForm<EmailTemplateInput>(
    record
      ? {
          name: record.name,
          emailType: record.emailType,
          subject: record.subject,
          body: record.body,
          businessCompanyId: record.businessCompanyId,
        }
      : { name: "", emailType: "customer_rate", subject: "", body: "", businessCompanyId: null },
  );
  const save = useSaveEmailTemplate();
  const notifySaved = useNotifySaved();
  const [error, setError] = useState<string | null>(null);
  const v = form.values;
  const previewInput = useSettled<EmailTemplatePreviewInput>({
    emailType: v.emailType,
    subject: v.subject,
    body: v.body,
    businessCompanyId: v.businessCompanyId,
  });
  const preview = useTemplatePreview(previewInput);
  const chips = placeholders.data?.types.find((t) => t.emailType === v.emailType)?.placeholders ?? [];
  return (
    <Modal
      title={record ? `Edit ${record.name}` : "Add e-mail template"}
      width={1280}
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
            {record ? "Save" : "Add template"}
          </Button>
        </>
      }
    >
      <div className="tpl-edit">
        <div>
          <div className="fgrid cols-2">
            <TextField form={form} path="name" label="Name" required maxLength={120} />
            <SelectField form={form} path="emailType" label="Email Type" required options={TYPES} />
            <SelectField
              form={form}
              path="businessCompanyId"
              label="Business Company"
              options={(ref.data?.businessCompanies ?? []).map((b) => ({ value: b.id, label: b.name }))}
              placeholder="Shared by every company"
            />
            <TextField form={form} path="subject" label="Subject" required maxLength={300} />
          </div>
          <MailEditor
            label="Body"
            value={v.body}
            onChange={(html) => form.set("body", html)}
            placeholders={chips}
            businessCompanyId={v.businessCompanyId}
          />
          {form.error("body") && <span className="ff-error">{form.error("body")}</span>}
        </div>
        <div>
          <div className="tpl-preview-head">
            <span className="ff-label">Preview (sample values)</span>
            <Button
              small
              icon="send"
              disabled={!v.subject.trim() || !v.body.trim()}
              onClick={() => void ask<void>((d) => <TestDialog input={previewInput} done={() => d()} />)}
            >
              Send test
            </Button>
          </div>
          {preview.data ? (
            <>
              <MailPreview preview={preview.data} />
              {preview.data.unknownPlaceholders.length > 0 && (
                <p className="tone-warning small">
                  Not a placeholder of this type: {preview.data.unknownPlaceholders.map((k) => `{${k}}`).join(", ")}
                </p>
              )}
            </>
          ) : (
            <p className="muted small">Write a subject and body to see the e-mail.</p>
          )}
        </div>
      </div>
    </Modal>
  );
}

const openDialog = (record: EmailTemplateRecord | null) =>
  ask<void>((d) => <TemplateDialog record={record} done={() => d()} />);

/** Loads the full template (same query as the detail panel), then shows the editor: Edit from the action bar. */
function LoadAndEdit({ id, done }: { id: number; done: () => void }) {
  const rec = useEmailTemplate(id);
  if (rec.data) return <TemplateDialog record={rec.data} done={done} />;
  return (
    <Modal title="Edit e-mail template" width={420} onClose={done}>
      <p className={rec.error ? "error-text" : "muted"}>{rec.error ? problemText(rec.error) : "Loading…"}</p>
    </Modal>
  );
}
const editById = (id: number) => ask<void>((d) => <LoadAndEdit id={id} done={() => d()} />);

/** Asks for the copy's name and clones the template. */
function cloneTemplate(
  clone: ReturnType<typeof useCloneEmailTemplate>,
  notifySaved: ReturnType<typeof useNotifySaved>,
  r: EmailTemplateRow,
) {
  const name = window.prompt("Name of the copy", `${r.name} (copy)`);
  if (name?.trim())
    clone.mutate(
      { id: r.id, name: name.trim() },
      {
        onSuccess: (x) => x.change && notifySaved(x.change, `Cloned as ${x.record.name}`),
        onError: (e) => toast({ tone: "error", message: problemText(e) }),
      },
    );
}

function TemplateDetail({ r }: { r: EmailTemplateRow }) {
  const rec = useEmailTemplate(r.id);
  const preview = useTemplatePreview(
    rec.data
      ? {
          emailType: rec.data.emailType,
          subject: rec.data.subject,
          body: rec.data.body,
          businessCompanyId: rec.data.businessCompanyId,
        }
      : null,
  );
  if (!rec.data || !preview.data) return <p className="muted">Loading…</p>;
  return <MailPreview preview={preview.data} />;
}

function TemplateActions({ r }: { r: EmailTemplateRow }) {
  const rec = useEmailTemplate(r.archivedAt ? null : r.id);
  const clone = useCloneEmailTemplate();
  const notifySaved = useNotifySaved();
  return (
    <>
      {!r.archivedAt && (
        <Button small icon="copy" disabled={clone.isPending} onClick={() => cloneTemplate(clone, notifySaved, r)}>
          Clone
        </Button>
      )}
      <RecordActions
        kind="email_template"
        id={r.id}
        name={r.name}
        archived={!!r.archivedAt}
        onEdit={rec.data ? () => void openDialog(rec.data!) : undefined}
      />
    </>
  );
}

export function EmailTemplatesPage() {
  const clone = useCloneEmailTemplate();
  const notifySaved = useNotifySaved();
  const { data: me } = useMe();
  const admin = isAdminUser(me?.permissions);
  const deleteOne = useDeleteRecord();
  const restore = useRestore("email_template");
  const deleted = (r: EmailTemplateRow) => (r.archivedAt ? "Deleted template: restore it first" : undefined);
  return (
    <ListScreen<EmailTemplateRow>
      list="email_templates"
      noExport
      bulkDelete={{ noun: "e-mail template", restore: true }}
      page={page}
      noSelection
      historyScope={{ entityTypes: ["email_template"] }}
      primary={{ label: "Add template", icon: "plus", onClick: () => void openDialog(null) }}
      rowActions={(r) => [
        {
          label: "Edit",
          icon: "file",
          main: true,
          disabled: !!r.archivedAt,
          hint: deleted(r),
          onSelect: () => void editById(r.id),
        },
        {
          label: "Clone",
          icon: "copy",
          disabled: !!r.archivedAt || clone.isPending,
          hint: deleted(r),
          onSelect: () => cloneTemplate(clone, notifySaved, r),
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
              onSelect: () => void deleteOne("email_template", r.id, r.name),
            },
      ]}
      columns={{
        id: { width: 90 },
        name: { width: 280, render: (r) => <strong>{r.name}</strong> },
        emailType: { width: 200, render: (r) => TEMPLATE_TYPE[r.emailType] },
        subject: { width: 360 },
        businessCompany: { width: 200, render: (r) => r.businessCompany ?? <span className="muted">Shared</span> },
        usedBy: { width: 90, align: "right", render: (r) => <span className="num">{r.usedBy}</span> },
        updatedAt: { width: 170, render: (r) => fmtWhen(r.updatedAt) },
      }}
      rowClass={(r) => (r.archivedAt ? "row-muted" : undefined)}
      detail={(r) => ({
        title: (
          <>
            <strong>{r.name}</strong>
            <span className="muted">
              {TEMPLATE_TYPE[r.emailType]} · {r.businessCompany ?? "shared"} · used by {r.usedBy}
            </span>
          </>
        ),
        sections: [
          { key: "preview", label: "Preview", actions: <TemplateActions r={r} />, content: <TemplateDetail r={r} /> },
          {
            key: "info",
            label: "Info",
            content: (
              <Kv
                items={[
                  ["Subject", r.subject],
                  ["Business company", r.businessCompany ?? "Shared by every company"],
                  ["Used by", `${r.usedBy} business company default(s), traffic alert(s) and SOA report(s)`],
                  ["Updated", `${fmtWhen(r.updatedAt)}${r.updatedBy ? ` by ${r.updatedBy}` : ""}`],
                ]}
              />
            ),
          },
          {
            key: "history",
            label: "History",
            content: <HistoryList scope={{ entityTypes: ["email_template"], entityId: r.id }} />,
          },
        ],
      })}
      shortcuts="↑↓ move · Ctrl+Z undo"
    />
  );
}
