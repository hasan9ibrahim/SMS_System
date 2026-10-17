// SMS To Voice (§8): SmsVoiceID, Sender ID, Receiver ID, Prefix, Repeat, Destination, Updated By,
// Action. Matching SMS (e.g. OTP to landlines) become a voice call that reads the text out; the
// test box shows which rule a message meets. Saves are undoable (§13.10).
import { useState } from "react";
import type { Destination, SmsVoiceRuleInput, SmsVoiceRuleRow, SmsVoiceTestResult } from "@sms/contract";
import { testSmsVoice, useSaveSmsVoiceRule } from "../../../api/switchTools";
import { FormField, NumberField, SelectField, TextField, useForm } from "../../../form/form";
import { HistoryList, useNotifySaved } from "../../../history/undo";
import { pageForPath } from "../../../nav/registry";
import { ListScreen } from "../../../page/ListScreen";
import { ListLookup } from "../../../records/parts";
import { ask, toast } from "../../../ui/feedback";
import { Button, StatusDot } from "../../../ui/primitives";
import { problemText } from "../../routing/dialogs";
import { fmtWhen, RecordActions, RecordDialog } from "../../reference/shared";
import { blankVoiceRule } from "./toolsModel";

const page = pageForPath("/switch/sms-to-voice")!;
const muted = (v: string) => <span className="muted">{v}</span>;

function VoiceDialog({ row, done }: { row: SmsVoiceRuleRow | null; done: () => void }) {
  const form = useForm<SmsVoiceRuleInput>(
    row
      ? {
          senderId: row.senderId,
          receiverId: row.receiverId,
          prefix: row.prefix,
          repeat: row.repeat,
          mccmnc: row.mccmnc,
          status: row.status,
        }
      : blankVoiceRule(),
  );
  const save = useSaveSmsVoiceRule();
  const notifySaved = useNotifySaved();
  const [error, setError] = useState<string | null>(null);
  const v = form.values;
  return (
    <RecordDialog
      title={row ? `Edit SMS to voice rule ${row.id}` : "Add SMS to voice rule"}
      saveLabel={row ? "Save" : "Add rule"}
      saving={save.isPending}
      error={error}
      onClose={done}
      onSave={() =>
        save.mutate(
          { id: row?.id ?? null, input: v },
          {
            onSuccess: (r) => {
              if (r.change) notifySaved(r.change, `Saved SMS to voice rule ${r.record.id}`);
              done();
            },
            onError: (e) => setError(form.fail(e)),
          },
        )
      }
    >
      <TextField form={form} path="senderId" label="Sender ID" maxLength={32} placeholder="Any; % and _ wildcards" />
      <TextField
        form={form}
        path="receiverId"
        label="Receiver ID"
        maxLength={32}
        placeholder="Any; % and _ wildcards"
      />
      <TextField form={form} path="prefix" label="Prefix" maxLength={15} placeholder="e.g. 4420 (London landlines)" />
      <NumberField
        form={form}
        path="repeat"
        label="Repeat"
        required
        min={1}
        max={5}
        step={1}
        hint="Times the call reads the text"
      />
      <FormField label="Destination" error={form.error("mccmnc")}>
        <ListLookup<Destination>
          list="destinations"
          value={null}
          onChange={(d) => form.set("mccmnc", d?.mccmnc ?? null)}
          labelOf={(d) => `${d.mccmnc} · ${d.country}`}
          detailOf={(d) => d.network ?? "All networks"}
          placeholder={v.mccmnc ?? "Any destination"}
        />
      </FormField>
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
    </RecordDialog>
  );
}

const openDialog = (row: SmsVoiceRuleRow | null) => ask<void>((d) => <VoiceDialog row={row} done={() => d()} />);

function TestBox() {
  const [sender, setSender] = useState("MYOTP");
  const [receiver, setReceiver] = useState("+442071234567");
  const [text, setText] = useState("Your code is 482913");
  const [res, setRes] = useState<SmsVoiceTestResult | null>(null);
  const run = () =>
    void testSmsVoice({ senderId: sender, receiver, text })
      .then(setRes)
      .catch((e) => toast({ tone: "error", message: problemText(e) }));
  return (
    <div className="voice-test">
      <input
        value={sender}
        aria-label="Sender ID"
        placeholder="Sender ID"
        onChange={(e) => setSender(e.target.value)}
      />
      <input
        value={receiver}
        aria-label="Receiver"
        placeholder="Receiver"
        onChange={(e) => setReceiver(e.target.value)}
      />
      <input value={text} aria-label="Text" placeholder="Message text" onChange={(e) => setText(e.target.value)} />
      <Button small icon="play" onClick={run}>
        Test
      </Button>
      {res && (
        <span className="small">
          <StatusDot tone={res.matched ? "accent" : "neutral"} /> {res.reason}
          {res.spoken && <span className="muted"> · reads: “{res.spoken}”</span>}
        </span>
      )}
    </div>
  );
}

export function SmsToVoicePage() {
  return (
    <ListScreen<SmsVoiceRuleRow>
      list="sms_voice_rules"
      page={page}
      noSelection
      historyScope={{ entityTypes: ["sms_voice_rule"] }}
      above={<TestBox />}
      primary={{ label: "Add", icon: "plus", onClick: () => void openDialog(null) }}
      columns={{
        id: { width: 110 },
        senderId: { width: 170, render: (r) => r.senderId ?? muted("any") },
        receiverId: { width: 170, render: (r) => r.receiverId ?? muted("any") },
        prefix: { width: 140, render: (r) => (r.prefix ? <span className="num">{r.prefix}</span> : muted("any")) },
        repeat: { width: 90, align: "right" },
        destination: { width: 220, render: (r) => r.destination ?? (r.mccmnc ? r.mccmnc : muted("any")) },
        status: {
          width: 100,
          render: (r) => (
            <span>
              <StatusDot tone={r.status === "active" ? "good" : "neutral"} />{" "}
              {r.status === "active" ? "Active" : "Inactive"}
            </span>
          ),
        },
        updatedBy: { width: 140, render: (r) => r.updatedBy ?? muted("—") },
      }}
      rowClass={(r) => (r.status === "inactive" ? "row-muted" : undefined)}
      onOpen={(r) => !r.archivedAt && void openDialog(r)}
      detail={(r) => ({
        title: (
          <>
            <strong>Rule {r.id}</strong>
            <span className="muted">
              {r.senderId ?? "any sender"} → {r.prefix ? `${r.prefix}…` : "any number"}
            </span>
          </>
        ),
        sections: [
          {
            key: "rule",
            label: "Rule",
            actions: (
              <RecordActions
                kind="sms_voice_rule"
                id={r.id}
                name={`SMS to voice rule ${r.id}`}
                archived={!!r.archivedAt}
                onEdit={() => void openDialog(r)}
              />
            ),
            content: (
              <dl className="kv">
                <dt>Matches</dt>
                <dd>
                  sender {r.senderId ?? "any"} · receiver {r.receiverId ?? "any"}
                  {r.prefix ? ` starting ${r.prefix}` : ""} · {r.destination ?? "any destination"}
                </dd>
                <dt>Call</dt>
                <dd>
                  reads the text {r.repeat} time{r.repeat === 1 ? "" : "s"}, digits one by one
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
            content: <HistoryList scope={{ entityTypes: ["sms_voice_rule"], entityId: r.id }} />,
          },
        ],
      })}
      shortcuts="↑↓ move · Enter edits · Ctrl+Z undo"
    />
  );
}
