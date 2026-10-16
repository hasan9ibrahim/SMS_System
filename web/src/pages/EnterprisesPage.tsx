// Enterprise list (§5) on the standard grid. The full Enterprise screen (General Info,
// Docs, Billing and trunk tabs, forms) is build step 4.1; this page proves the grid at work.
import type { Enterprise } from "@sms/contract";
import { pageForPath } from "../nav/registry";
import { ListScreen } from "../page/ListScreen";
import { useTabNavigate } from "../shell/tabContext";

const page = pageForPath("/enterprises")!;
const TYPE_LABEL = { customer: "Customer", vendor: "Vendor", reciprocal: "Reciprocal" } as const;

export function EnterprisesPage() {
  const navigate = useTabNavigate();
  return (
    <ListScreen<Enterprise>
      list="enterprises"
      page={page}
      primary={{ label: "New enterprise", disabled: true, title: "The enterprise form arrives with build step 4.1" }}
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
            key: "trunks",
            label: "Trunks",
            content: <p className="muted">Customer and vendor trunks arrive with build step 4.1 (§5.4, §5.5).</p>,
          },
          {
            key: "billing",
            label: "Billing",
            content: <p className="muted">Billing, balances and beneficiary arrive with build step 4.1 (§5.3).</p>,
          },
        ],
        aside: (
          <dl className="kv">
            <dt>ID</dt>
            <dd className="num">{r.id}</dd>
            <dt>Created</dt>
            <dd>{r.createdAt?.slice(0, 10) ?? "—"}</dd>
          </dl>
        ),
      })}
    />
  );
}
