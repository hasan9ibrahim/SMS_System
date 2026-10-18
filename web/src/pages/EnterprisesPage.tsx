// Enterprise list (§5) on the standard grid. A row opens the enterprise record in its own
// tab (General, Docs, Billing, trunks, account managers, History).
import type { Enterprise } from "@sms/contract";
import { pageForPath } from "../nav/registry";
import { ListScreen } from "../page/ListScreen";
import { useDeleteRecord } from "../records/parts";
import { useTabNavigate } from "../shell/tabContext";

const page = pageForPath("/enterprises")!;
const TYPE_LABEL = { customer: "Customer", vendor: "Vendor", reciprocal: "Reciprocal" } as const;

export function EnterprisesPage() {
  const navigate = useTabNavigate();
  const deleteOne = useDeleteRecord();
  return (
    <ListScreen<Enterprise>
      list="enterprises"
      page={page}
      historyScope={{ entityTypes: ["enterprise"] }}
      rowActions={(r) => [
        {
          label: "Open",
          icon: "external",
          onSelect: () => navigate(`/enterprises/${r.id}`, { newTab: true, title: `Enterprise · ${r.name}` }),
        },
        "separator",
        {
          label: "Delete…",
          icon: "trash",
          danger: true,
          disabled: !!r.archivedAt,
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
