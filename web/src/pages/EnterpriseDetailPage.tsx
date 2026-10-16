// One enterprise in its own tab (opened from the list or Ctrl K). The full screen with
// tabs and forms is build step 4.1.
import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router";
import { api, unwrap } from "../api/client";
import { pageForPath } from "../nav/registry";
import { PageHeader } from "../page/PageHeader";
import { usePageStatus, useTabTitle } from "../shell/tabContext";
import { Icon } from "../ui/Icon";

const page = pageForPath("/enterprises")!;

export function EnterpriseDetailPage() {
  const id = Number(useParams().id);
  const q = useQuery({
    queryKey: ["enterprise", id],
    queryFn: () => unwrap(api.GET("/enterprises/{id}", { params: { path: { id } } })),
    enabled: Number.isInteger(id) && id > 0,
    retry: false,
  });
  const e = q.data;
  useTabTitle(e ? `Enterprise · ${e.name}` : undefined);
  usePageStatus({ rows: e ? `Enterprise ${e.id}` : "" });
  return (
    <div className="page">
      <PageHeader page={page} title={e ? `${e.name} – ${e.alias} (${e.id})` : `Enterprise ${id}`} />
      {q.isError && (
        <div className="grid-message error">
          <Icon name="alert" /> {(q.error as Error).message}
        </div>
      )}
      {e && (
        <div className="record">
          <section className="card">
            <h2>General information</h2>
            <dl className="kv">
              <dt>Name</dt>
              <dd>{e.name}</dd>
              <dt>Alias</dt>
              <dd>{e.alias}</dd>
              <dt>Type</dt>
              <dd>{e.type}</dd>
              <dt>Category</dt>
              <dd>{e.tier.replace("tier", "Tier ")}</dd>
              <dt>Status</dt>
              <dd>{e.status}</dd>
              <dt>Business company</dt>
              <dd>{e.businessCompanyName}</dd>
              <dt>Account manager</dt>
              <dd>{e.accountManagerName ?? "—"}</dd>
              <dt>Country</dt>
              <dd>{e.country ?? "—"}</dd>
            </dl>
          </section>
          <p className="muted">General Info, Docs, Billing and the trunk tabs arrive with build step 4.1 (§5).</p>
        </div>
      )}
    </div>
  );
}
