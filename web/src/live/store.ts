// Live data for the shell: the TPS pill (live:tps, §15.1) and incidents for the bell,
// pop-up cards and tab alert dots (alerts:<userId>, §13.6). One socket per browser:
// the main window owns it and relays frames to pop-out windows over the shell channel.
import { create } from "zustand";
import type { IncidentEvent, TpsTickEvent } from "@sms/contract";
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
  dismissPopup: (id: number) => void;
  acknowledge: (id: number) => void;
  markAllSeen: () => void;
}

export const useLive = create<LiveState>((set, get) => ({
  connected: false,
  totalTps: null,
  tpsAt: null,
  incidents: [],
  popups: [],
  seen: new Set(),
  dismissPopup: (id) => set({ popups: get().popups.filter((p) => p !== id) }),
  // Local until the incidents API exists (Alert rules / Incidents, build step 5).
  acknowledge: (id) =>
    set({
      incidents: get().incidents.map((i) =>
        i.incidentId === id ? { ...i, state: "acknowledged", acknowledgedBy: "you" } : i,
      ),
      popups: get().popups.filter((p) => p !== id),
    }),
  markAllSeen: () => set({ seen: new Set(get().incidents.map((i) => i.incidentId)) }),
}));

export const openIncidents = (s: Pick<LiveState, "incidents">) => s.incidents.filter((i) => i.state !== "recovered");

function onTick(payload: TpsTickEvent) {
  useLive.setState({ totalTps: payload.totalTps, tpsAt: payload.at });
}

function onIncident(payload: IncidentEvent) {
  const { incidents, popups } = useLive.getState();
  const others = incidents.filter((i) => i.incidentId !== payload.incidentId);
  const isNew = others.length === incidents.length;
  useLive.setState({
    incidents: [payload, ...others].slice(0, 100),
    popups:
      payload.state === "open" && isNew
        ? [...popups, payload.incidentId].slice(-3)
        : popups.filter((p) => p !== payload.incidentId),
  });
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
  return () => {
    offTps();
    offAlerts();
    offHello();
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
