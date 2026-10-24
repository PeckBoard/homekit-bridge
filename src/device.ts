// One paired accessory: a persistent encrypted HAP session (request
// connection + event-subscription connection, both pair-verified), a value
// cache fed by reads and HAP events, auto-reconnect with exponential backoff,
// and a per-device queue so API calls never interleave on the wire.
import { ApiError, isNetworkError, withTimeout } from "./errors.js";
import type { EventLog } from "./events.js";
import { HttpClient } from "./hap.js";
import { log } from "./log.js";
import {
  UUID,
  apiValue,
  findCharacteristic,
  plainValue,
  validateWrite,
  type RawAccessory,
  type RawCharacteristic,
} from "./model.js";
import type { StoredDevice } from "./store.js";

const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 60_000;
const ECHO_WINDOW_MS = 2000;

/** HAP status codes (spec table 6-11) → API error codes. */
function hapStatusError(status: number, what: string): ApiError {
  switch (status) {
    case -70404:
      return new ApiError("read_only", `${what}: accessory says the characteristic is read-only`);
    case -70410:
      return new ApiError("invalid_value", `${what}: accessory rejected the value`);
    case -70402:
    case -70403:
    case -70407:
    case -70408:
      return new ApiError("unreachable", `${what}: accessory is busy or unreachable (HAP status ${status})`);
    default:
      return new ApiError("bad_request", `${what}: accessory returned HAP status ${status}`);
  }
}

/** Pair-verify failed on the keys themselves: the accessory rejected ours
 * (kTLVError_Authentication) or now signs with a different long-term key —
 * either way it was factory-reset or re-paired elsewhere. */
function isPairingRejected(e: unknown): boolean {
  return /^M[24]: (Error: 2|Signature verification failed|Wrong accessory pairing ID)$/.test(
    (e as Error)?.message ?? "",
  );
}

export function mapError(e: unknown, what: string): ApiError {
  if (e instanceof ApiError) return e;
  if (isNetworkError(e)) {
    return new ApiError("unreachable", `${what}: ${(e as Error).message}`);
  }
  if (isPairingRejected(e)) {
    return new ApiError(
      "not_paired",
      `${what}: the accessory rejected our pairing (was it reset or removed?); unpair with ?force=1 and pair again`,
    );
  }
  const status = (e as { statusCode?: number })?.statusCode;
  if (typeof status === "number" && status >= 400) {
    return new ApiError("bad_request", `${what}: accessory answered HTTP ${status}`);
  }
  return new ApiError("unreachable", `${what}: ${(e as Error)?.message ?? String(e)}`);
}

interface Hooks {
  events: EventLog;
  /** Re-save pairings.json (address / database changed). */
  persist: () => void;
  timeoutMs: number;
}

/** Copy of the database for pairings.json: values dropped except the static
 * accessory-information ones (names, model) that label an offline device. */
function dbForDisk(db: RawAccessory[]): RawAccessory[] {
  return db.map((a) => ({
    aid: a.aid,
    services: a.services.map((s) => ({
      ...s,
      characteristics: s.characteristics.map((c) => {
        const { value, ...rest } = c;
        return s.type === UUID.accessoryInformation && c.type !== UUID.identify
          ? { ...rest, value: plainValue(value) }
          : rest;
      }),
    })),
  }));
}

export class DeviceSession {
  readonly values = new Map<string, unknown>();
  connected = false;
  lastSeen: string | null = null;

  private client: HttpClient | null = null;
  private gen = 0;
  private backoffMs = BACKOFF_MIN_MS;
  private timer: NodeJS.Timeout | null = null;
  private closed = false;
  private removing = false;
  private chain: Promise<unknown> = Promise.resolve();
  private connecting: Promise<void> | null = null;
  /** Values we wrote recently. The accessory echoes our writes as events on
   * the subscription connection, possibly late and batched behind newer
   * changes; an echo must not overwrite a newer value. */
  private readonly recentWrites = new Map<string, { value: unknown; until: number }>();
  private verifyTimer: NodeJS.Timeout | null = null;

  constructor(
    readonly stored: StoredDevice,
    private readonly hooks: Hooks,
  ) {
    for (const a of stored.accessories) {
      for (const s of a.services) {
        for (const c of s.characteristics) {
          if (c.value !== undefined) this.values.set(`${a.aid}.${c.iid}`, c.value);
        }
      }
    }
  }

  get id(): string {
    return this.stored.id;
  }

  get db(): RawAccessory[] {
    return this.stored.accessories;
  }

  /** Begin connecting in the background. */
  start(): void {
    this.scheduleReconnect(0);
  }

  /** Close the session for good (unpair / shutdown). */
  async close(): Promise<void> {
    this.closed = true;
    this.gen++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.verifyTimer) clearTimeout(this.verifyTimer);
    this.verifyTimer = null;
    await this.teardownClient();
  }

  /** New address from mDNS; reconnect now if we are not connected. */
  updateAddress(address: string, port: number): void {
    if (this.stored.address === address && this.stored.port === port) return;
    log.info(`${this.id}: address changed to ${address}:${port}`);
    this.stored.address = address;
    this.stored.port = port;
    this.hooks.persist();
    if (!this.connected) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      this.backoffMs = BACKOFF_MIN_MS;
      this.scheduleReconnect(0);
    }
  }

  /** Accessory database changed (mDNS c# bumped): re-read it. */
  configChanged(configNumber: number): void {
    if (this.stored.config_number === configNumber) return;
    this.stored.config_number = configNumber;
    this.hooks.persist();
    if (this.connected) this.lost(this.gen, "configuration number changed");
  }

  /** Runs `fn` on the session, serialized with every other call for this
   * device. Connects first if needed. */
  run<T>(what: string, fn: (c: HttpClient) => Promise<T>): Promise<T> {
    const p = this.chain.then(async () => {
      if (this.closed) throw new ApiError("not_found", "device was removed");
      try {
        await this.connect();
      } catch (e) {
        throw mapError(e, `connecting to ${this.id}`);
      }
      const client = this.client!;
      const gen = this.gen;
      try {
        const r = await withTimeout(fn(client), this.hooks.timeoutMs, what);
        this.lastSeen = new Date().toISOString();
        return r;
      } catch (e) {
        const err = mapError(e, what);
        if (err.code === "timeout" || err.code === "unreachable") this.lost(gen, err.message);
        throw err;
      }
    });
    this.chain = p.catch(() => undefined);
    return p;
  }

  /** Re-reads every readable characteristic into the cache (connecting,
   * and so loading the database, first if needed). */
  async readAll(): Promise<void> {
    const res = await this.run("reading values", (c) => {
      const ids: string[] = [];
      for (const a of this.db) {
        for (const s of a.services) {
          for (const ch of s.characteristics) {
            if (ch.perms?.includes("pr")) ids.push(`${a.aid}.${ch.iid}`);
          }
        }
      }
      return ids.length ? c.getCharacteristics(ids) : Promise.resolve({ characteristics: [] });
    });
    for (const ch of res.characteristics ?? []) {
      const status = (ch as { status?: number }).status;
      if (status && status !== 0) continue;
      if (ch.value !== undefined) this.updateValue(Number(ch.aid), Number(ch.iid), ch.value);
    }
  }

  /** Validated write of one or more characteristics, then a full re-read. */
  async write(sets: { aid: number; iid: number; value: unknown }[]): Promise<void> {
    const payload: Record<string, unknown> = {};
    for (const s of sets) {
      if (!Number.isInteger(s?.aid) || !Number.isInteger(s?.iid)) {
        throw new ApiError("bad_request", "each set entry needs integer aid and iid");
      }
      const c = findCharacteristic(this.db, s.aid, s.iid);
      if (!c) throw new ApiError("not_found", `no characteristic ${s.aid}.${s.iid} on ${this.id}`);
      payload[`${s.aid}.${s.iid}`] = validateWrite(c, s.value, `${s.aid}.${s.iid}`);
    }
    await this.setRaw(payload);
    await this.readAll();
  }
  /** Writes Identify (blink) on the first accessory that has it. */
  async identify(): Promise<void> {
    let found: { aid: number; c: RawCharacteristic } | null = null;
    for (const a of this.db) {
      for (const s of a.services) {
        const c = s.characteristics.find((c) => c.type === UUID.identify);
        if (c && !found) found = { aid: a.aid, c };
      }
    }
    if (!found) throw new ApiError("not_found", `${this.id} has no Identify characteristic`);
    await this.setRaw({ [`${found.aid}.${found.c.iid}`]: true });
  }

  /** HAP remove-pairing for our controller id. On success the session is
   * dead for good: the accessory drops our connections, sometimes before
   * it answers, so connection loss is ignored while this runs. */
  async removePairing(): Promise<void> {
    const ours = this.stored.pairing.iOSDevicePairingID;
    await this.run("removing pairing", async (c) => {
      this.removing = true;
      try {
        await c.removePairing(ours);
        this.closed = true;
        this.gen++;
      } finally {
        this.removing = false;
      }
    });
  }

  private async setRaw(payload: Record<string, unknown>): Promise<void> {
    const res = (await this.run("writing values", (c) => c.setCharacteristics(payload))) as {
      characteristics?: { aid: unknown; iid: unknown; status?: number }[];
    };
    for (const ch of res?.characteristics ?? []) {
      if (ch.status && ch.status !== 0) {
        throw hapStatusError(ch.status, `writing ${String(ch.aid)}.${String(ch.iid)}`);
      }
    }
    const until = Date.now() + ECHO_WINDOW_MS;
    for (const [key, value] of Object.entries(payload)) {
      const [aid, iid] = key.split(".").map(Number);
      this.updateValue(aid, iid, value);
      this.recentWrites.set(key, { value: this.values.get(key), until });
    }
  }

  /** One HAP event batch. Echoes of our own recent writes that would undo
   * a newer value are dropped, and a re-read settles the truth. */
  private onEvent(chars: { aid: unknown; iid: unknown; value: unknown }[]): void {
    this.lastSeen = new Date().toISOString();
    const now = Date.now();
    let dropped = false;
    for (const c of chars) {
      const aid = Number(c.aid);
      const iid = Number(c.iid);
      const key = `${aid}.${iid}`;
      const w = this.recentWrites.get(key);
      if (w && w.until < now) this.recentWrites.delete(key);
      if (w && w.until >= now) {
        const v = JSON.stringify(apiValue(findCharacteristic(this.db, aid, iid)?.format, c.value));
        if (v === JSON.stringify(w.value) && v !== JSON.stringify(this.values.get(key))) {
          dropped = true;
          continue;
        }
      }
      this.updateValue(aid, iid, c.value);
    }
    if (dropped && !this.verifyTimer) {
      this.verifyTimer = setTimeout(() => {
        this.verifyTimer = null;
        this.readAll().catch(() => undefined);
      }, 300);
    }
  }

  private updateValue(aid: number, iid: number, raw: unknown): void {
    const key = `${aid}.${iid}`;
    const value = apiValue(findCharacteristic(this.db, aid, iid)?.format, raw);
    const had = this.values.has(key);
    if (had && JSON.stringify(this.values.get(key)) === JSON.stringify(value)) return;
    this.values.set(key, value);
    if (had) this.hooks.events.push({ id: this.id, kind: "value", aid, iid, value });
  }

  private setConnected(v: boolean): void {
    if (v) this.lastSeen = new Date().toISOString();
    if (this.connected === v) return;
    this.connected = v;
    log.info(`${this.id}: ${v ? "connected" : "disconnected"}`);
    this.hooks.events.push({ id: this.id, kind: "connection", connected: v });
  }

  private scheduleReconnect(delay?: number): void {
    if (this.closed || this.timer) return;
    const d = delay ?? this.backoffMs;
    if (delay === undefined) this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.connect().catch((e) => log.warn(`${this.id}: connect failed: ${mapError(e, "connect").message}`));
    }, d);
  }

  /** Called when either connection dies or a call times out. */
  private lost(gen: number, why: string): void {
    if (gen !== this.gen || this.closed || this.removing) return;
    log.info(`${this.id}: session lost (${why})`);
    this.gen++;
    void this.teardownClient();
    this.setConnected(false);
    this.scheduleReconnect(this.backoffMs === BACKOFF_MIN_MS ? 0 : undefined);
  }

  private async teardownClient(): Promise<void> {
    const c = this.client;
    this.client = null;
    if (!c) return;
    c.removeAllListeners();
    try {
      await c.close();
    } catch {
      // already closed
    }
  }

  /** Opens (or returns the in-flight attempt to open) the session: pair-
   * verify, read the database, subscribe to every `ev` characteristic. */
  private connect(): Promise<void> {
    if (this.closed) return Promise.reject(new ApiError("not_found", "device was removed"));
    if (this.connected && this.client) return Promise.resolve();
    if (this.connecting) return this.connecting;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const gen = ++this.gen;
    const attempt = (async () => {
      await this.teardownClient();
      if (gen !== this.gen) throw new Error("superseded");
      const { id, address, port, pairing } = this.stored;
      const client = new HttpClient(id, address, port, pairing, { usePersistentConnections: true });
      this.client = client;
      try {
        const t = this.hooks.timeoutMs;
        const res = await withTimeout(client.getAccessories(), t, "reading accessory database");
        if (gen !== this.gen) throw new Error("superseded");
        this.applyDb(res.accessories as unknown as RawAccessory[]);
        // hap-controller keeps a dead persistent connection around after the
        // accessory drops it; watch it ourselves and rebuild the session.
        const conn = (client as unknown as { _defaultConnection?: NodeJS.EventEmitter })._defaultConnection;
        conn?.once("disconnect", () => this.lost(gen, "request connection closed"));
        client.on("event", (ev: { characteristics?: { aid: unknown; iid: unknown; value: unknown }[] }) => {
          if (gen === this.gen) this.onEvent(ev?.characteristics ?? []);
        });
        client.on("event-disconnect", () => this.lost(gen, "event connection closed"));
        const evIds = this.db.flatMap((a) =>
          a.services.flatMap((s) =>
            s.characteristics.filter((c) => c.perms?.includes("ev")).map((c) => `${a.aid}.${c.iid}`),
          ),
        );
        if (evIds.length) await withTimeout(client.subscribeCharacteristics(evIds), t, "subscribing to events");
        if (gen !== this.gen) throw new Error("superseded");
        this.backoffMs = BACKOFF_MIN_MS;
        this.setConnected(true);
      } catch (e) {
        if (gen === this.gen) {
          this.gen++;
          await this.teardownClient();
          this.setConnected(false);
          this.scheduleReconnect();
        } else if (this.client !== client) {
          // Superseded (close / newer attempt): don't leak our sockets.
          client.removeAllListeners();
          client.close().catch(() => undefined);
        }
        throw e;
      }
    })();
    this.connecting = attempt;
    attempt.then(
      () => (this.connecting = this.connecting === attempt ? null : this.connecting),
      () => (this.connecting = this.connecting === attempt ? null : this.connecting),
    );
    return attempt;
  }

  private applyDb(raw: RawAccessory[]): void {
    const db: RawAccessory[] = raw.map((a) => ({
      aid: Number(a.aid),
      services: a.services.map((s) => ({
        ...s,
        iid: Number(s.iid),
        type: s.type.toUpperCase(),
        characteristics: s.characteristics.map((c) => ({ ...c, iid: Number(c.iid), type: c.type.toUpperCase() })),
      })),
    }));
    // Swap the database in first so updateValue() sees the formats.
    const disk = dbForDisk(db);
    if (JSON.stringify(disk) !== JSON.stringify(this.stored.accessories)) {
      this.stored.accessories = disk;
      this.hooks.persist();
    }
    for (const a of db) {
      for (const s of a.services) {
        for (const c of s.characteristics) {
          if (c.value !== undefined) this.updateValue(a.aid, c.iid, c.value);
        }
      }
    }
  }
}
