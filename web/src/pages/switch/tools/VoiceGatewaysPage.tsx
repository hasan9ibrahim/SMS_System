// Voice gateways (§8 SMS To Voice, decided 2026-10-31, docs/SMS_TO_VOICE.md): the operator's own voice switches the
// SMS-to-voice calls go to over SIP. Name, address, caller ID, dial prefix, codecs, limits and priority; the password
// is write-only (shown as stored or not, §13.22). Saves are undoable (§13.10); delete is refused while a rule names
// the gateway (§13.29). Opened with SMS to voice's access.
import { useState } from "react";
import type { VoiceGatewayInput, VoiceGatewayRow } from "@sms/contract";
import { useMe } from "../../../api/hooks";
import { useRestore } from "../../../api/records";
import { useSaveVoiceGateway } from "../../../api/switchTools";
import { FormField, MultiCheck, NumberField, SelectField, TextField, useForm } from "../../../form/form";
import { HistoryList, useNotifySaved } from "../../../history/undo";
import { pageForPath } from "../../../nav/registry";
import { ListScreen } from "../../../page/ListScreen";
import { isAdminUser, useDeleteRecord } from "../../../records/parts";
import { ask, toast } from "../../../ui/feedback";
import { StatusDot } from "../../../ui/primitives";
import { problemText } from "../../routing/dialogs";
import { fmtWhen, RecordActions, RecordDialog } from "../../reference/shared";
import {
  blankVoiceGateway,
  CALLER_ID_MODES,
  codecLabel,
  CODECS,
  gatewayAddress,
  TRANSPORTS,
  voiceGatewayInput,
} from "./toolsModel";

const page = pageForPath("/switch/voice-gateways")!;
const muted = (v: string) => <span className="muted">{v}</span>;

function GatewayDialog({ row, done }: { row: VoiceGatewayRow | null; done: () => void }) {
  const form = useForm<VoiceGatewayInput>(row ? voiceGatewayInput(row) : blankVoiceGateway());
  const save = useSaveVoiceGateway();
  const notifySaved = useNotifySaved();
  const [error, setError] = useState<string | null>(null);
  const v = form.values;
  return (
    <RecordDialog
      form={form}
      title={row ? `Edit voice gateway · ${row.name}` : "Add voice gateway"}
      saveLabel={row ? "Save" : "Add gateway"}
      saving={save.isPending}
      error={error}
      width={680}
      onClose={done}
      onSave={() =>
        save.mutate(
          { id: row?.id ?? null, input: { ...v, name: v.name.trim(), host: v.host.trim() } },
          {
            onSuccess: (r) => {
              if (r.change) notifySaved(r.change, `${row ? "Saved" : "Added"} ${r.record.name}`);
              else toast({ tone: "info", message: "Nothing changed" });
              done();
            },
            onError: (e) => setError(form.fail(e)),
          },
        )
      }
    >
      <TextField form={form} path="name" label="Name" required maxLength={100} nullable={false} />
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
      <TextField
        form={form}
        path="host"
        label="Host"
        required
        maxLength={253}
        nullable={false}
        placeholder="voice-gw.example.net"
      />
      <NumberField form={form} path="port" label="Port" required min={1} max={65535} step={1} />
      <SelectField form={form} path="transport" label="Transport" required options={TRANSPORTS} />
      <TextField form={form} path="fromDomain" label="From Domain" maxLength={253} placeholder="Empty: the host" />
      <TextField form={form} path="username" label="Username" maxLength={100} placeholder="Empty: trusted by address" />
      <FormField
        label="Password"
        hint={row?.passwordSet ? "Stored. Type a new one to replace it." : "Never shown again after saving"}
      >
        <input
          type="password"
          autoComplete="new-password"
          value={v.password ?? ""}
          placeholder={row?.passwordSet ? "•••••••• (unchanged)" : ""}
          onChange={(e) => form.set("password", e.target.value === "" ? null : e.target.value)}
        />
      </FormField>
      <SelectField form={form} path="callerIdMode" label="Caller ID" required options={CALLER_ID_MODES} />
      <TextField
        form={form}
        path="fixedCallerId"
        label="Fixed Caller ID"
        required={v.callerIdMode === "fixed"}
        maxLength={21}
        placeholder="+15550100"
        hint={v.callerIdMode === "sender" ? "When the sender is not a number" : undefined}
      />
      <TextField
        form={form}
        path="dialPrefix"
        label="Dial Prefix"
        maxLength={20}
        nullable={false}
        placeholder="None"
        hint="Put before the receiver number"
      />
      <NumberField
        form={form}
        path="priority"
        label="Priority"
        required
        min={0}
        max={9999}
        step={1}
        hint="Lowest first for rules without a gateway"
      />
      <NumberField
        form={form}
        path="maxCalls"
        label="Max Calls"
        required
        min={1}
        max={1000}
        step={1}
        hint="At once; more wait their turn"
      />
      <NumberField
        form={form}
        path="ringTimeoutS"
        label="Ring Timeout"
        required
        min={5}
        max={120}
        step={1}
        suffix="s"
      />
      <NumberField
        form={form}
        path="retryDelayS"
        label="Retry After"
        required
        min={10}
        max={3600}
        step={10}
        suffix="s"
        hint="One retry when not answered"
      />
      <MultiCheck form={form} path="codecs" label="Codecs" wide options={CODECS} />
    </RecordDialog>
  );
}

const openDialog = (row: VoiceGatewayRow | null) => ask<void>((d) => <GatewayDialog row={row} done={() => d()} />);

export function VoiceGatewaysPage() {
  const { data: me } = useMe();
  const admin = isAdminUser(me?.permissions);
  const deleteOne = useDeleteRecord();
  const restore = useRestore("voice_gateway");
  const notifySaved = useNotifySaved();
  return (
    <ListScreen<VoiceGatewayRow>
      list="voice_gateways"
      noExport
      bulkDelete={{ noun: "voice gateway", restore: true }}
      page={page}
      noSelection
      historyScope={{ entityTypes: ["voice_gateway"] }}
      rowActions={(r) => [
        {
          label: "Edit",
          icon: "file",
          main: true,
          disabled: !!r.archivedAt,
          hint: r.archivedAt ? "Deleted gateways cannot be edited" : undefined,
          onSelect: () => void openDialog(r),
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
                  onSuccess: (x) => x.change && notifySaved(x.change, `Restored ${r.name}`),
                  onError: (e) => toast({ tone: "error", message: problemText(e) }),
                }),
            }
          : {
              label: "Delete…",
              icon: "trash",
              danger: true,
              onSelect: () => void deleteOne("voice_gateway", r.id, `voice gateway ${r.name}`),
            },
      ]}
      primary={{ label: "Add", icon: "plus", onClick: () => void openDialog(null) }}
      columns={{
        id: { width: 80 },
        name: { width: 180 },
        host: { width: 220 },
        port: { width: 90, align: "right", render: (r) => <span className="num">{r.port}</span> },
        transport: { width: 110, render: (r) => r.transport.toUpperCase() },
        callerIdMode: { width: 170, render: (r) => (r.callerIdMode === "fixed" ? "Fixed" : "Sender if numeric") },
        fixedCallerId: {
          width: 150,
          render: (r) => (r.fixedCallerId ? <span className="num">{r.fixedCallerId}</span> : muted("—")),
        },
        dialPrefix: {
          width: 120,
          render: (r) => (r.dialPrefix ? <span className="num">{r.dialPrefix}</span> : muted("none")),
        },
        codecs: { width: 170, render: (r) => r.codecs.map(codecLabel).join(", ") },
        maxCalls: { width: 110, align: "right" },
        priority: { width: 100, align: "right" },
        status: {
          width: 110,
          render: (r) => (
            <span>
              <StatusDot tone={r.status === "active" ? "good" : "neutral"} />{" "}
              {r.status === "active" ? "Active" : "Inactive"}
            </span>
          ),
        },
        rules: { width: 90, align: "right", render: (r) => (r.rules ? r.rules : muted("0")) },
      }}
      rowClass={(r) => (r.status === "inactive" ? "row-muted" : undefined)}
      onOpen={(r) => !r.archivedAt && void openDialog(r)}
      detail={(r) => ({
        title: (
          <>
            <strong>{r.name}</strong>
            <span className="muted">{gatewayAddress(r)}</span>
          </>
        ),
        sections: [
          {
            key: "gateway",
            label: "Gateway",
            actions: (
              <RecordActions
                kind="voice_gateway"
                id={r.id}
                name={`voice gateway ${r.name}`}
                archived={!!r.archivedAt}
                onEdit={() => void openDialog(r)}
              />
            ),
            content: (
              <dl className="kv">
                <dt>Address</dt>
                <dd>
                  {gatewayAddress(r)}
                  {r.fromDomain ? <span className="muted"> · from {r.fromDomain}</span> : null}
                </dd>
                <dt>Sign-in</dt>
                <dd>
                  {r.username ?? muted("no user (trusted by address)")} · password{" "}
                  {r.passwordSet ? "stored" : muted("none")}
                </dd>
                <dt>Caller ID</dt>
                <dd>
                  {r.callerIdMode === "fixed"
                    ? `always ${r.fixedCallerId ?? "—"}`
                    : `the sender when it is a number, else ${r.fixedCallerId ?? "withheld"}`}
                </dd>
                <dt>Dialling</dt>
                <dd>
                  {r.dialPrefix ? `${r.dialPrefix} + the receiver number` : "the receiver number as it is"} ·{" "}
                  {r.codecs.map(codecLabel).join(", ")}
                </dd>
                <dt>Calls</dt>
                <dd>
                  up to {r.maxCalls} at once · rings {r.ringTimeoutS} s · one retry after {r.retryDelayS} s
                </dd>
                <dt>Priority</dt>
                <dd>
                  {r.priority}{" "}
                  <span className="muted">· rules without a gateway use the active one with the lowest</span>
                </dd>
                <dt>Used by</dt>
                <dd>
                  {r.rules} SMS to voice rule{r.rules === 1 ? "" : "s"}
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
            content: <HistoryList scope={{ entityTypes: ["voice_gateway"], entityId: r.id }} />,
          },
        ],
      })}
      shortcuts="↑↓ move · Enter edits · Ctrl+Z undo"
    />
  );
}
