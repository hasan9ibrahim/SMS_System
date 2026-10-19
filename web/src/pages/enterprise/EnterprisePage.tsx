// Enterprise record (§5.1–5.5) in its own tab: "Name – Alias (ID)" picker, sections General,
// Docs, Billing, Customer trunks, Vendor trunks, Account managers and History. Each section's
// main action is the page's one filled button (§15.3); unsaved edits mark the tab (§13.5).
import { useCallback, useRef, useState } from "react";
import { useParams } from "react-router";
import type { TrunkListRow } from "@sms/contract";
import { useEnterprise } from "../../api/records";
import { HistoryList } from "../../history/undo";
import { pageForPath } from "../../nav/registry";
import { PageHeader } from "../../page/PageHeader";
import {
  ArchivedBanner,
  ChildGrid,
  EnterprisePicker,
  HeaderAction,
  SectionTabs,
  type SectionProps,
  enterpriseLabel,
  useDeleteRecord,
  useSectionTab,
} from "../../records/parts";
import { usePageStatus, useTabDirty, useTabNavigate, useTabTitle } from "../../shell/tabContext";
import { confirmDialog } from "../../ui/feedback";
import { Icon } from "../../ui/Icon";
import { Button, Menu, Popover } from "../../ui/primitives";
import { AccountManagersTab } from "./AccountManagersTab";
import { BillingTab } from "./BillingTab";
import { DocsTab } from "./DocsTab";
import { GeneralTab } from "./GeneralTab";

const page = pageForPath("/enterprises")!;
const SECTIONS = [
  "general",
  "docs",
  "billing",
  "customer-trunks",
  "vendor-trunks",
  "account-managers",
  "history",
] as const;

function MoreMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={ref}
        type="button"
        className="btn btn-ghost"
        onClick={() => setOpen((v) => !v)}
        aria-label="More actions"
        aria-haspopup="menu"
      >
        <Icon name="more" size={15} />
      </button>
      <Popover anchor={ref} open={open} onClose={() => setOpen(false)} align="end">
        <Menu
          onClose={() => setOpen(false)}
          items={[
            // §13.13: sending rate sheets and tech info by email arrives with the rate notices.
            { label: "Send rates…", icon: "send", disabled: true, onSelect: () => {} },
            { label: "Send tech info…", icon: "mail", disabled: true, onSelect: () => {} },
          ]}
        />
      </Popover>
    </>
  );
}

export function EnterprisePage() {
  const raw = useParams().id;
  const id = raw === undefined || raw === "new" ? null : Number(raw);
  const navigate = useTabNavigate();
  const q = useEnterprise(id !== null && Number.isInteger(id) && id > 0 ? id : null);
  const e = q.data;
  const [section, setSection] = useSectionTab(SECTIONS);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const [dirty, setDirty] = useState<Record<string, boolean>>({});
  const anyDirty = Object.values(dirty).some(Boolean);
  const deleteRecord = useDeleteRecord();
  // Sections stay mounted once opened, so switching sections keeps unsaved edits.
  const [visited, setVisited] = useState<Set<string>>(() => new Set([section]));
  if (!visited.has(section)) setVisited(new Set([...visited, section]));

  useTabTitle(id === null ? "New enterprise" : e ? `Enterprise · ${e.name}` : undefined);
  useTabDirty(anyDirty);
  usePageStatus({ rows: e ? `Enterprise ${e.id} · ${e.type} · ${e.status}` : id === null ? "New enterprise" : "" });

  const dirtyFor = useCallback(
    (key: string) => (d: boolean) => setDirty((m) => (m[key] === d ? m : { ...m, [key]: d })),
    [],
  );
  const [onDirty] = useState(() => ({ general: dirtyFor("general"), billing: dirtyFor("billing") }));

  const goTo = async (path: string) => {
    if (
      anyDirty &&
      !(await confirmDialog({
        title: "Discard unsaved changes?",
        message: "Your edits on this enterprise are not saved.",
        ok: "Discard",
        danger: true,
      }))
    )
      return;
    setDirty({});
    navigate(path);
  };

  const hasCustomer = e ? e.type !== "vendor" : false;
  const hasVendor = e ? e.type !== "customer" : false;
  const tabs = [
    { key: "general", label: "General" },
    { key: "docs", label: "Docs", disabled: id === null },
    { key: "billing", label: "Billing", disabled: id === null },
    ...(hasCustomer
      ? [{ key: "customer-trunks", label: "Customer trunks", count: e?.trunkCounts.customer ?? null }]
      : []),
    ...(hasVendor ? [{ key: "vendor-trunks", label: "Vendor trunks", count: e?.trunkCounts.vendor ?? null }] : []),
    { key: "account-managers", label: "Account managers", disabled: id === null },
    { key: "history", label: "History", disabled: id === null },
  ];
  const props = (key: string): SectionProps => ({
    slot: key === section ? slot : null,
    onDirty: onDirty[key as keyof typeof onDirty] ?? (() => {}),
  });
  const openTrunk = (kind: "customer" | "vendor") => (row: TrunkListRow, ev: { ctrlKey: boolean; metaKey: boolean }) =>
    navigate(`/enterprises/${kind}-trunks/${row.id}`, {
      newTab: true,
      forceNew: ev.ctrlKey || ev.metaKey,
      title: `${kind === "customer" ? "Customer" : "Vendor"} trunk · ${row.name}`,
    });

  if (q.isError) {
    return (
      <div className="page">
        <PageHeader page={page} title={`Enterprise ${raw}`} helpTopic="enterprise-record" />
        <div className="grid-message error">
          <Icon name="alert" /> {(q.error as Error).message}
        </div>
      </div>
    );
  }
  if (id !== null && !e) {
    return (
      <div className="page">
        <PageHeader page={page} title={`Enterprise ${id}`} helpTopic="enterprise-record" />
        <div className="grid-message muted">Loading…</div>
      </div>
    );
  }

  return (
    <div className="page record-page">
      <PageHeader
        helpTopic="enterprise-record"
        page={page}
        title="New enterprise"
        heading={
          e && (
            <>
              <h1 className="sr-only">{enterpriseLabel(e)}</h1>
              <EnterprisePicker label={enterpriseLabel(e)} onPick={(x) => void goTo(`/enterprises/${x.id}`)} />
            </>
          )
        }
        actions={
          <>
            {e && !e.archived && (
              <Button
                icon="trash"
                onClick={async () => {
                  const r = await deleteRecord("enterprise", e.id, enterpriseLabel(e));
                  if (r) setDirty({});
                }}
              >
                Delete
              </Button>
            )}
            {e && <MoreMenu />}
            <span ref={setSlot} className="action-slot" />
          </>
        }
      />
      {e && (
        <div className="record-meta muted">
          {e.type[0]!.toUpperCase() + e.type.slice(1)} · {e.tier.replace("tier", "Tier ")} · {e.businessCompanyName}
          {e.accountManagerName ? ` · AM ${e.accountManagerName}` : ""} ·{" "}
          {e.status === "active" ? "Active" : "Inactive"}
        </div>
      )}
      {e && <ArchivedBanner kind="enterprise" id={e.id} archived={e.archived} what="enterprise" />}
      <SectionTabs tabs={tabs} current={section} onChange={setSection} />
      <div className={`record-body${section.endsWith("trunks") ? " fill" : ""}`}>
        {visited.has("general") && (
          <div hidden={section !== "general"}>
            <GeneralTab key={id ?? "new"} record={e ?? null} {...props("general")} onOpenSection={setSection} />
          </div>
        )}
        {e && visited.has("docs") && section === "docs" && <DocsTab enterprise={e} {...props("docs")} />}
        {e && visited.has("billing") && (
          <div hidden={section !== "billing"}>
            <BillingTab key={e.id} enterprise={e} {...props("billing")} />
          </div>
        )}
        {e && section === "customer-trunks" && (
          <ChildGrid<TrunkListRow>
            key={`c${e.id}`}
            list="customer_trunks"
            fixed={{ enterpriseId: { field: "enterpriseId", op: "eq", value: e.id } }}
            hide={["enterpriseName"]}
            columns={{ name: { width: 220, render: (r) => <strong>{r.name}</strong> } }}
            onOpen={openTrunk("customer")}
            toolbar={
              <HeaderAction slot={slot}>
                <Button
                  variant="primary"
                  icon="plus"
                  disabled={!!e.archived}
                  onClick={() =>
                    navigate(`/enterprises/customer-trunks/new?enterprise=${e.id}`, {
                      newTab: true,
                      title: "New customer trunk",
                    })
                  }
                >
                  New customer trunk
                </Button>
              </HeaderAction>
            }
          />
        )}
        {e && section === "vendor-trunks" && (
          <ChildGrid<TrunkListRow>
            key={`v${e.id}`}
            list="vendor_trunks"
            fixed={{ enterpriseId: { field: "enterpriseId", op: "eq", value: e.id } }}
            hide={["enterpriseName"]}
            columns={{ name: { width: 220, render: (r) => <strong>{r.name}</strong> } }}
            onOpen={openTrunk("vendor")}
            toolbar={
              <HeaderAction slot={slot}>
                <Button
                  variant="primary"
                  icon="plus"
                  disabled={!!e.archived}
                  onClick={() =>
                    navigate(`/enterprises/vendor-trunks/new?enterprise=${e.id}`, {
                      newTab: true,
                      title: "New vendor trunk",
                    })
                  }
                >
                  New vendor trunk
                </Button>
              </HeaderAction>
            }
          />
        )}
        {e && section === "account-managers" && <AccountManagersTab enterprise={e} {...props("account-managers")} />}
        {e && section === "history" && (
          <div className="card">
            <HistoryList scope={{ entityTypes: ["enterprise"], entityId: e.id }} />
          </div>
        )}
      </div>
    </div>
  );
}
