// Enterprise record (§5.1–5.5) in its own tab: "Name – Alias (ID)" picker, sections General,
// Docs, Billing, Customer trunks, Vendor trunks, Account managers and History. Each section's
// main action is the page's one filled button (§15.3); unsaved edits mark the tab (§13.5).
import { useCan, useTabShown } from "../../api/access";
import { connectionColumn } from "../trunk/connection";
import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router";
import type { TrunkListRow } from "@sms/contract";
import { useEnterprise } from "../../api/records";
import { HistoryList } from "../../history/undo";
import { pageForPath } from "../../nav/registry";
import { Avatar, PageHeader } from "../../page/PageHeader";
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
import { confirmDialog, toast } from "../../ui/feedback";
import { fetchListPage } from "../../api/hooks";
import { openSendRate, openTechInfo } from "../switch/tools/NotificationsPage";
import { problemText } from "../routing/dialogs";
import { Icon } from "../../ui/Icon";
import { Button, Menu, Popover, StatusPill } from "../../ui/primitives";
import { AccountManagersTab } from "./AccountManagersTab";
import { BillingTab } from "./BillingTab";
import { DocsTab } from "./DocsTab";
import { GeneralTab } from "./GeneralTab";
import { EnterpriseRulesTab } from "./RulesTab";

const page = pageForPath("/enterprises")!;
const SECTIONS = [
  "general",
  "docs",
  "billing",
  "customer-trunks",
  "vendor-trunks",
  "rules",
  "account-managers",
  "history",
] as const;

/** The enterprise's live customer trunks (Notifications, team trial round 3). */
async function customerTrunkIds(enterpriseId: number): Promise<number[]> {
  const page = await fetchListPage<TrunkListRow>("customer_trunks", {
    filter: { logic: "and", conditions: [{ field: "enterpriseId", op: "eq", value: enterpriseId }] },
    limit: 500,
    withTotal: false,
  });
  return page.rows.map((r) => r.id);
}

/**
 * Notifications (team trial round 3, was "…"): Send rates e-mails the rate sheet of every customer trunk; Send tech
 * info sends one e-mail with every customer trunk's connection details (Customer Tech Info template).
 */
function NotificationsMenu({ enterpriseId, trunks }: { enterpriseId: number; trunks: number }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const run = async (what: (ids: number[]) => Promise<unknown>) => {
    try {
      const ids = await customerTrunkIds(enterpriseId);
      if (!ids.length) return toast({ tone: "info", message: "This enterprise has no customer trunks." });
      await what(ids);
    } catch (err) {
      toast({ tone: "error", message: problemText(err) });
    }
  };
  const none = trunks === 0 ? "No customer trunks" : undefined;
  return (
    <>
      <button
        ref={ref}
        type="button"
        className="btn btn-default"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
      >
        <Icon name="bell" size={14} /> Notifications <Icon name="chevronDown" size={12} />
      </button>
      <Popover anchor={ref} open={open} onClose={() => setOpen(false)} align="end">
        <Menu
          onClose={() => setOpen(false)}
          items={[
            {
              label: "Send rates…",
              icon: "send",
              disabled: trunks === 0,
              hint: none ?? "Every customer trunk's rate sheet",
              onSelect: () => void run((ids) => openSendRate(ids)),
            },
            {
              label: "Send tech info…",
              icon: "mail",
              disabled: trunks === 0,
              hint: none ?? "One e-mail with every customer trunk",
              onSelect: () => void run((ids) => openTechInfo(ids, true)),
            },
          ]}
        />
      </Popover>
    </>
  );
}

const TYPE_LABEL = { customer: "Customer", vendor: "Vendor", reciprocal: "Bilateral" } as const;
const TYPE_TONE = { customer: "blue", vendor: "amber", reciprocal: "violet" } as const;

export function EnterprisePage() {
  const raw = useParams().id;
  const id = raw === undefined || raw === "new" ? null : Number(raw);
  const navigate = useTabNavigate();
  const q = useEnterprise(id !== null && Number.isInteger(id) && id > 0 ? id : null);
  const e = q.data;
  const [section, setSection] = useSectionTab(SECTIONS);
  const canCustomerTrunks = useCan("customer-trunks");
  const canVendorTrunks = useCan("vendor-trunks");
  const shownTab = useTabShown();
  // A hidden tab opened from a link falls back to General (§11, trial round 2).
  const hiddenSection = section !== "general" && !shownTab(`enterprises.${section}`);
  useEffect(() => {
    if (hiddenSection) setSection("general");
  }, [hiddenSection, setSection]);
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
  const [onDirty] = useState(() => ({
    general: dirtyFor("general"),
    billing: dirtyFor("billing"),
    rules: dirtyFor("rules"),
  }));

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

  // A trunk tab shows only to users who may open that trunk page (backend step 10).
  const hasCustomer = e ? e.type !== "vendor" && canCustomerTrunks : false;
  const hasVendor = e ? e.type !== "customer" && canVendorTrunks : false;
  const tabs = [
    { key: "general", label: "General" },
    { key: "docs", label: "Docs", disabled: id === null },
    { key: "billing", label: "Billing", disabled: id === null },
    ...(hasCustomer
      ? [{ key: "customer-trunks", label: "Customer trunks", count: e?.trunkCounts.customer ?? null }]
      : []),
    ...(hasVendor ? [{ key: "vendor-trunks", label: "Vendor trunks", count: e?.trunkCounts.vendor ?? null }] : []),
    // Rule order over the enterprise's trunks (team trial round 4).
    { key: "rules", label: "Rules", disabled: id === null },
    { key: "account-managers", label: "Account managers", disabled: id === null },
    { key: "history", label: "History", disabled: id === null },
  ].filter((t) => shownTab(`enterprises.${t.key}`)); // tabs an access group can hide (§11, trial round 2)
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
        // Record header (team trial round 4): breadcrumb, initials tile, chips and facts under the name.
        crumbs={[{ label: "Enterprises", path: "/enterprises" }, { label: e ? e.name : "New enterprise" }]}
        avatar={<Avatar name={e?.name ?? "New"} />}
        meta={
          e && (
            <>
              <span className={`chip-tag ${TYPE_TONE[e.type]}`}>{TYPE_LABEL[e.type]}</span>
              <span className="chip-tag">{e.tier.replace("tier", "Tier ")}</span>
              <StatusPill active={e.status === "active"} />
              <span className="meta">
                {e.alias} · ID {e.id} · {e.businessCompanyName}
                {e.accountManagerName ? ` · Account Manager ${e.accountManagerName}` : ""}
              </span>
            </>
          )
        }
        heading={
          e && (
            <>
              <h1 className="sr-only">{enterpriseLabel(e)}</h1>
              <EnterprisePicker label={e.name} onPick={(x) => void goTo(`/enterprises/${x.id}`)} />
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
            {e && !e.archived && canCustomerTrunks && <NotificationsMenu enterpriseId={e.id} trunks={e.trunkCounts.customer} />}
            <span ref={setSlot} className="action-slot" />
          </>
        }
      />
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
            columns={{ name: { width: 220, render: (r) => <strong>{r.name}</strong> }, connection: connectionColumn }}
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
            columns={{ name: { width: 220, render: (r) => <strong>{r.name}</strong> }, connection: connectionColumn }}
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
        {e && section === "rules" && <EnterpriseRulesTab enterprise={e} {...props("rules")} />}
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
