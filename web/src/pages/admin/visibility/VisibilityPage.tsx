// Admin › Visibility policies (§13.17): one page with three views kept in the tab URL (?view=).
// - Policies: what is masked and hidden, thresholds, scope of own; new ones start from a preset.
// - Assignments: all account managers, a department or a user (user wins over department over all),
//   and a check of any user's effective policy with a preview as that user.
// - Shares & temporary access: sight of one enterprise, lasting or until a date; expires by itself.
import { useState } from "react";
import { useLocation } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import type {
  EffectiveVisibility,
  VisibilityAssignment,
  VisibilityGrant,
  VisibilityMode,
  VisibilityPolicyInput,
  VisibilityPolicyRow,
  VisibilityTargetType,
} from "@sms/contract";
import { setViewAs } from "../../../api/client";
import {
  useAssignVisibility,
  useGrantVisibility,
  useRemoveVisibilityAssignment,
  useRevokeVisibilityGrant,
  useSaveVisibilityPolicy,
  useUserVisibility,
  useVisibilityPolicy,
  useVisibilityPresets,
} from "../../../api/visibility";
import { useMe } from "../../../api/hooks";
import { useNotifySaved } from "../../../history/undo";
import { pageForPath } from "../../../nav/registry";
import { ListScreen } from "../../../page/ListScreen";
import { ListLookup } from "../../../records/parts";
import { useTabNavigate } from "../../../shell/tabContext";
import { ask, toast } from "../../../ui/feedback";
import { Button, Modal, StatusDot } from "../../../ui/primitives";
import { fmtWhen } from "../../reference/shared";
import { problemText } from "../../routing/dialogs";
import {
  blankPolicy,
  effectiveLine,
  hiddenWords,
  isView,
  ITEMS,
  MODE_LABEL,
  modesFor,
  policyInput,
  policyProblems,
  VIEWS,
  type VisibilityView,
} from "./visibilityModel";
import { DateTimeInput } from "../../../ui/DateTimeInput";

const page = pageForPath("/admin/visibility")!;
const fail = (e: unknown) => toast({ tone: "error", message: problemText(e) });

function useVisNav() {
  const location = useLocation();
  const navigate = useTabNavigate();
  const raw = new URLSearchParams(location.search).get("view");
  const view: VisibilityView = isView(raw) ? raw : "policies";
  return { view, go: (next: VisibilityView) => navigate(`/admin/visibility?view=${next}`, { replace: true }) };
}

function ViewSwitch() {
  const { view, go } = useVisNav();
  return (
    <div className="rm-trunk">
      <div className="segmented small" role="radiogroup" aria-label="Visibility view">
        {VIEWS.map((v) => (
          <button
            key={v.key}
            type="button"
            role="radio"
            aria-checked={view === v.key}
            className={view === v.key ? "on" : ""}
            onClick={() => go(v.key)}
          >
            {v.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Starts previewing the system as this user sees it (administrators, X-View-As). */
export function usePreviewAs() {
  const qc = useQueryClient();
  return (user: { id: number; name: string } | null) => {
    setViewAs(user?.id ?? null);
    void qc.resetQueries();
    toast({
      tone: "good",
      message: user
        ? `Previewing as ${user.name}: lists, records and search answer as they would see them`
        : "Preview ended",
    });
  };
}

/** A user's effective policy (shown on their profile and in Assignments). */
export function EffectiveCard({ v, preview = true }: { v: EffectiveVisibility; preview?: boolean }) {
  const { data: me } = useMe();
  const previewAs = usePreviewAs();
  const isAdmin = !!me?.permissions.includes("*");
  return (
    <div className="vis-card">
      <div>
        <strong>{v.userName}</strong> <span className="muted">· {effectiveLine(v)}</span>
      </div>
      {v.policy && (
        <div className="small">
          {v.policy.maskOthers ? "Others' enterprises and trunks appear as IDs" : "Names shown"} · hidden{" "}
          {hiddenWords(v.policy.items)}
          {v.costVendors ? ` · ${v.costVendors} vendors count as own for cost (traffic)` : ""}
        </div>
      )}
      {v.grants.length > 0 && (
        <div className="small muted">
          Access to{" "}
          {v.grants.map((g) => `${g.enterpriseName}${g.expiresAt ? ` until ${fmtWhen(g.expiresAt)}` : ""}`).join(", ")}
        </div>
      )}
      {preview && isAdmin && !v.exempt && me?.id !== v.userId && (
        <Button icon="eye" onClick={() => previewAs({ id: v.userId, name: v.userName })}>
          Preview as {v.userName}
        </Button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- policies

function PolicyDialog({ id, done }: { id: number | null; done: (v: boolean | null) => void }) {
  const existing = useVisibilityPolicy(id);
  const presets = useVisibilityPresets();
  const save = useSaveVisibilityPolicy();
  const notifySaved = useNotifySaved();
  const [draft, setDraft] = useState<VisibilityPolicyInput | null>(null);
  const base = id === null ? blankPolicy() : existing.data ? policyInput(existing.data) : null;
  const p = draft ?? base;
  if (!p) return null;
  const setP = (patch: Partial<VisibilityPolicyInput>) => setDraft({ ...p, ...patch });
  const setItem = (k: (typeof ITEMS)[number]["key"], side: "others" | "own", mode: VisibilityMode) =>
    setP({ items: { ...p.items, [k]: { ...p.items[k], [side]: mode } } });
  const setTh = (patch: Partial<VisibilityPolicyInput["thresholds"]>) =>
    setP({ thresholds: { ...p.thresholds, ...patch } });
  const problems = policyProblems(p);
  const numOrNull = (v: string) => (v === "" ? null : Number(v));
  return (
    <Modal
      title={id === null ? "New visibility policy" : `Visibility policy · ${p.name}`}
      width={760}
      onClose={() => done(null)}
      footer={
        <>
          <Button onClick={() => done(null)}>Cancel</Button>
          <Button
            variant="primary"
            disabled={Object.keys(problems).length > 0 || save.isPending}
            onClick={() =>
              save.mutate(
                { id, input: p },
                {
                  onSuccess: (r) => {
                    if (r.change) notifySaved(r.change, `Saved ${r.record.name}`);
                    done(true);
                  },
                  onError: fail,
                },
              )
            }
          >
            Save
          </Button>
        </>
      }
    >
      {id === null && presets.data && (
        <div className="bulk-row vis-presets">
          <span className="muted small">Start from a preset:</span>
          {presets.data.map((x) => (
            <Button key={x.key} onClick={() => setDraft({ ...x.fields, name: `${x.fields.name} (copy)` })}>
              {x.fields.name}
            </Button>
          ))}
        </div>
      )}
      <div className="rn-form-grid">
        <label className="field">
          <span>Name</span>
          <input autoFocus value={p.name} maxLength={120} onChange={(e) => setP({ name: e.target.value })} />
          {problems.name && <small className="tone-error">{problems.name}</small>}
        </label>
        <label className="field">
          <span>Status</span>
          <select
            value={p.status}
            onChange={(e) => setP({ status: e.target.value as VisibilityPolicyInput["status"] })}
          >
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </select>
        </label>
        <label className="field rn-span">
          <span>Description</span>
          <input
            value={p.description ?? ""}
            maxLength={500}
            onChange={(e) => setP({ description: e.target.value || null })}
          />
        </label>
        <label className="toggle-inline rn-span">
          <input type="checkbox" checked={p.maskOthers} onChange={(e) => setP({ maskOthers: e.target.checked })} />
          Mask others&apos; enterprises and trunks as IDs (&quot;Customer #2481&quot;), everywhere: lists, search,
          records, exports
        </label>
        <label className="toggle-inline rn-span">
          <input type="checkbox" checked={p.includeTeam} onChange={(e) => setP({ includeTeam: e.target.checked })} />
          For team leads: their team members&apos; enterprises count as own
        </label>
      </div>
      <table className="vis-items">
        <thead>
          <tr>
            <th>Item</th>
            <th>Others&apos; clients and vendors</th>
            <th>Own</th>
          </tr>
        </thead>
        <tbody>
          {ITEMS.map((i) => (
            <tr key={i.key}>
              <td>
                {i.label}
                {i.hint && <div className="muted small">{i.hint}</div>}
                {problems[i.key] && <small className="tone-error">{problems[i.key]}</small>}
              </td>
              {(["others", "own"] as const).map((side) => (
                <td key={side}>
                  <div className="segmented small" role="radiogroup" aria-label={`${i.label} · ${side}`}>
                    {modesFor(i.key).map((m) => (
                      <button
                        key={m}
                        type="button"
                        role="radio"
                        aria-checked={p.items[i.key][side] === m}
                        className={p.items[i.key][side] === m ? "on" : ""}
                        onClick={() => setItem(i.key, side, m)}
                      >
                        {MODE_LABEL[m]}
                      </button>
                    ))}
                  </div>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="rn-form-grid">
        <label className="field">
          <span>Margin band: Low below (%)</span>
          <input
            type="number"
            value={p.thresholds.marginLowPct}
            onChange={(e) => setTh({ marginLowPct: Number(e.target.value) })}
          />
        </label>
        <label className="field">
          <span>Margin band: High above (%)</span>
          <input
            type="number"
            value={p.thresholds.marginHighPct}
            onChange={(e) => setTh({ marginHighPct: Number(e.target.value) })}
          />
          {problems.bands && <small className="tone-error">{problems.bands}</small>}
        </label>
        <label className="field">
          <span>Show revenue only up to (platform currency)</span>
          <input
            type="number"
            min={0}
            placeholder="no limit"
            value={p.thresholds.revenueHideAbove ?? ""}
            onChange={(e) => setTh({ revenueHideAbove: numOrNull(e.target.value) })}
          />
        </label>
        <label className="field">
          <span>Cost of vendors carrying own clients&apos; traffic, last (days)</span>
          <input
            type="number"
            min={1}
            max={365}
            placeholder="never"
            value={p.thresholds.costTrafficDays ?? ""}
            onChange={(e) => setTh({ costTrafficDays: numOrNull(e.target.value) })}
          />
        </label>
      </div>
    </Modal>
  );
}

function PoliciesView() {
  const edit = (id: number | null) => void ask<boolean>((done) => <PolicyDialog id={id} done={done} />);
  return (
    <ListScreen<VisibilityPolicyRow>
      list="visibility_policies"
      page={page}
      above={<ViewSwitch />}
      noSelection
      historyScope={{ entityTypes: ["visibility_policy"] }}
      primary={{ label: "New policy", onClick: () => edit(null) }}
      rowActions={(r) => [{ label: "Edit", icon: "file", main: true, onSelect: () => edit(r.id) }]}
      columns={{
        name: { width: 200, render: (r) => <strong>{r.name}</strong> },
        status: {
          width: 100,
          render: (r) => (
            <span>
              <StatusDot tone={r.status === "active" ? "good" : "neutral"} />{" "}
              {r.status === "active" ? "Active" : "Inactive"}
            </span>
          ),
        },
        maskOthers: { width: 110, render: (r) => (r.maskOthers ? "Yes" : "No") },
        includeTeam: { width: 140, render: (r) => (r.includeTeam ? "Yes" : "No") },
        assignments: { width: 110, align: "right" },
        description: {
          width: 460,
          render: (r) => (
            <span title={r.summary}>
              {r.description ? `${r.description} · ` : ""}
              <span className="muted">{r.summary}</span>
            </span>
          ),
        },
        updatedAt: { width: 160, render: (r) => fmtWhen(r.updatedAt) },
      }}
      onOpen={(r) => edit(r.id)}
      shortcuts="Enter or double-click: edit · assign policies in Assignments · every change goes to the Audit Trail"
    />
  );
}

// ---------------------------------------------------------------- assignments

function AssignDialog({ done }: { done: (v: boolean | null) => void }) {
  const assign = useAssignVisibility();
  const [targetType, setTargetType] = useState<VisibilityTargetType>("user");
  const [targetId, setTargetId] = useState<number | null>(null);
  const [policyId, setPolicyId] = useState<number | null>(null);
  const ready = policyId !== null && (targetType === "all_ams" || targetId !== null);
  return (
    <Modal
      title="Assign a visibility policy"
      onClose={() => done(null)}
      footer={
        <>
          <Button onClick={() => done(null)}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!ready || assign.isPending}
            onClick={() =>
              assign.mutate(
                { policyId: policyId!, targetType, targetId: targetType === "all_ams" ? null : targetId },
                {
                  onSuccess: (a) => {
                    toast({ tone: "good", message: `${a.policyName} assigned to ${a.targetName}` });
                    done(true);
                  },
                  onError: fail,
                },
              )
            }
          >
            Assign
          </Button>
        </>
      }
    >
      <label className="field">
        <span>Assign to</span>
        <select
          value={targetType}
          onChange={(e) => {
            setTargetType(e.target.value as VisibilityTargetType);
            setTargetId(null);
          }}
        >
          <option value="user">A user</option>
          <option value="department">A department</option>
          <option value="all_ams">All account managers</option>
        </select>
      </label>
      {targetType === "user" && (
        <div className="field">
          <span>User</span>
          <ListLookup<{ id: number; displayName: string; username: string }>
            list="users"
            value={targetId}
            onChange={(r) => setTargetId(r?.id ?? null)}
            labelOf={(r) => `${r.displayName} (${r.username})`}
            placeholder="Choose a user…"
          />
        </div>
      )}
      {targetType === "department" && (
        <div className="field">
          <span>Department</span>
          <ListLookup<{ id: number; name: string }>
            list="departments"
            value={targetId}
            onChange={(r) => setTargetId(r?.id ?? null)}
            labelOf={(r) => r.name}
            placeholder="Choose a department…"
          />
        </div>
      )}
      <div className="field">
        <span>Policy</span>
        <ListLookup<{ id: number; name: string; summary: string }>
          list="visibility_policies"
          value={policyId}
          onChange={(r) => setPolicyId(r?.id ?? null)}
          labelOf={(r) => r.name}
          detailOf={(r) => r.summary}
          placeholder="Choose a policy…"
        />
      </div>
      <p className="muted small">
        A user&apos;s own assignment wins over their department&apos;s, which wins over the one for all account
        managers. Administrators are never restricted. Replaces the target&apos;s earlier assignment.
      </p>
    </Modal>
  );
}

function CheckUser() {
  const [userId, setUserId] = useState<number | null>(null);
  const v = useUserVisibility(userId);
  return (
    <div className="vis-check">
      <div className="field">
        <span>Check a user&apos;s effective policy</span>
        <ListLookup<{ id: number; displayName: string; username: string }>
          list="users"
          value={userId}
          onChange={(r) => setUserId(r?.id ?? null)}
          labelOf={(r) => `${r.displayName} (${r.username})`}
          placeholder="Choose a user…"
        />
      </div>
      {v.data && <EffectiveCard v={v.data} />}
    </div>
  );
}

function AssignmentsView() {
  const remove = useRemoveVisibilityAssignment();
  return (
    <ListScreen<VisibilityAssignment>
      list="visibility_assignments"
      page={page}
      above={
        <>
          <ViewSwitch />
          <CheckUser />
        </>
      }
      noSelection
      historyScope={null}
      primary={{ label: "Assign policy", onClick: () => void ask<boolean>((done) => <AssignDialog done={done} />) }}
      rowActions={(r) => [
        {
          label: "Remove",
          icon: "trash",
          danger: true,
          disabled: remove.isPending,
          hint: `Remove ${r.policyName} from ${r.targetName}`,
          onSelect: () =>
            remove.mutate(r.id, {
              onSuccess: () => toast({ tone: "good", message: `Removed ${r.policyName} from ${r.targetName}` }),
              onError: fail,
            }),
        },
      ]}
      columns={{
        targetType: {
          width: 170,
          render: (r) =>
            r.targetType === "all_ams" ? "All account managers" : r.targetType === "department" ? "Department" : "User",
        },
        targetName: { width: 220, render: (r) => <strong>{r.targetName}</strong> },
        policyName: { width: 200 },
        users: { width: 90, align: "right" },
        createdBy: { width: 140 },
        createdAt: { width: 160, render: (r) => fmtWhen(r.createdAt) },
      }}
      trailing={{
        header: "",
        width: 90,
        render: (r) => (
          <button
            type="button"
            className="link small"
            onClick={(e) => {
              e.stopPropagation();
              remove.mutate(r.id, {
                onSuccess: () => toast({ tone: "good", message: `Removed ${r.policyName} from ${r.targetName}` }),
                onError: fail,
              });
            }}
          >
            Remove
          </button>
        ),
      }}
      shortcuts="Users column: users whose policy comes from this assignment now"
    />
  );
}

// ---------------------------------------------------------------- shares and temporary access

const inDays = (d: number) => new Date(Date.now() + d * 86400_000).toISOString().slice(0, 16);

function GrantDialog({ done }: { done: (v: boolean | null) => void }) {
  const grant = useGrantVisibility();
  const [userId, setUserId] = useState<number | null>(null);
  const [enterpriseId, setEnterpriseId] = useState<number | null>(null);
  const [lasting, setLasting] = useState(false);
  const [until, setUntil] = useState(inDays(7));
  const [reason, setReason] = useState("");
  const ready = userId !== null && enterpriseId !== null && reason.trim() !== "" && (lasting || !!until);
  return (
    <Modal
      title="Grant sight of an enterprise"
      onClose={() => done(null)}
      footer={
        <>
          <Button onClick={() => done(null)}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!ready || grant.isPending}
            onClick={() =>
              grant.mutate(
                {
                  userId: userId!,
                  enterpriseId: enterpriseId!,
                  expiresAt: lasting ? null : new Date(`${until}Z`).toISOString(),
                  reason: reason.trim(),
                },
                {
                  onSuccess: (g) => {
                    toast({ tone: "good", message: `${g.userName} now sees ${g.enterpriseName}` });
                    done(true);
                  },
                  onError: fail,
                },
              )
            }
          >
            Grant
          </Button>
        </>
      }
    >
      <div className="field">
        <span>User</span>
        <ListLookup<{ id: number; displayName: string; username: string }>
          list="users"
          value={userId}
          onChange={(r) => setUserId(r?.id ?? null)}
          labelOf={(r) => `${r.displayName} (${r.username})`}
          placeholder="Choose a user…"
        />
      </div>
      <div className="field">
        <span>Enterprise</span>
        <ListLookup<{ id: number; name: string; accountManagerName: string | null }>
          list="enterprises"
          value={enterpriseId}
          onChange={(r) => setEnterpriseId(r?.id ?? null)}
          labelOf={(r) => `${r.name} (#${r.id})`}
          detailOf={(r) => (r.accountManagerName ? `AM ${r.accountManagerName}` : "")}
          placeholder="Choose an enterprise…"
        />
      </div>
      <div className="segmented small" role="radiogroup" aria-label="Kind">
        <button
          type="button"
          role="radio"
          aria-checked={!lasting}
          className={!lasting ? "on" : ""}
          onClick={() => setLasting(false)}
        >
          Temporary
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={lasting}
          className={lasting ? "on" : ""}
          onClick={() => setLasting(true)}
        >
          Lasting share
        </button>
      </div>
      {!lasting && (
        <label className="field">
          <span>Until (UTC) — expires by itself</span>
          <DateTimeInput value={until} onChange={(e) => setUntil(e.target.value)} />
        </label>
      )}
      <label className="field">
        <span>Reason</span>
        <input
          value={reason}
          maxLength={300}
          placeholder="e.g. covering a colleague on holiday"
          onChange={(e) => setReason(e.target.value)}
        />
      </label>
    </Modal>
  );
}

const STATE_TONE = { active: "good", expired: "neutral", revoked: "neutral" } as const;

function GrantsView() {
  const revoke = useRevokeVisibilityGrant();
  return (
    <ListScreen<VisibilityGrant>
      list="visibility_grants"
      page={page}
      above={<ViewSwitch />}
      noSelection
      historyScope={null}
      primary={{ label: "Grant access", onClick: () => void ask<boolean>((done) => <GrantDialog done={done} />) }}
      rowActions={(r) => [
        {
          label: "Revoke",
          icon: "x",
          danger: true,
          disabled: r.state !== "active" || revoke.isPending,
          hint: r.state === "active" ? `Revoke ${r.userName}'s access to ${r.enterpriseName}` : `Already ${r.state}`,
          onSelect: () =>
            revoke.mutate(r.id, {
              onSuccess: () =>
                toast({ tone: "good", message: `Revoked ${r.userName}'s access to ${r.enterpriseName}` }),
              onError: fail,
            }),
        },
      ]}
      columns={{
        userName: { width: 180, render: (r) => <strong>{r.userName}</strong> },
        enterpriseName: { width: 220 },
        kind: { width: 120, render: (r) => (r.kind === "share" ? "Lasting share" : "Temporary") },
        state: {
          width: 100,
          render: (r) => (
            <span>
              <StatusDot tone={STATE_TONE[r.state]} hollow={r.state !== "active"} />{" "}
              {r.state[0]!.toUpperCase() + r.state.slice(1)}
            </span>
          ),
        },
        expiresAt: { width: 160, render: (r) => (r.expiresAt ? fmtWhen(r.expiresAt) : "—") },
        reason: { width: 240 },
        grantedBy: { width: 130 },
        createdAt: { width: 160, render: (r) => fmtWhen(r.createdAt) },
      }}
      trailing={{
        header: "",
        width: 90,
        render: (r) =>
          r.state === "active" ? (
            <button
              type="button"
              className="link small"
              onClick={(e) => {
                e.stopPropagation();
                revoke.mutate(r.id, {
                  onSuccess: () =>
                    toast({ tone: "good", message: `Revoked ${r.userName}'s access to ${r.enterpriseName}` }),
                  onError: fail,
                });
              }}
            >
              Revoke
            </button>
          ) : null,
      }}
      shortcuts="Temporary access ends at its time by itself · every grant goes to the Audit Trail"
    />
  );
}

export function VisibilityPage() {
  const { view } = useVisNav();
  if (view === "assignments") return <AssignmentsView />;
  if (view === "grants") return <GrantsView />;
  return <PoliciesView />;
}
