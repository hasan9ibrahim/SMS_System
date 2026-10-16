// Phoenix Channels V2 client (contract/events/phoenix-message.json): the same code talks to
// the mock now and to the Phoenix backend later (CLAUDE.md rule 5).
// Frame: [join_ref, ref, topic, event, payload]; heartbeat every 30 s; reconnect with backoff.
export type PhxFrame = [string | null, string | null, string, string, Record<string, unknown>];
type Handler = (event: string, payload: Record<string, unknown>) => void;

export class LiveSocket {
  private ws: WebSocket | null = null;
  private ref = 0;
  private topics = new Map<string, { joinRef: string | null; handlers: Set<Handler> }>();
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private retry = 0;
  private closed = false;
  onFrame: ((frame: PhxFrame) => void) | null = null;
  onStatus: ((connected: boolean) => void) | null = null;

  constructor(private readonly url: string) {}

  connect() {
    this.closed = false;
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.onStatus?.(true);
      for (const topic of this.topics.keys()) this.join(topic);
      this.heartbeat = setInterval(() => this.send([null, this.nextRef(), "phoenix", "heartbeat", {}]), 30_000);
    };
    ws.onmessage = (e) => {
      let frame: PhxFrame;
      try {
        frame = JSON.parse(String(e.data)) as PhxFrame;
      } catch {
        return;
      }
      this.onFrame?.(frame);
      this.dispatch(frame);
    };
    ws.onclose = () => {
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.onStatus?.(false);
      if (this.closed) return;
      const delay = Math.min(30_000, 1000 * 2 ** this.retry++);
      setTimeout(() => !this.closed && this.connect(), delay);
    };
  }

  /** Delivers a frame received some other way (relayed from the main window). */
  dispatch(frame: PhxFrame) {
    const [, , topic, event, payload] = frame;
    if (event === "phx_reply" || topic === "phoenix") return;
    for (const h of this.topics.get(topic)?.handlers ?? []) h(event, payload);
  }

  subscribe(topic: string, handler: Handler): () => void {
    let entry = this.topics.get(topic);
    if (!entry) {
      entry = { joinRef: null, handlers: new Set() };
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
    this.send([ref, ref, topic, "phx_join", {}]);
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
