// Phoenix Channels V2 client (contract/events/phoenix-message.json): the same code talks to
// the mock now and to the Phoenix backend later (CLAUDE.md rule 5).
// Frame: [join_ref, ref, topic, event, payload]; heartbeat every 30 s; reconnect with backoff.
// The server answers every heartbeat, so a connection silent for STALL_MS has stalled without closing (a dropped
// network or a sleeping laptop): it is dropped and reconnected instead of showing frozen numbers as live.
export type PhxFrame = [string | null, string | null, string, string, Record<string, unknown>];
type Handler = (event: string, payload: Record<string, unknown>) => void;

const HEARTBEAT_MS = 30_000;
const STALL_MS = 75_000;

export class LiveSocket {
  private ws: WebSocket | null = null;
  private ref = 0;
  private topics = new Map<
    string,
    { joinRef: string | null; handlers: Set<Handler>; params: Record<string, unknown> }
  >();
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private retry = 0;
  private closed = false;
  private lastFrameAt = 0;
  onFrame: ((frame: PhxFrame) => void) | null = null;
  /** `refused`: the server closed it as not signed in (4401), so retrying alone does not help. */
  onStatus: ((connected: boolean, refused?: boolean) => void) | null = null;

  constructor(private readonly url: string) {}

  connect() {
    this.closed = false;
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.lastFrameAt = Date.now();
      this.onStatus?.(true);
      for (const topic of this.topics.keys()) this.join(topic);
      this.heartbeat = setInterval(() => {
        if (Date.now() - this.lastFrameAt > STALL_MS) return this.lost(ws, 1006, true);
        this.send([null, this.nextRef(), "phoenix", "heartbeat", {}]);
      }, HEARTBEAT_MS);
    };
    ws.onmessage = (e) => {
      this.lastFrameAt = Date.now();
      let frame: PhxFrame;
      try {
        frame = JSON.parse(String(e.data)) as PhxFrame;
      } catch {
        return;
      }
      this.onFrame?.(frame);
      this.dispatch(frame);
    };
    ws.onclose = (e) => this.lost(ws, e.code, false);
  }

  /** The connection ended (or stalled): report it and reconnect with backoff, unless closed on purpose. */
  private lost(ws: WebSocket, code: number, stalled: boolean) {
    if (ws !== this.ws) return;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    if (stalled) {
      // A stalled close handshake can take minutes to finish; stop listening to it and start a new connection now.
      ws.onclose = ws.onmessage = null;
      ws.close();
    }
    this.ws = null;
    this.onStatus?.(false, code === 4401);
    if (this.closed) return;
    const delay = Math.min(30_000, 1000 * 2 ** this.retry++);
    setTimeout(() => !this.closed && this.connect(), delay);
  }

  /** Delivers a frame received some other way (relayed from the main window). */
  dispatch(frame: PhxFrame) {
    const [, , topic, event, payload] = frame;
    if (event === "phx_reply" || topic === "phoenix") return;
    for (const h of this.topics.get(topic)?.handlers ?? []) h(event, payload);
  }

  /** Joins `topic` on first use; `params` is the phx_join payload (contract/events catalog "joins"). */
  subscribe(topic: string, handler: Handler, params: Record<string, unknown> = {}): () => void {
    let entry = this.topics.get(topic);
    if (!entry) {
      entry = { joinRef: null, handlers: new Set(), params };
      this.topics.set(topic, entry);
      if (this.ws?.readyState === WebSocket.OPEN) this.join(topic);
    }
    entry.handlers.add(handler);
    return () => entry!.handlers.delete(handler);
  }

  close() {
    this.closed = true;
    this.ws?.close();
  }

  private join(topic: string) {
    const ref = this.nextRef();
    this.topics.get(topic)!.joinRef = ref;
    this.send([ref, ref, topic, "phx_join", this.topics.get(topic)!.params]);
  }

  private send(frame: PhxFrame) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(frame));
  }

  private nextRef() {
    return String(++this.ref);
  }
}

export function socketUrl(): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/socket/websocket?vsn=2.0.0`;
}
