// SMS To Voice (§8, decided 2026-10-31, docs/SMS_TO_VOICE.md): SmsVoiceID, Sender ID, Receiver ID, Prefix, Repeat,
// Destination, Gateway, Recording, Updated By, Action. A matching message with a 4 to 8 digit code is a phone call
// through a voice gateway that says "Your verification code is 4, 8, 2, 9." (or plays the rule's own recording, then
// the digits). The test box shows what the switch would do. Saves are undoable (§13.10), the recording too.
import { useEffect, useRef, useState } from "react";
import type {
  Destination,
  SmsVoiceCall,
  SmsVoiceRuleInput,
  SmsVoiceRuleRow,
  SmsVoiceTestResult,
  VoiceGatewayRow,
} from "@sms/contract";
import { useMe } from "../../../api/hooks";
import { useRestore } from "../../../api/records";
import { previewVoiceRecording, testSmsVoice, useSaveSmsVoiceRule, voiceRecordingUrl } from "../../../api/switchTools";
import { FormField, NumberField, SelectField, TextField, useForm } from "../../../form/form";
import { HistoryList, useNotifySaved } from "../../../history/undo";
import { pageForPath } from "../../../nav/registry";
import { ListScreen } from "../../../page/ListScreen";
import { isAdminUser, ListLookup, useDeleteRecord } from "../../../records/parts";
import { ask, toast } from "../../../ui/feedback";
import { Button, StatusDot } from "../../../ui/primitives";
import { problemText } from "../../routing/dialogs";
import { fmtWhen, RecordActions, RecordDialog } from "../../reference/shared";
import {
  blankVoiceRule,
  fmtDurationMs,
  MAX_RECORDING_UPLOAD,
  repeatText,
  toBase64,
  voiceRuleInput,
} from "./toolsModel";

const page = pageForPath("/switch/sms-to-voice")!;
const muted = (v: string) => <span className="muted">{v}</span>;
const DEFAULT_PHRASE = "“Your verification code is …” then the digits";

// ---------------------------------------------------------------- recording

/**
 * What the form does with the rule's recording on Save: keep the stored one, store a new upload (already converted
 * by the server, so what is played here is what callers hear), or go back to the default phrase.
 */
type RecordingChoice =
  | { kind: "keep" }
  | { kind: "default" }
  | { kind: "new"; name: string; contentBase64: string; url: string; durationMs: number };

/** The recording part of the rule's input: left out to keep it, null for the default phrase, or the new file. */
const recordingPart = (c: RecordingChoice, stored: boolean): Pick<SmsVoiceRuleInput, "recording"> =>
  c.kind === "new"
    ? { recording: { name: c.name, contentBase64: c.contentBase64 } }
    : c.kind === "default" && stored
      ? { recording: null }
      : {};

function RecordingField({
  row,
  choice,
  setChoice,
}: {
  row: SmsVoiceRuleRow | null;
  choice: RecordingChoice;
  setChoice: (c: RecordingChoice) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The object URL of a new upload is released when it is replaced or the dialog closes.
  useEffect(() => () => void (choice.kind === "new" && URL.revokeObjectURL(choice.url)), [choice]);
  const stored = row?.recording ?? null;
  const pick = async (file: File) => {
    setError(null);
    if (file.size > MAX_RECORDING_UPLOAD)
      return setError("The file is larger than 10 MB. Shorten it, or save it as mono 16-bit PCM.");
    setBusy(true);
    try {
      const upload = { name: file.name, contentBase64: toBase64(new Uint8Array(await file.arrayBuffer())) };
      const converted = await previewVoiceRecording(upload);
      const bytes = new Uint8Array(await converted.arrayBuffer());
      setChoice({
        kind: "new",
        name: file.name,
        contentBase64: toBase64(bytes),
        url: URL.createObjectURL(converted),
        durationMs: Math.round(((bytes.length - 44) / 16000) * 1000),
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : problemText(e));
    } finally {
      setBusy(false);
    }
  };
  const showing = choice.kind === "new" ? "new" : choice.kind === "keep" && stored ? "stored" : "default";
  return (
    <FormField
      label="Recording"
      wide
      error={error ?? undefined}
      hint="Any WAV (PCM, mono or stereo), up to about a minute. Callers hear it in place of the default words, then the digits."
    >
      <div className="voice-recording">
        {showing === "default" && <span className="muted">Default phrase: {DEFAULT_PHRASE}</span>}
        {showing === "stored" && stored && (
          <>
            <span className="voice-recording-name">
              {stored.name} <span className="muted">· {fmtDurationMs(stored.durationMs)}</span>
            </span>
            <audio controls preload="none" src={voiceRecordingUrl(row!.id)} aria-label={`Play ${stored.name}`} />
          </>
        )}
        {choice.kind === "new" && (
          <>
            <span className="voice-recording-name">
              {choice.name} <span className="muted">· {fmtDurationMs(choice.durationMs)} · kept when you save</span>
            </span>
            <audio controls src={choice.url} aria-label={`Play ${choice.name}`} />
          </>
        )}
        <span className="voice-recording-actions">
          <Button small icon="upload" disabled={busy} onClick={() => fileRef.current?.click()}>
            {busy ? "Converting…" : showing === "default" ? "Upload WAV…" : "Replace…"}
          </Button>
          {showing !== "default" && (
            <Button small icon="x" disabled={busy} onClick={() => setChoice({ kind: "default" })}>
              Remove
            </Button>
          )}
          {choice.kind !== "keep" && stored && (
            <Button small icon="undo" disabled={busy} onClick={() => setChoice({ kind: "keep" })}>
              Keep {stored.name}
            </Button>
          )}
        </span>
        <input
          ref={fileRef}
          type="file"
          accept=".wav,audio/wav,audio/x-wav,audio/wave"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) void pick(f);
          }}
        />
      </div>
    </FormField>
  );
}

// ---------------------------------------------------------------- rule form

function VoiceDialog({ row, done }: { row: SmsVoiceRuleRow | null; done: () => void }) {
  const form = useForm<SmsVoiceRuleInput>(row ? voiceRuleInput(row) : blankVoiceRule());
  const [recording, setRecording] = useState<RecordingChoice>({ kind: "keep" });
  const save = useSaveSmsVoiceRule();
  const notifySaved = useNotifySaved();
  const [error, setError] = useState<string | null>(null);
  const v = form.values;
  return (
    <RecordDialog
      form={form}
      title={row ? `Edit SMS to voice rule ${row.id}` : "Add SMS to voice rule"}
      saveLabel={row ? "Save" : "Add rule"}
      saving={save.isPending}
      error={error}
      width={620}
      onClose={done}
      onSave={() =>
        save.mutate(
          { id: row?.id ?? null, input: { ...v, ...recordingPart(recording, !!row?.recording) } },
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
      <FormField label="Gateway" error={form.error("gatewayId")} hint="Default: the first active gateway">
        <ListLookup<VoiceGatewayRow>
          list="voice_gateways"
          value={v.gatewayId}
          onChange={(g) => form.set("gatewayId", g?.id ?? null)}
          labelOf={(g) => g.name}
          detailOf={(g) => `${g.host} · priority ${g.priority}${g.status === "active" ? "" : " · inactive"}`}
          placeholder="Default gateway"
        />
      </FormField>
      <NumberField
        form={form}
        path="repeat"
        label="Repeat"
        required
        min={1}
        max={5}
        step={1}
        hint="Times the call says the code"
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
      <RecordingField row={row} choice={recording} setChoice={setRecording} />
    </RecordDialog>
  );
}

const openDialog = (row: SmsVoiceRuleRow | null) => ask<void>((d) => <VoiceDialog row={row} done={() => d()} />);

// ---------------------------------------------------------------- test box

function CallResult({ call }: { call: SmsVoiceCall }) {
  return (
    <dl className="voice-result-call">
      <dt>Gateway</dt>
      <dd>
        {call.gateway}
        {call.gatewayDefault && <span className="muted"> · default gateway</span>}
      </dd>
      <dt>Dials</dt>
      <dd className="num">{call.dialled}</dd>
      <dt>Caller ID</dt>
      <dd className="num">{call.callerId ?? muted("withheld")}</dd>
      <dt>Code</dt>
      <dd className="num">{call.code}</dd>
      <dt>Says</dt>
      <dd className="voice-result-wide">
        {call.prompt === "recording" ? call.phrase : `“${call.phrase}”`}{" "}
        <span className="muted">· {repeatText(call.repeat)}</span>
      </dd>
      <dt>No answer</dt>
      <dd className="voice-result-wide">
        rings {call.ringTimeoutS} s, one retry after {call.retryDelayS} s, then not delivered and not charged
      </dd>
    </dl>
  );
}

function TestBox() {
  const [sender, setSender] = useState("MYOTP");
  const [receiver, setReceiver] = useState("+442079460123");
  const [text, setText] = useState("Your code is 482913");
  const [res, setRes] = useState<SmsVoiceTestResult | null>(null);
  const run = () =>
    void testSmsVoice({ senderId: sender, receiver, text })
      .then(setRes)
      .catch((e) => toast({ tone: "error", message: problemText(e) }));
  return (
    <div className="voice-test-box">
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
      </div>
      {res && (
        <div className="voice-result" role="status">
          <p className="voice-result-head">
            <strong>{res.outcome === "call" ? "Phone call" : "Sent as SMS"}</strong>
            <span className="muted">
              {" "}
              · {res.reason}
              {res.mccmnc ? ` · destination ${res.mccmnc}` : ""}
            </span>
          </p>
          {res.call && <CallResult call={res.call} />}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- page

export function SmsToVoicePage() {
  const { data: me } = useMe();
  const admin = isAdminUser(me?.permissions);
  const deleteOne = useDeleteRecord();
  const restore = useRestore("sms_voice_rule");
  const notifySaved = useNotifySaved();
  return (
    <ListScreen<SmsVoiceRuleRow>
      list="sms_voice_rules"
      noExport
      bulkDelete={{ noun: "SMS to voice rule", restore: true }}
      page={page}
      noSelection
      historyScope={{ entityTypes: ["sms_voice_rule"] }}
      rowActions={(r) => [
        {
          label: "Edit",
          icon: "file",
          main: true,
          disabled: !!r.archivedAt,
          hint: r.archivedAt ? "Deleted rules cannot be edited" : undefined,
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
                  onSuccess: (x) => x.change && notifySaved(x.change, `Restored SMS to voice rule ${r.id}`),
                  onError: (e) => toast({ tone: "error", message: problemText(e) }),
                }),
            }
          : {
              label: "Delete…",
              icon: "trash",
              danger: true,
              onSelect: () => void deleteOne("sms_voice_rule", r.id, `SMS to voice rule ${r.id}`),
            },
      ]}
      above={<TestBox />}
      primary={{ label: "Add", icon: "plus", onClick: () => void openDialog(null) }}
      columns={{
        id: { width: 110 },
        senderId: { width: 170, render: (r) => r.senderId ?? muted("any") },
        receiverId: { width: 170, render: (r) => r.receiverId ?? muted("any") },
        prefix: { width: 140, render: (r) => (r.prefix ? <span className="num">{r.prefix}</span> : muted("any")) },
        repeat: { width: 90, align: "right" },
        destination: { width: 220, render: (r) => r.destination ?? (r.mccmnc ? r.mccmnc : muted("any")) },
        gateway: { width: 160, render: (r) => r.gateway ?? muted("Default") },
        recording: { width: 180, render: (r) => r.recording?.name ?? muted("Default") },
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
                  through {r.gateway ?? "the default gateway"} · the code {repeatText(r.repeat)}
                </dd>
                <dt>Recording</dt>
                <dd>
                  {r.recording ? (
                    <span className="voice-recording">
                      <span>
                        {r.recording.name} <span className="muted">· {fmtDurationMs(r.recording.durationMs)}</span>
                      </span>
                      <audio
                        key={r.recording.sha256}
                        controls
                        preload="none"
                        src={voiceRecordingUrl(r.id)}
                        aria-label={`Play ${r.recording.name}`}
                      />
                    </span>
                  ) : (
                    <>Default phrase {muted(DEFAULT_PHRASE)}</>
                  )}
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
