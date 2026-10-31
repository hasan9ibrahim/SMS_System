// Firewall (§8): tabs Banned IP, Trusted IP (each with the inline add bar: IP Address, Select filter,
// Add; grid IP Address, Filter, Action) and Filter (Name, Status, listener and the brute-force
// threshold). An IP check shows which rule an address meets. Changes are undoable (§13.10).
import { useState } from "react";
import { useLocation } from "react-router";
import type {
  FirewallCheckResult,
  FirewallFilterInput,
  FirewallFilterRow,
  FirewallRuleRow,
  ListQuery,
} from "@sms/contract";
import { fetchListPage, useMe } from "../../../api/hooks";
import { useRestore } from "../../../api/records";
import {
  checkFirewallIp,
  useAddFirewallRule,
  useRemoveFirewallRule,
  useSaveFirewallFilter,
} from "../../../api/switchTools";
import { NumberField, SelectField, TextField, useForm } from "../../../form/form";
import { HistoryList, useNotifySaved } from "../../../history/undo";
import { pageForPath } from "../../../nav/registry";
import { ListScreen } from "../../../page/ListScreen";
import { isAdminUser, ListLookup, useDeleteRecord } from "../../../records/parts";
import { useTabNavigate } from "../../../shell/tabContext";
import { ask, toast } from "../../../ui/feedback";
import { Button, StatusDot } from "../../../ui/primitives";
import { problemText } from "../../routing/dialogs";
import { fmtWhen, RecordActions, RecordDialog } from "../../reference/shared";
import { LISTENER } from "./toolsModel";

const page = pageForPath("/switch/firewall")!;
const muted = (v: string) => <span className="muted">{v}</span>;
type View = "banned" | "trusted" | "filters";
const VIEWS: { key: View; label: string }[] = [
  { key: "banned", label: "Banned IP" },
  { key: "trusted", label: "Trusted IP" },
  { key: "filters", label: "Filter" },
];

function useView(): [View, (v: View) => void] {
  const location = useLocation();
  const navigate = useTabNavigate();
  const raw = new URLSearchParams(location.search).get("view");
  const view: View = raw === "trusted" || raw === "filters" ? raw : "banned";
  return [view, (v) => navigate(`/switch/firewall${v === "banned" ? "" : `?view=${v}`}`)];
}

function Tabs() {
  const [view, go] = useView();
  return (
    <div className="segmented small" role="tablist" aria-label="Firewall">
      {VIEWS.map((v) => (
        <button
          key={v.key}
          type="button"
          role="tab"
          aria-selected={view === v.key}
          className={view === v.key ? "on" : ""}
          onClick={() => go(v.key)}
        >
          {v.label}
        </button>
      ))}
    </div>
  );
}

function IpCheck() {
  const [ip, setIp] = useState("");
  const [res, setRes] = useState<FirewallCheckResult | null>(null);
  const run = () =>
    void checkFirewallIp(ip.trim())
      .then(setRes)
      .catch((e) => toast({ tone: "error", message: problemText(e) }));
  return (
    <span className="fw-check">
      <input
        value={ip}
        placeholder="Check an IP…"
        aria-label="IP to check"
        onChange={(e) => {
          setIp(e.target.value);
          setRes(null);
        }}
        onKeyDown={(e) => e.key === "Enter" && run()}
      />
      <Button small icon="search" disabled={!ip.trim()} onClick={run}>
        Check
      </Button>
      {res && (
        <span className="small">
          <StatusDot tone={res.decision === "banned" ? "error" : res.decision === "trusted" ? "good" : "neutral"} />{" "}
          {res.decision === "allowed"
            ? "No rule: normal checks apply"
            : `${res.decision === "banned" ? "Banned" : "Trusted"} by ${res.rules[0]!.ip} (${res.rules[0]!.filter})`}
        </span>
      )}
    </span>
  );
}

function AddBar({ list }: { list: "banned" | "trusted" }) {
  const [ip, setIp] = useState("");
  const [filterId, setFilterId] = useState<number | null>(1);
  const [reason, setReason] = useState("");
  const add = useAddFirewallRule();
  const notifySaved = useNotifySaved();
  const submit = () =>
    filterId &&
    add.mutate(
      { list, ip: ip.trim(), filterId, reason: reason.trim() || null },
      {
        onSuccess: (r) => {
          if (r.change) notifySaved(r.change, r.change.note ?? "Added");
          setIp("");
          setReason("");
        },
        onError: (e) => toast({ tone: "error", message: problemText(e) }),
      },
    );
  return (
    <form
      className="fw-add"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <input
        value={ip}
        placeholder="IP Address or range, e.g. 198.51.100.7 or 198.51.100.0/24"
        aria-label="IP Address"
        onChange={(e) => setIp(e.target.value)}
      />
      <div className="fw-filter">
        <ListLookup<FirewallFilterRow>
          list="firewall_filters"
          value={filterId}
          onChange={(f) => setFilterId(f?.id ?? null)}
          labelOf={(f) => f.name}
          detailOf={(f) => LISTENER[f.listener] ?? f.listener}
          placeholder="Select filter"
          clearable={false}
        />
      </div>
      <input
        value={reason}
        placeholder="Reason (optional)"
        aria-label="Reason"
        maxLength={300}
        onChange={(e) => setReason(e.target.value)}
      />
      <Button type="submit" variant="primary" icon="plus" disabled={!ip.trim() || !filterId || add.isPending}>
        {list === "banned" ? "Ban" : "Trust"}
      </Button>
    </form>
  );
}

function RulesView({ list }: { list: "banned" | "trusted" }) {
  const remove = useRemoveFirewallRule();
  const notifySaved = useNotifySaved();
  const { data: me } = useMe();
  const admin = isAdminUser(me?.permissions);
  const deleteOne = useDeleteRecord();
  const restore = useRestore("firewall_rule");
  const withList = (body: ListQuery): ListQuery => ({
    ...body,
    filter: {
      logic: "and",
      conditions: [{ field: "list", op: "eq", value: list }, ...(body.filter ? [body.filter] : [])],
    },
  });
  return (
    <ListScreen<FirewallRuleRow>
      key={list}
      list="firewall_rules"
      page={page}
      title={list === "banned" ? "Firewall · Banned IP" : "Firewall · Trusted IP"}
      queryScope={list}
      fetchPage={(body) => fetchListPage<FirewallRuleRow>("firewall_rules", withList(body))}
      noSelection
      historyScope={{ entityTypes: ["firewall_rule"] }}
      rowActions={(r) => [
        {
          label: "Remove",
          icon: "x",
          main: true,
          disabled: !!r.archivedAt || remove.isPending,
          hint: r.archivedAt ? "Already removed" : `Remove ${r.ip} from the list`,
          onSelect: () =>
            remove.mutate(r.id, {
              onSuccess: (x) => x.change && notifySaved(x.change, `Removed ${r.ip}`),
              onError: (err) => toast({ tone: "error", message: problemText(err) }),
            }),
        },
        "separator",
        r.archivedAt
          ? {
              label: "Restore",
              icon: "undo",
              disabled: !admin || restore.isPending,
              hint: admin ? undefined : "Deleted. An administrator can restore it.",
              onSelect: () =>
                restore.mutate(r.id, {
                  onSuccess: (x) => x.change && notifySaved(x.change, `Restored ${r.ip}`),
                  onError: (err) => toast({ tone: "error", message: problemText(err) }),
                }),
            }
          : {
              label: "Delete…",
              icon: "trash",
              danger: true,
              onSelect: () => void deleteOne("firewall_rule", r.id, r.ip),
            },
      ]}
      above={
        <div className="fw-above">
          <div className="rm-trunk">
            <Tabs />
            <span className="fb-spacer" />
            <IpCheck />
          </div>
          <AddBar list={list} />
        </div>
      }
      columns={{
        ip: { width: 220, render: (r) => <strong className="num">{r.ip}</strong> },
        filter: { width: 160 },
        source: { width: 110, render: (r) => (r.source === "auto" ? "Automatic" : "Manual") },
        reason: { width: 260, render: (r) => r.reason ?? muted("—") },
        hits: {
          width: 110,
          align: "right",
          render: (r) => <span className="num">{r.hits.toLocaleString("en-US")}</span>,
        },
        lastHitAt: { width: 170, render: (r) => (r.lastHitAt ? fmtWhen(r.lastHitAt) : muted("—")) },
        expiresAt: { width: 170, render: (r) => (r.expiresAt ? fmtWhen(r.expiresAt) : muted("never")) },
        createdAt: { width: 170, render: (r) => fmtWhen(r.createdAt) },
      }}
      trailing={{
        header: "Action",
        width: 90,
        render: (r) =>
          r.archivedAt ? (
            muted("removed")
          ) : (
            <button
              type="button"
              className="link small"
              onClick={(e) => {
                e.stopPropagation();
                remove.mutate(r.id, {
                  onSuccess: (x) => x.change && notifySaved(x.change, `Removed ${r.ip}`),
                  onError: (err) => toast({ tone: "error", message: problemText(err) }),
                });
              }}
            >
              Remove
            </button>
          ),
      }}
      detail={(r) => ({
        title: (
          <>
            <strong>{r.ip}</strong>
            <span className="muted">
              {r.list === "banned" ? "Banned" : "Trusted"} · {r.filter}
            </span>
          </>
        ),
        sections: [
          {
            key: "rule",
            label: "Rule",
            actions: <RecordActions kind="firewall_rule" id={r.id} name={r.ip} archived={!!r.archivedAt} />,
            content: (
              <dl className="kv">
                <dt>Source</dt>
                <dd>{r.source === "auto" ? "Brute-force protection" : `Added by ${r.createdBy ?? "—"}`}</dd>
                <dt>Reason</dt>
                <dd>{r.reason ?? "—"}</dd>
                <dt>Hits (24 h)</dt>
                <dd>{r.hits.toLocaleString("en-US")}</dd>
                <dt>Expires</dt>
                <dd>{r.expiresAt ? fmtWhen(r.expiresAt) : "never"}</dd>
              </dl>
            ),
          },
          {
            key: "history",
            label: "History",
            content: <HistoryList scope={{ entityTypes: ["firewall_rule"], entityId: r.id }} />,
          },
        ],
      })}
      shortcuts="↑↓ move · Ctrl+Z undo"
    />
  );
}

function FilterDialog({ row, done }: { row: FirewallFilterRow | null; done: () => void }) {
  const form = useForm<FirewallFilterInput>(
    row ?? { name: "", listener: "smpp", status: "active", failedAttempts: 5, windowSeconds: 60, banMinutes: 60 },
  );
  const save = useSaveFirewallFilter();
  const notifySaved = useNotifySaved();
  const [error, setError] = useState<string | null>(null);
  const v = form.values;
  return (
    <RecordDialog
      form={form}
      title={row ? `Edit filter ${row.name}` : "Add filter"}
      saveLabel={row ? "Save" : "Add filter"}
      saving={save.isPending}
      error={error}
      onClose={done}
      onSave={() =>
        save.mutate(
          {
            id: row?.id ?? null,
            input: {
              name: v.name,
              listener: v.listener,
              status: v.status,
              failedAttempts: v.failedAttempts,
              windowSeconds: v.windowSeconds,
              banMinutes: v.banMinutes,
            },
          },
          {
            onSuccess: (r) => {
              if (r.change) notifySaved(r.change, `Saved filter ${r.record.name}`);
              done();
            },
            onError: (e) => setError(form.fail(e)),
          },
        )
      }
    >
      <TextField form={form} path="name" label="Name" required maxLength={60} nullable={false} />
      <SelectField
        form={form}
        path="listener"
        label="Listener"
        required
        options={Object.entries(LISTENER).map(([value, label]) => ({ value, label }))}
      />
      <SelectField
        form={form}
        path="status"
        label="Status"
        required
        options={[
          { value: "active", label: "Active" },
          { value: "inactive", label: "Inactive" },
        ]}
      />
      <NumberField form={form} path="failedAttempts" label="Failed attempts" required min={1} max={1000} step={1} />
      <NumberField form={form} path="windowSeconds" label="Within (seconds)" required min={10} max={86400} step={1} />
      <NumberField form={form} path="banMinutes" label="Ban for (minutes)" required min={1} max={525600} step={1} />
      <p className="muted small wide">
        {v.failedAttempts} failed binds or logins within {v.windowSeconds} s ban the address for {v.banMinutes} minutes.
      </p>
    </RecordDialog>
  );
}

function FiltersView() {
  const open = (row: FirewallFilterRow | null) => ask<void>((d) => <FilterDialog row={row} done={() => d()} />);
  return (
    <ListScreen<FirewallFilterRow>
      list="firewall_filters"
      page={page}
      title="Firewall · Filter"
      noSelection
      historyScope={{ entityTypes: ["firewall_filter"] }}
      rowActions={(r) => [{ label: "Edit", icon: "file", main: true, onSelect: () => void open(r) }]}
      above={
        <div className="rm-trunk">
          <Tabs />
        </div>
      }
      primary={{ label: "Add filter", icon: "plus", onClick: () => void open(null) }}
      columns={{
        name: { width: 200, render: (r) => <strong>{r.name}</strong> },
        listener: { width: 130, render: (r) => LISTENER[r.listener] },
        status: {
          width: 110,
          render: (r) => (
            <span>
              <StatusDot tone={r.status === "active" ? "good" : "neutral"} />{" "}
              {r.status === "active" ? "Active" : "Inactive"}
            </span>
          ),
        },
        failedAttempts: { width: 130, align: "right" },
        windowSeconds: { width: 110, align: "right" },
        banMinutes: { width: 110, align: "right" },
        banned: { width: 100, align: "right" },
        trusted: { width: 100, align: "right" },
      }}
      onOpen={(r) => void open(r)}
      detail={(r) => ({
        title: (
          <>
            <strong>{r.name}</strong>
            <span className="muted">{LISTENER[r.listener]}</span>
          </>
        ),
        sections: [
          {
            key: "filter",
            label: "Filter",
            actions: (
              <Button small icon="file" onClick={() => void open(r)}>
                Edit
              </Button>
            ),
            content: (
              <dl className="kv">
                <dt>Automatic ban</dt>
                <dd>
                  {r.failedAttempts} failed attempts within {r.windowSeconds} s → banned for {r.banMinutes} min
                </dd>
                <dt>Rules</dt>
                <dd>
                  {r.banned} banned · {r.trusted} trusted
                </dd>
                <dt>Updated</dt>
                <dd>
                  {fmtWhen(r.updatedAt)} {r.updatedBy ? `by ${r.updatedBy}` : ""}
                </dd>
              </dl>
            ),
          },
          {
            key: "history",
            label: "History",
            content: <HistoryList scope={{ entityTypes: ["firewall_filter"], entityId: r.id }} />,
          },
        ],
      })}
      shortcuts="↑↓ move · Enter edits · Ctrl+Z undo"
    />
  );
}

export function FirewallPage() {
  const [view] = useView();
  if (view === "filters") return <FiltersView />;
  return <RulesView list={view} />;
}
