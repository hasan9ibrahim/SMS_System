// Enterprise list (§5) on the standard grid. A row opens the enterprise record in its own
// tab (General, Docs, Billing, trunks, account managers, History).
import { HoverList } from "../ui/HoverList";
import type { Enterprise } from "@sms/contract";
import { pageForPath } from "../nav/registry";
import { ListScreen } from "../page/ListScreen";
import { useMe } from "../api/hooks";
import { useEnterprise, useRestore } from "../api/records";
import { Fragment } from "react";
import { useNotifySaved } from "../history/undo";
import { isAdminUser, useBulkDelete, useDeleteRecord } from "../records/parts";
import { useTabNavigate } from "../shell/tabContext";
import { toast } from "../ui/feedback";
import { problemText } from "./routing/dialogs";
import { Avatar } from "../page/PageHeader";
import { Button, StatusPill } from "../ui/primitives";

const page = pageForPath("/enterprises")!;
const CONTACT_LABEL = { commercial: "Commercial", technical: "Technical", rates: "Rates", finance: "Finance" } as const;

/** The four contacts' emails only, no names or phones (team trial round 3; tidied in round 4). */
function EnterpriseEmails({ id }: { id: number }) {
  const q = useEnterprise(id);
  if (!q.data) return <p className="muted small">{q.isError ? problemText(q.error) : "Loading…"}</p>;
  return (
    <dl className="kv">
      {(Object.keys(CONTACT_LABEL) as (keyof typeof CONTACT_LABEL)[]).map((k) => {
        const c = q.data!.contacts[k];
        return (
          <Fragment key={k}>
            <dt>{CONTACT_LABEL[k]}</dt>
            <dd>
              {c?.emails.length ? (
                c.emails.map((m) => (
                  <a key={m} href={`mailto:${m}`} className="email-chip">
                    {m}
                  </a>
                ))
              ) : (
                <span className="muted">—</span>
              )}
            </dd>
          </Fragment>
        );
      })}
    </dl>
  );
}
const TYPE_LABEL = { customer: "Customer", vendor: "Vendor", reciprocal: "Bilateral" } as const;
const TYPE_TONE = { customer: "blue", vendor: "amber", reciprocal: "violet" } as const;

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
  const deleteMany = useBulkDelete();
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
      // Several selected: the header's Delete acts on all of them (team trial round 4, replacing Bulk edit).
      selection={{
        bulk: (ids, clear, rows) => [
          {
            label: `Delete ${ids.length} enterprises…`,
            icon: "trash",
            danger: true,
            disabled: !rows.some((r) => !r.archivedAt),
            onSelect: async () => {
              const live = rows.filter((r) => !r.archivedAt);
              if (await deleteMany("enterprise", live, "enterprise")) clear();
            },
          },
        ],
      }}
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
      // The detail panel as a card (team trial round 4): tile, name and chips; the key facts; then the
      // contacts' emails under the ID, without names or phones.
      detail={(r) => ({
        title: (
          <span className="ent-card-head">
            <Avatar name={r.name} size="md" />
            <span>
              <strong>{r.name}</strong>
              <span className="muted small">
                {" "}
                {r.alias} · ID {r.id}
              </span>
            </span>
          </span>
        ),
        sections: [
          {
            key: "general",
            label: "General",
            actions: (
              <>
                <Button
                  small
                  onClick={() => navigate(`/enterprises/${r.id}`, { newTab: true, title: `Enterprise · ${r.name}` })}
                >
                  Edit
                </Button>
                <Button
                  small
                  variant="primary"
                  onClick={() => navigate(`/enterprises/${r.id}`, { newTab: true, title: `Enterprise · ${r.name}` })}
                >
                  Open full profile
                </Button>
              </>
            ),
            content: (
              <div className="ent-card">
                <div className="record-chips">
                  <span className={`chip-tag ${TYPE_TONE[r.type]}`}>{TYPE_LABEL[r.type]}</span>
                  <span className="chip-tag">{r.tier.replace("tier", "Tier ")}</span>
                  <StatusPill active={r.status === "active"} />
                  {r.archivedAt && <span className="chip-tag amber">Deleted {r.archivedAt.slice(0, 10)}</span>}
                </div>
                <dl className="kv ent-kv">
                  <dt>Company</dt>
                  <dd>{r.businessCompanyName}</dd>
                  <dt>Manager</dt>
                  <dd>{r.accountManagerName ?? "—"}</dd>
                  <dt>Country</dt>
                  <dd>{r.country ?? "—"}</dd>
                  <dt>Updated</dt>
                  <dd>
                    {r.updatedBy} · {r.updatedAt.slice(0, 16).replace("T", " ")} UTC
                  </dd>
                </dl>
              </div>
            ),
          },
        ],
        aside: (
          <div className="ent-aside">
            <dl className="kv">
              <dt>ID</dt>
              <dd className="num">{r.id}</dd>
              <dt>Created</dt>
              <dd>{r.createdAt?.slice(0, 10) ?? "—"}</dd>
            </dl>
            <h3 className="ent-detail-h">Emails</h3>
            <EnterpriseEmails id={r.id} />
          </div>
        ),
      })}
    />
  );
}
