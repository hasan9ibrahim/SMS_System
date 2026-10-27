// Shared pieces for monitoring alerts (§13.6): the alert sounds dialog (avatar menu), the severity
// cell, and a picker that keeps a list of record IDs as chips (rule scope, notified users).
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { AlertSoundPrefs, ListId } from "@sms/contract";
import { fetchPickPage, useMe, useUpdatePreferences } from "../../../api/hooks";
import { DEFAULT_SOUNDS } from "../../../live/store";
import { playSound, SOUNDS, type SoundKey } from "../../../live/sounds";
import { ListLookup } from "../../../records/parts";
import { ask, toast } from "../../../ui/feedback";
import { Button, Modal, StatusDot } from "../../../ui/primitives";
import { SEVERITY_LABEL, SEVERITY_TONE } from "./alertsModel";

export const severityCell = (s: "info" | "warning" | "critical") => (
  <span>
    <StatusDot tone={SEVERITY_TONE[s]} /> {SEVERITY_LABEL[s]}
  </span>
);

function AlertSoundsDialog({ done }: { done: () => void }) {
  const { data: me } = useMe();
  const prefs = useUpdatePreferences();
  const [v, setV] = useState<AlertSoundPrefs>(me?.preferences.alertSounds ?? DEFAULT_SOUNDS);
  return (
    <Modal
      title="Alert sounds"
      width={460}
      onClose={done}
      footer={
        <>
          <Button onClick={done}>Cancel</Button>
          <Button
            variant="primary"
            disabled={prefs.isPending}
            onClick={() =>
              prefs.mutate(
                { alertSounds: v },
                { onSuccess: () => (toast({ tone: "good", message: "Alert sounds saved" }), done()) },
              )
            }
          >
            Save
          </Button>
        </>
      }
    >
      <label className="toggle-inline">
        <input type="checkbox" checked={v.mute} onChange={(e) => setV({ ...v, mute: e.target.checked })} />
        Mute alert sounds for me
      </label>
      <div className="sound-grid">
        {(["info", "warning", "critical"] as const).map((sev) => (
          <div key={sev} className="sound-row">
            <span>{severityCell(sev)}</span>
            <select
              aria-label={`${SEVERITY_LABEL[sev]} sound`}
              value={v[sev]}
              disabled={v.mute}
              onChange={(e) => setV({ ...v, [sev]: e.target.value as SoundKey })}
            >
              {SOUNDS.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
                </option>
              ))}
            </select>
            <Button small icon="play" disabled={v.mute || v[sev] === "none"} onClick={() => playSound(v[sev])}>
              Play
            </Button>
          </div>
        ))}
      </div>
    </Modal>
  );
}

export const openAlertSounds = () => ask<void>((d) => <AlertSoundsDialog done={() => d()} />);

/** IDs kept as removable chips, added with a list lookup; names come from the same list. */
export function IdChips({
  list,
  ids,
  onChange,
  placeholder,
  detailOf,
}: {
  list: ListId;
  ids: number[];
  onChange: (ids: number[]) => void;
  placeholder: string;
  detailOf?: (row: { id: number; name?: string }) => string;
}) {
  const names = useQuery({
    queryKey: ["list", "names", list, ids],
    queryFn: () =>
      fetchPickPage<{ id: number; name?: string; displayName?: string }>(list, {
        limit: 500,
        withTotal: false,
        filter: { logic: "and", conditions: [{ field: "id", op: "in", values: ids }] },
      }),
    enabled: ids.length > 0,
    staleTime: 60_000,
  });
  const nameOf = (id: number) => {
    const r = names.data?.rows.find((x) => x.id === id);
    return r?.name ?? r?.displayName ?? `#${id}`;
  };
  return (
    <div className="id-chips">
      {ids.map((id) => (
        <span key={id} className="chip">
          {nameOf(id)}
          <button
            type="button"
            aria-label={`Remove ${nameOf(id)}`}
            onClick={() => onChange(ids.filter((x) => x !== id))}
          >
            ×
          </button>
        </span>
      ))}
      <ListLookup<{ id: number; name?: string; displayName?: string }>
        list={list}
        value={null}
        exclude={ids}
        onChange={(r) => r && onChange([...ids, r.id])}
        labelOf={(r) => r.name ?? r.displayName ?? `#${r.id}`}
        {...(detailOf ? { detailOf } : {})}
        placeholder={placeholder}
      />
    </div>
  );
}
