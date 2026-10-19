// Live data for the shell: the TPS pill (live:tps, §15.1) and incidents for the bell,
// pop-up cards, sounds and tab alert dots (alerts:<userId>, §13.6). The open incidents are read
// from the API at start; changes arrive on the socket. One socket per browser: the main window
// owns it and relays frames to pop-out windows over the shell channel.
import { create } from "zustand";
import type { AlertSoundPrefs, IncidentEvent, IncidentRow, IncidentSnoozeInput, TpsTickEvent } from "@sms/contract";
import { acknowledgeIncident, fetchOpenIncidents, snoozeIncident } from "../api/alerts";
import { toast } from "../ui/feedback";
import { playSound } from "./sounds";
import { channel } from "../shell/channel";
import { LiveSocket, socketUrl, type PhxFrame } from "./socket";

interface LiveState {
  connected: boolean;
  totalTps: number | null;
  tpsAt: string | null;
  incidents: IncidentEvent[];
  /** Incidents shown as pop-up cards (not yet dismissed or snoozed). */
  popups: number[];
  seen: Set<number>;
  sounds: AlertSoundPrefs;
  dismissPopup: (id: number) => void;
  acknowledge: (id: number) => Promise<void>;
  snooze: (id: number, span: IncidentSnoozeInput["for"]) => Promise<void>;
  markAllSeen: () => void;
}

export const DEFAULT_SOUNDS: AlertSoundPrefs = { mute: false, info: "ping", warning: "chime", critical: "siren" };

/** An incident from the API as the shell keeps it (channels come with live events). */
export function eventFromRow(i: IncidentRow): IncidentEvent {
  return {
    incidentId: i.id,
    ruleId: i.ruleId,
    ruleName: i.ruleName,
    state: i.state,
    severity: i.severity,
    message: i.message,
    metric: i.metric,
    currentValue: i.currentValue,
    baselineValue: i.baselineValue,
    peakValue: i.peakValue,
    scope: [],
    entityName: i.entityName,
    startedAt: i.startedAt,
    endedAt: i.endedAt,
    acknowledgedBy: i.acknowledgedBy,
    acknowledgedAt: i.acknowledgedAt,
    snoozedUntil: i.snoozedUntil,
    channels: [],
    repeat: false,
  };
}

const snoozed = (i: Pick<IncidentEvent, "snoozedUntil">, now = Date.now()) =>
  !!i.snoozedUntil && Date.parse(i.snoozedUntil) > now;

function apply(updated: IncidentEvent) {
  const { incidents } = useLive.getState();
  useLive.setState({
    incidents: [updated, ...incidents.filter((i) => i.incidentId !== updated.incidentId)].slice(0, 100),
  });
}

export const useLive = create<LiveState>((set, get) => ({
  connected: false,
  totalTps: null,
  tpsAt: null,
  incidents: [],
  popups: [],
  seen: new Set(),
  sounds: DEFAULT_SOUNDS,
  dismissPopup: (id) => set({ popups: get().popups.filter((p) => p !== id) }),
  acknowledge: async (id) => {
    try {
      const r = await acknowledgeIncident(id);
      const cur = get().incidents.find((i) => i.incidentId === id);
      if (cur) apply({ ...cur, state: r.state, acknowledgedBy: r.acknowledgedBy, acknowledgedAt: r.acknowledgedAt });
      set({ popups: get().popups.filter((p) => p !== id) });
    } catch (e) {
      toast({ tone: "error", message: e instanceof Error ? e.message : String(e) });
    }
  },
  snooze: async (id, span) => {
    try {
      const r = await snoozeIncident(id, span);
      const cur = get().incidents.find((i) => i.incidentId === id);
      if (cur) apply({ ...cur, snoozedUntil: r.snoozedUntil });
      set({ popups: get().popups.filter((p) => p !== id) });
    } catch (e) {
      toast({ tone: "error", message: e instanceof Error ? e.message : String(e) });
    }
  },
  markAllSeen: () => set({ seen: new Set(get().incidents.map((i) => i.incidentId)) }),
}));

export const openIncidents = (s: Pick<LiveState, "incidents">) => s.incidents.filter((i) => i.state !== "recovered");

function onTick(payload: TpsTickEvent) {
  useLive.setState({ totalTps: payload.totalTps, tpsAt: payload.at });
}

function onIncident(payload: IncidentEvent) {
  const { incidents, popups, sounds } = useLive.getState();
  const isNew = !incidents.some((i) => i.incidentId === payload.incidentId);
  const alerting = payload.state === "open" && (isNew || payload.repeat) && !snoozed(payload);
  apply(payload);
  const card = alerting && payload.channels.includes("popup");
  useLive.setState({
    popups: card
      ? [...popups.filter((p) => p !== payload.incidentId), payload.incidentId].slice(-3)
      : payload.state === "open"
        ? popups
        : popups.filter((p) => p !== payload.incidentId),
  });
  if (alerting && payload.channels.includes("sound") && !sounds.mute) playSound(sounds[payload.severity]);
  // Recovery notice (§13.6): a short OK message.
  if (payload.state === "recovered" && !isNew && payload.channels.includes("popup"))
    toast({ tone: "good", message: `OK – ${payload.entityName}: ${payload.ruleName} is back to normal` });
}

/** Critical repeats its sound until acknowledged (§13.6). */
function criticalRepeat() {
  const { incidents, popups, sounds } = useLive.getState();
  if (sounds.mute) return;
  const ringing = incidents.some(
    (i) =>
      i.severity === "critical" &&
      i.state === "open" &&
      popups.includes(i.incidentId) &&
      i.channels.includes("sound") &&
      !snoozed(i),
  );
  if (ringing) playSound(sounds.critical);
}

/** The open incidents for the bell at start (the socket only carries changes). */
async function loadOpen() {
  try {
    const r = await fetchOpenIncidents();
    const live = useLive.getState().incidents;
    const known = new Set(live.map((i) => i.incidentId));
    useLive.setState({
      incidents: [...live, ...r.incidents.filter((i) => !known.has(i.id)).map(eventFromRow)].slice(0, 100),
    });
  } catch {
    // The mock is not reachable yet; the socket fills the bell as incidents arrive.
  }
}

let socket: LiveSocket | null = null;

/** Main window: open the socket and relay every frame to pop-out windows. */
export function startLive(userId: number): () => void {
  socket = new LiveSocket(socketUrl());
  socket.onStatus = (connected) => useLive.setState({ connected });
  socket.onFrame = (frame) => channel.post({ type: "live", frame });
  const offTps = socket.subscribe(
    "live:tps",
    (event, payload) => event === "tick" && onTick(payload as unknown as TpsTickEvent),
  );
  const offAlerts = socket.subscribe(
    `alerts:${userId}`,
    (event, payload) => event === "incident" && onIncident(payload as unknown as IncidentEvent),
  );
  const offHello = channel.on((m) => m.type === "live-hello" && channel.post({ type: "live-owner" }));
  socket.connect();
  void loadOpen();
  const ring = setInterval(criticalRepeat, 15_000);
  return () => {
    offTps();
    offAlerts();
    offHello();
    clearInterval(ring);
    socket?.close();
  };
}

/** Pop-out window: use the main window's feed; open an own socket only if none answers. */
export function startLiveRelay(userId: number): () => void {
  let owner = false;
  const relay = new LiveSocket(socketUrl());
  relay.subscribe("live:tps", (event, payload) => event === "tick" && onTick(payload as unknown as TpsTickEvent));
  relay.subscribe(
    `alerts:${userId}`,
    (event, payload) => event === "incident" && onIncident(payload as unknown as IncidentEvent),
  );
  const off = channel.on((m) => {
    if (m.type === "live-owner") {
      owner = true;
      useLive.setState({ connected: true });
    }
    if (m.type === "live") {
      owner = true;
      useLive.setState({ connected: true });
      relay.dispatch(m.frame as PhxFrame);
    }
  });
  channel.post({ type: "live-hello" });
  const fallback = setTimeout(() => {
    if (!owner) {
      relay.onStatus = (connected) => useLive.setState({ connected });
      relay.connect();
    }
  }, 2000);
  return () => {
    off();
    clearTimeout(fallback);
    relay.close();
  };
}
