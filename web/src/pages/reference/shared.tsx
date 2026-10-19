// Shared pieces of the §6.1 reference-data pages: the import dialog (file, dry run, then
// import as one undoable change), a record dialog shell, and delete / restore actions.
import { useState, type ReactNode } from "react";
import type { ImportResult } from "@sms/contract";
import { useMe } from "../../api/hooks";
import { runImport, type ImportTarget } from "../../api/masterData";
import { useRestore, type RecordKind } from "../../api/records";
import { useNotifySaved } from "../../history/undo";
import { isAdminUser, useDeleteRecord } from "../../records/parts";
import { ask, toast } from "../../ui/feedback";
import { Button, Modal } from "../../ui/primitives";
import { problemText } from "../routing/dialogs";
import { canApply, importSummary, TEMPLATES } from "./referenceModel";

// ---------------------------------------------------------------- import (§6.1 import modals)

function ImportDialog({
  target,
  title,
  help,
  replaceHint,
  addOnly,
  done,
}: {
  target: ImportTarget;
  title: string;
  help: ReactNode;
  replaceHint: string;
  /** No Replace mode: the import only adds (e.g. vendor invoices). */
  addOnly?: boolean;
  done: (r: ImportResult | null) => void;
}) {
  const notifySaved = useNotifySaved();
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [mode, setMode] = useState<"merge" | "replace">("merge");
  const [check, setCheck] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dryRun = async (text: string, m: "merge" | "replace") => {
    setBusy(true);
    setError(null);
    setCheck(null);
    try {
      setCheck(await runImport(target, { csv: text, dryRun: true, mode: m }));
    } catch (e) {
      setError(problemText(e));
    } finally {
      setBusy(false);
    }
  };
  const apply = async () => {
    if (!file) return;
    setBusy(true);
    try {
      const r = await runImport(target, { csv: file.text, dryRun: false, mode });
      if (!r.applied) {
        setCheck(r);
        return;
      }
      if (r.change) notifySaved(r.change, `Import: ${importSummary(r)}`);
      done(r);
    } catch (e) {
      setError(problemText(e));
    } finally {
      setBusy(false);
    }
  };
  const template = () => {
    const url = URL.createObjectURL(new Blob([TEMPLATES[target.kind]], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${target.kind}_template.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <Modal
      title={title}
      width={640}
      onClose={() => done(null)}
      footer={
        <>
          <Button onClick={() => done(null)}>Cancel</Button>
          <Button variant="primary" icon="upload" disabled={busy || !canApply(check)} onClick={() => void apply()}>
            Import
          </Button>
        </>
      }
    >
      <div className="imp-help">{help}</div>
      <div className="imp-row">
        <label className="btn btn-default">
          Choose CSV file…
          <input
            type="file"
            accept=".csv,.txt,text/csv"
            hidden
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              const text = await f.text();
              setFile({ name: f.name, text });
              void dryRun(text, mode);
            }}
          />
        </label>
        <span className="muted small">{file ? file.name : "No file chosen"}</span>
        <span className="fb-spacer" />
        <button type="button" className="link small" onClick={template}>
          Download template
        </button>
      </div>
      {!addOnly && (
        <div className="segmented small" role="radiogroup" aria-label="Import mode">
          {(["merge", "replace"] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={mode === m}
              className={mode === m ? "on" : ""}
              onClick={() => {
                setMode(m);
                if (file) void dryRun(file.text, m);
              }}
            >
              {m === "merge" ? "Add and update" : "Replace"}
            </button>
          ))}
        </div>
      )}
      <p className="muted small imp-mode">
        {mode === "merge" ? "Rows not in the file stay as they are." : replaceHint}
      </p>
      {busy && <p className="muted">Checking the file…</p>}
      {error && <p className="error-text">{error}</p>}
      {check && <ImportReport r={check} />}
    </Modal>
  );
}

function ImportReport({ r }: { r: ImportResult }) {
  const issues = (title: string, list: ImportResult["errors"], tone: string) =>
    list.length > 0 && (
      <details open={tone === "error"} className={`imp-issues ${tone}`}>
        <summary>
          {title} ({list.length.toLocaleString("en-US")})
        </summary>
        <ul>
          {list.map((i, n) => (
            <li key={n}>
              {i.line !== null && <span className="num muted">line {i.line}</span>} {i.key && <strong>{i.key}</strong>}{" "}
              {i.message}
            </li>
          ))}
        </ul>
      </details>
    );
  return (
    <div className="imp-report" role="status">
      <div className="imp-counts">
        {(
          [
            ["Rows", r.total],
            ["Add", r.added],
            ["Change", r.updated],
            ["Unchanged", r.unchanged],
            ["Archive", r.archived],
          ] as const
        ).map(([label, n]) => (
          <div key={label}>
            <span className="muted small">{label}</span>
            <strong className="num">{n.toLocaleString("en-US")}</strong>
          </div>
        ))}
      </div>
      <p className={r.errors.length ? "error-text" : "muted"}>
        {r.errors.length
          ? "Fix the errors and choose the file again: nothing is imported while any row has an error."
          : r.applied
            ? `Imported: ${importSummary(r)}.`
            : `Ready: ${importSummary(r)}. Import saves it as one change you can undo.`}
      </p>
      {issues("Errors", r.errors, "error")}
      {issues("Kept because still in use", r.kept, "warning")}
      {issues("Remarks", r.warnings, "info")}
    </div>
  );
}

export const openImport = (props: Omit<Parameters<typeof ImportDialog>[0], "done">) =>
  ask<ImportResult>((done) => <ImportDialog {...props} done={done} />);

// ---------------------------------------------------------------- record dialog shell

export function RecordDialog({
  title,
  saveLabel,
  saving,
  error,
  onSave,
  onClose,
  width,
  children,
}: {
  title: string;
  saveLabel: string;
  saving: boolean;
  error: string | null;
  onSave: () => void;
  onClose: () => void;
  width?: number;
  children: ReactNode;
}) {
  return (
    <Modal
      title={title}
      width={width ?? 520}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={saving} onClick={onSave}>
            {saveLabel}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSave();
        }}
      >
        <div className="fgrid cols-2">{children}</div>
        {error && <p className="error-text">{error}</p>}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------- delete / restore (§13.29)

/** Edit, Delete and (for administrators, on deleted rows) Restore buttons for a detail panel. */
export function RecordActions({
  kind,
  id,
  name,
  archived,
  onEdit,
  canDelete = true,
}: {
  kind: RecordKind;
  id: number;
  name: string;
  archived: boolean;
  onEdit?: () => void;
  canDelete?: boolean;
}) {
  const { data: me } = useMe();
  const del = useDeleteRecord();
  const restore = useRestore(kind);
  const notifySaved = useNotifySaved();
  if (archived)
    return isAdminUser(me?.permissions) ? (
      <Button
        small
        icon="undo"
        disabled={restore.isPending}
        onClick={() =>
          restore.mutate(id, {
            onSuccess: (r) => r.change && notifySaved(r.change, `Restored ${name}`),
            onError: (e) => toast({ tone: "error", message: problemText(e) }),
          })
        }
      >
        Restore
      </Button>
    ) : (
      <span className="muted small">Deleted. An administrator can restore it.</span>
    );
  return (
    <>
      {onEdit && (
        <Button small icon="file" onClick={onEdit}>
          Edit
        </Button>
      )}
      {canDelete && (
        <Button small icon="trash" onClick={() => void del(kind, id, name)}>
          Delete
        </Button>
      )}
    </>
  );
}

export const fmtWhen = (iso: string | null | undefined) => (iso ? `${iso.slice(0, 16).replace("T", " ")} UTC` : "—");
