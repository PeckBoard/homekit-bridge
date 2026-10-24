// Ring buffer of state-change events behind `GET /events` (long-poll).

export type BridgeEvent =
  | { seq: number; id: string; kind: "value"; aid: number; iid: number; value: unknown; at: string }
  | { seq: number; id: string; kind: "connection"; connected: boolean; at: string };

type NewEvent =
  | { id: string; kind: "value"; aid: number; iid: number; value: unknown }
  | { id: string; kind: "connection"; connected: boolean };

export class EventLog {
  private buf: BridgeEvent[] = [];
  private seq = 0;
  private waiters = new Set<() => void>();

  constructor(private readonly capacity = 500) {}

  get latest(): number {
    return this.seq;
  }

  push(e: NewEvent): void {
    const ev = { ...e, seq: ++this.seq, at: new Date().toISOString() } as BridgeEvent;
    this.buf.push(ev);
    if (this.buf.length > this.capacity) this.buf.splice(0, this.buf.length - this.capacity);
    const ws = [...this.waiters];
    this.waiters.clear();
    for (const w of ws) w();
  }

  since(seq: number): BridgeEvent[] {
    return this.buf.filter((e) => e.seq > seq);
  }

  /** Resolves with events newer than `seq` as soon as there are any, or with
   * an empty list after `timeoutMs` / when `signal` aborts. */
  wait(seq: number, timeoutMs: number, signal?: AbortSignal): Promise<BridgeEvent[]> {
    const ready = this.since(seq);
    if (ready.length || signal?.aborted) return Promise.resolve(ready);
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.waiters.delete(done);
        signal?.removeEventListener("abort", done);
        resolve(this.since(seq));
      };
      const timer = setTimeout(done, timeoutMs);
      this.waiters.add(done);
      signal?.addEventListener("abort", done, { once: true });
    });
  }

  /** Wakes every pending long-poll (shutdown). */
  wakeAll(): void {
    const ws = [...this.waiters];
    this.waiters.clear();
    for (const w of ws) w();
  }
}
