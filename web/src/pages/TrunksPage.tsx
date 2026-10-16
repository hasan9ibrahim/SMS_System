// Customer and vendor trunk lists (§5.4, §5.5) on the standard grid; a row opens the trunk
// record in its own tab. "Show deleted" lists archived trunks greyed out (§13.29).
import type { TrunkListRow } from "@sms/contract";
import type { TrunkKind } from "../api/records";
import { pageForPath } from "../nav/registry";
import { ListScreen } from "../page/ListScreen";
import { useTabNavigate } from "../shell/tabContext";

const LABEL = { customer: "Customer trunk", vendor: "Vendor trunk" } as const;

export function TrunksPage({ kind }: { kind: TrunkKind }) {
  const navigate = useTabNavigate();
  const page = pageForPath(`/enterprises/${kind}-trunks`)!;
  const open = (id: number, name: string, forceNew = false) =>
    navigate(`/enterprises/${kind}-trunks/${id}`, { newTab: true, forceNew, title: `${LABEL[kind]} · ${name}` });
  return (
    <ListScreen<TrunkListRow>
      key={kind}
      list={kind === "customer" ? "customer_trunks" : "vendor_trunks"}
      page={page}
      historyScope={{ entityTypes: [`${kind}_trunk`] }}
      primary={{
        label: `New ${LABEL[kind].toLowerCase()}`,
        onClick: () =>
          navigate(`/enterprises/${kind}-trunks/new`, { newTab: true, title: `New ${LABEL[kind].toLowerCase()}` }),
      }}
      columns={{
        name: { width: 220, render: (r) => <strong>{r.name}</strong> },
        enterpriseName: { width: 220 },
      }}
      onOpen={(row, e) => open(row.id, row.name, e.ctrlKey || e.metaKey)}
      detail={(r) => ({
        title: (
          <>
            <strong>{r.name}</strong>
            <span className="muted">
              {LABEL[kind]} of {r.enterpriseName}
            </span>
          </>
        ),
        sections: [
          {
            key: "general",
            label: "General",
            content: (
              <dl className="kv">
                <dt>Enterprise</dt>
                <dd>
                  <button
                    type="button"
                    className="link"
                    onClick={() => navigate(`/enterprises/${r.enterpriseId}`, { newTab: true })}
                  >
                    {r.enterpriseName} ({r.enterpriseId})
                  </button>
                </dd>
                <dt>Username</dt>
                <dd>{r.username}</dd>
                <dt>Protocol</dt>
                <dd>{r.protocol.toUpperCase()}</dd>
                <dt>Bind type</dt>
                <dd>{r.bindType}</dd>
                <dt>TPS</dt>
                <dd className="num">{r.tps.toLocaleString("en-US")}</dd>
                <dt>Category</dt>
                <dd>{r.category ?? "—"}</dd>
                <dt>Rules running</dt>
                <dd className="num">{r.rulesCount}</dd>
              </dl>
            ),
          },
        ],
        aside: (
          <dl className="kv">
            <dt>ID</dt>
            <dd className="num">{r.id}</dd>
            <dt>Updated</dt>
            <dd>
              {r.updatedBy ?? "—"} · {r.updatedAt.slice(0, 16).replace("T", " ")} UTC
            </dd>
            {r.archived && (
              <>
                <dt>State</dt>
                <dd className="tone-warning">Deleted (archived)</dd>
              </>
            )}
          </dl>
        ),
      })}
    />
  );
}
