// Product categories (§6.1): traffic classes such as DIRECT, HQ and OTP. Add, rename and
// delete (archive, blocked while trunks, rate tables or rules use the category, §13.29);
// "Show deleted" is the spec's Delete History. Each save is one undoable change (§13.10). Several selected rows are
// deleted together with the Delete button at the top right (team trial round 12), each one its own change.
import type { ProductCategory, ProductCategoryInput } from "@sms/contract";
import { useMe } from "../../api/hooks";
import { useSaveCategory } from "../../api/masterData";
import { useRestore } from "../../api/records";
import { TextField, useForm } from "../../form/form";
import { useNotifySaved } from "../../history/undo";
import { pageForPath } from "../../nav/registry";
import { ListScreen } from "../../page/ListScreen";
import { isAdminUser, useBulkDelete, useDeleteRecord } from "../../records/parts";
import { ask, toast } from "../../ui/feedback";
import { problemText } from "../routing/dialogs";
import { useState } from "react";
import { fmtWhen, RecordActions, RecordDialog } from "./shared";

const page = pageForPath("/rates/categories")!;

function CategoryDialog({ row, done }: { row: ProductCategory | null; done: () => void }) {
  const form = useForm<ProductCategoryInput>({ name: row?.name ?? "" });
  const save = useSaveCategory();
  const notifySaved = useNotifySaved();
  const [error, setError] = useState<string | null>(null);
  const submit = () =>
    save.mutate(
      { id: row?.id ?? null, input: { name: form.values.name.trim() } },
      {
        onSuccess: (r) => {
          if (r.change) notifySaved(r.change, row ? `Renamed to ${r.record.name}` : `Added ${r.record.name}`);
          done();
        },
        onError: (e) => setError(form.fail(e)),
      },
    );
  return (
    <RecordDialog
      title={row ? `Rename ${row.name}` : "Add product category"}
      saveLabel={row ? "Save" : "Add category"}
      saving={save.isPending}
      error={error}
      onSave={submit}
      onClose={done}
      width={420}
    >
      <TextField form={form} path="name" label="Category Name" required maxLength={40} wide nullable={false} />
    </RecordDialog>
  );
}

const openDialog = (row: ProductCategory | null) =>
  ask<void>((done) => <CategoryDialog row={row} done={() => done()} />);

export function ProductCategoriesPage() {
  const deleteOne = useDeleteRecord();
  const deleteMany = useBulkDelete();
  const { data: me } = useMe();
  const restore = useRestore("product_category");
  const notifySaved = useNotifySaved();
  const isAdmin = isAdminUser(me?.permissions);
  return (
    <ListScreen<ProductCategory>
      list="product_categories"
      page={page}
      historyScope={{ entityTypes: ["product_category"] }}
      primary={{ label: "Add category", icon: "plus", onClick: () => void openDialog(null) }}
      rowActions={(r) => [
        {
          label: "Edit",
          icon: "file",
          main: true,
          disabled: !!r.archivedAt,
          hint: r.archivedAt ? "Deleted category" : "Rename",
          onSelect: () => void openDialog(r),
        },
        "separator",
        r.archivedAt
          ? {
              label: "Restore",
              icon: "undo",
              disabled: !isAdmin || restore.isPending,
              hint: isAdmin ? undefined : "Deleted. An administrator can restore it.",
              onSelect: () =>
                restore.mutate(r.id, {
                  onSuccess: (res) => res.change && notifySaved(res.change, `Restored ${r.name}`),
                  onError: (e) => toast({ tone: "error", message: problemText(e) }),
                }),
            }
          : {
              label: "Delete",
              icon: "trash",
              danger: true,
              onSelect: () => void deleteOne("product_category", r.id, r.name),
            },
      ]}
      selection={{
        bulk: (ids, clear, rows) => [
          {
            label: `Delete ${ids.length} categor${ids.length === 1 ? "y" : "ies"}…`,
            icon: "trash",
            danger: true,
            disabled: !rows.some((r) => !r.archivedAt),
            hint: rows.some((r) => !r.archivedAt) ? undefined : "Already deleted",
            onSelect: async () => {
              if (
                await deleteMany(
                  "product_category",
                  rows.filter((r) => !r.archivedAt),
                  "category",
                  "categories",
                )
              )
                clear();
            },
          },
        ],
      }}
      columns={{
        id: { width: 80 },
        name: { width: 220, render: (r) => <strong>{r.name}</strong> },
        customerTrunks: { width: 130, align: "right" },
        vendorTrunks: { width: 120, align: "right" },
        rateTables: { width: 110, align: "right" },
        updatedBy: { width: 140, render: (r) => r.updatedBy ?? <span className="muted">—</span> },
      }}
      onOpen={(r) => !r.archivedAt && void openDialog(r)}
      detail={(r) => ({
        title: (
          <>
            <strong>{r.name}</strong>
            <span className="muted">Product category {r.id}</span>
          </>
        ),
        sections: [
          {
            key: "general",
            label: "Category",
            actions: (
              <RecordActions
                kind="product_category"
                id={r.id}
                name={r.name}
                archived={!!r.archivedAt}
                onEdit={() => void openDialog(r)}
              />
            ),
            content: (
              <dl className="kv">
                <dt>Customer trunks</dt>
                <dd>{r.customerTrunks}</dd>
                <dt>Vendor trunks</dt>
                <dd>{r.vendorTrunks}</dd>
                <dt>Rate tables</dt>
                <dd>{r.rateTables}</dd>
                <dt>Updated</dt>
                <dd>
                  {r.updatedBy ?? "seed data"} · {fmtWhen(r.updatedAt)}
                </dd>
                {r.archivedAt && (
                  <>
                    <dt>State</dt>
                    <dd className="tone-warning">Deleted {fmtWhen(r.archivedAt)}</dd>
                  </>
                )}
              </dl>
            ),
          },
        ],
      })}
      shortcuts="↑↓ move · Enter or double-click renames · Ctrl+Z undo"
    />
  );
}
