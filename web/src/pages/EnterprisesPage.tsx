// Enterprise list (§5) on the standard grid. A row opens the enterprise record in its own
// tab (General, Docs, Billing, trunks, account managers, History).
import { HoverList } from "../ui/HoverList";
import type { Enterprise } from "@sms/contract";
import { pageForPath } from "../nav/registry";
import { ListScreen } from "../page/ListScreen";
import { useMe } from "../api/hooks";
import { useRestore } from "../api/records";
import { useNotifySaved } from "../history/undo";
import { isAdminUser, useDeleteRecord } from "../records/parts";
import { useTabNavigate } from "../shell/tabContext";
import { toast } from "../ui/feedback";
import { problemText } from "./routing/dialogs";

const page = pageForPath("/enterprises")!;
const TYPE_LABEL = { customer: "Customer", vendor: "Vendor", reciprocal: "Reciprocal" } as const;

function TrunkCount({ count = 0, names = [] }: { count?: number; names?: string[] }) {
  if (!count) return <span className="muted">—</span>;
  return (
    <HoverList items={names} more={count - names.length}>
      <span className="rr-strong num">{count}</span>
    </HoverList>
  );
}

export function EnterprisesPage() {
  const navigate = useTabNavigate();
  const deleteOne = useDeleteRecord();
  const { data: me } = useMe();
  const restore = useRestore("enterprise");
  const notifySaved = useNotifySaved();
  const restoreOne = (id: number, name: string) =>
    restore.mutate(id, {
      onSuccess: (r) => r.change && notifySaved(r.change, `Restored ${name}`),
      onError: (e) => toast({ tone: "error", message: problemText(e) }),
    });
  return (
    <ListScreen<Enterprise>
      list="enterprises"
      page={page}
      historyScope={{ entityTypes: ["enterprise"] }}
      rowActions={(r) => [
        // The enterprise record tab is its editor (§5).
        {
          label: "Edit",
          icon: "file",
          main: true,
          onSelect: () => navigate(`/enterprises/${r.id}`, { newTab: true, title: `Enterprise · ${r.name}` }),
        },
        "separator",
        r.archivedAt
          ? {
              label: "Restore",
              icon: "undo",
              disabled: !isAdminUser(me?.permissions) || restore.isPending,
              hint: isAdminUser(me?.permissions) ? undefined : "Deleted. An administrator can restore it.",
              onSelect: () => restoreOne(r.id, r.name),
            }
          : {
              label: "Delete",
              icon: "trash",
              danger: true,
              onSelect: () => void deleteOne("enterprise", r.id, r.name),
            },
      ]}
      primary={{
        label: "New enterprise",
        onClick: () => navigate("/enterprises/new", { newTab: true, title: "New enterprise" }),
      }}
      columns={{
        name: { width: 240, render: (r) => <strong>{r.name}</strong> },
        accountManager: { render: (r) => r.accountManagerName ?? "—" },
        businessCompany: { render: (r) => r.businessCompanyName },
        // Pointing at a count lists the trunks by name (team trial round 1).
        customerTrunkCount: {
          width: 140,
          align: "right",
          render: (r) => <TrunkCount count={r.customerTrunkCount} names={r.customerTrunkNames} />,
        },
        vendorTrunkCount: {
          width: 120,
          align: "right",
          render: (r) => <TrunkCount count={r.vendorTrunkCount} names={r.vendorTrunkNames} />,
        },
      }}
      onOpen={(row, e) =>
        navigate(`/enterprises/${row.id}`, {
          forceNew: e.ctrlKey || e.metaKey,
          newTab: true,
          title: `Enterprise · ${row.name}`,
        })
      }
      detail={(r) => ({
        title: (
          <>
            <strong>
              {r.name} – {r.alias} ({r.id})
            </strong>
            <span className="muted">{TYPE_LABEL[r.type]}</span>
          </>
        ),
        sections: [
          {
            key: "general",
            label: "General",
            content: (
              <dl className="kv">
                <dt>Type</dt>
                <dd>{TYPE_LABEL[r.type]}</dd>
                <dt>Category</dt>
                <dd>{r.tier.replace("tier", "Tier ")}</dd>
                <dt>Status</dt>
                <dd>{r.status === "active" ? "Active" : "Inactive"}</dd>
                <dt>Business company</dt>
                <dd>{r.businessCompanyName}</dd>
                <dt>Account manager</dt>
                <dd>{r.accountManagerName ?? "—"}</dd>
                <dt>Country</dt>
                <dd>{r.country ?? "—"}</dd>
                <dt>Updated</dt>
                <dd>
                  {r.updatedBy} · {r.updatedAt.slice(0, 16).replace("T", " ")} UTC
                </dd>
              </dl>
            ),
          },
          {
            key: "open",
            label: "Record",
            content: (
              <p>
                <button
                  type="button"
                  className="link"
                  onClick={() => navigate(`/enterprises/${r.id}`, { newTab: true, title: `Enterprise · ${r.name}` })}
                >
                  Open {r.name}
                </button>{" "}
                <span className="muted">
                  for docs, billing, trunks, account managers and history (double-click or Enter).
                </span>
              </p>
            ),
          },
        ],
        aside: (
          <dl className="kv">
            <dt>ID</dt>
            <dd className="num">{r.id}</dd>
            <dt>Created</dt>
            <dd>{r.createdAt?.slice(0, 10) ?? "—"}</dd>
            {r.archivedAt && (
              <>
                <dt>State</dt>
                <dd className="tone-warning">Deleted {r.archivedAt.slice(0, 10)}</dd>
              </>
            )}
          </dl>
        ),
      })}
    />
  );
}
