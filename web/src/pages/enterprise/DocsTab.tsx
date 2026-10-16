// Docs of an enterprise (§5.2): contracts and KYC files. Upload is up to 10 MB; delete
// archives the file (§13.29) and can be undone from History (§13.10).
import { useRef, useState } from "react";
import type { Change, EnterpriseDetail, ListQuery } from "@sms/contract";
import { fetchListPage } from "../../api/hooks";
import { docUrl, useDeleteDoc, useDocs, useUploadDoc } from "../../api/records";
import { useNotifySaved } from "../../history/undo";
import { confirmDialog, toast } from "../../ui/feedback";
import { Icon } from "../../ui/Icon";
import { Button } from "../../ui/primitives";
import { HeaderAction, type SectionProps } from "../../records/parts";

const MAX_BYTES = 10 * 1024 * 1024;

const size = (n: number) =>
  n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export function DocsTab({ enterprise, slot }: SectionProps & { enterprise: EnterpriseDetail }) {
  const docs = useDocs(enterprise.id);
  const upload = useUploadDoc(enterprise.id);
  const remove = useDeleteDoc(enterprise.id);
  const notifySaved = useNotifySaved();
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const readOnly = !!enterprise.archived;

  const send = async (files: FileList | File[]) => {
    for (const file of Array.from(files)) {
      if (file.size > MAX_BYTES) {
        toast({ tone: "error", message: `${file.name} is larger than 10 MB` });
        continue;
      }
      const name = file.name.replace(/\.[^.]+$/, "") || file.name;
      try {
        await upload.mutateAsync({
          name,
          fileName: file.name,
          ...(file.type ? { contentType: file.type } : {}),
          dataBase64: await toBase64(file),
        });
        toast({ tone: "good", message: `Uploaded ${file.name}` });
      } catch (err) {
        toast({ tone: "error", message: `${file.name}: ${(err as Error).message}` });
      }
    }
  };

  return (
    <>
      <HeaderAction slot={slot}>
        <Button
          variant="primary"
          icon="upload"
          disabled={readOnly || upload.isPending}
          onClick={() => input.current?.click()}
        >
          Upload document
        </Button>
      </HeaderAction>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files?.length) void send(e.target.files);
          e.target.value = "";
        }}
      />
      {!readOnly && (
        <div
          className={`drop-zone${over ? " over" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            if (e.dataTransfer.files.length) void send(e.dataTransfer.files);
          }}
        >
          <Icon name="upload" />
          <span>Drop contracts, KYC or other files here, or use Upload document. Up to 10 MB each.</span>
          {upload.isPending && <span className="muted">Uploading…</span>}
        </div>
      )}
      <div className="card">
        {docs.isError && <p className="error-text">{(docs.error as Error).message}</p>}
        {docs.data && docs.data.length === 0 && <p className="muted">No documents yet.</p>}
        {docs.data && docs.data.length > 0 && (
          <table className="rtable">
            <thead>
              <tr>
                <th>Name</th>
                <th>File</th>
                <th className="num">Size</th>
                <th>Uploaded by</th>
                <th>Uploaded (UTC)</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {docs.data.map((d) => (
                <tr key={d.id}>
                  <td className="strong">{d.name}</td>
                  <td className="muted">{d.fileName}</td>
                  <td className="num">{size(d.size)}</td>
                  <td>{d.createdBy ?? "—"}</td>
                  <td className="num">{d.createdAt.slice(0, 16).replace("T", " ")}</td>
                  <td className="actions">
                    <a className="btn btn-ghost btn-sm" href={docUrl(enterprise.id, d.id)} download={d.fileName}>
                      <Icon name="download" size={13} /> Download
                    </a>
                    {!readOnly && (
                      <Button
                        small
                        variant="ghost"
                        icon="trash"
                        onClick={async () => {
                          if (
                            await confirmDialog({
                              title: `Delete ${d.name}?`,
                              message: "The file is archived, not erased, and the delete can be undone.",
                              ok: "Delete",
                              danger: true,
                            })
                          )
                            remove.mutate(d.id, {
                              // DELETE answers 204; the change it recorded carries the Undo (§13.10).
                              onSuccess: async () => {
                                const page = await fetchListPage<Change>("changes", {
                                  filter: {
                                    logic: "and",
                                    conditions: [
                                      { field: "entityType", op: "eq", value: "enterprise_doc" },
                                      { field: "entityId", op: "eq", value: d.id },
                                      { field: "changeType", op: "eq", value: "delete" },
                                    ],
                                  },
                                  limit: 1,
                                  withTotal: false,
                                } as ListQuery).catch(() => null);
                                const change = page?.rows[0];
                                if (change) notifySaved(change, `Deleted ${d.name}`);
                                else toast({ tone: "good", message: `Deleted ${d.name}` });
                              },
                              onError: (err) => toast({ tone: "error", message: (err as Error).message }),
                            });
                        }}
                      >
                        Delete
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
