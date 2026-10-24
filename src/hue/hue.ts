// Philips Hue: linked bridges (CLIP v2), their lights as Device objects with
// fixed HAP-style iids, rooms / zones / scenes, live state from each bridge's
// event stream. See BRIDGE_API.md "Philips Hue (0.2.0)".
import { request as httpsRequest } from "node:https";
import { hostname } from "node:os";
import { ApiError } from "../errors.js";
import type { EventLog } from "../events.js";
import { log } from "../log.js";
import {
  HAP_BASE_UUID,
  categoryName,
  findCharacteristic,
  toAccessoriesJson,
  validateWrite,
  type RawAccessory,
  type RawCharacteristic,
} from "../model.js";
import { HueClient, parseAddress, type HueStreamEvent } from "./client.js";
import { GAMUTS, hsToXy, xyToHs, type Gamut } from "./color.js";
import { HueDiscovery, normalizeBridgeId, type SeenBridge } from "./discovery.js";
import { HueStore, type StoredHueBridge } from "./store.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Res = { id: string; type: string; [k: string]: any };

const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 60_000;
/** Signify's guidance: ≤ 10 light commands/s, ≤ 1 group command/s. */
const LIGHT_GAP_MS = 100;
const GROUP_GAP_MS = 1000;

const hap = (n: number) => n.toString(16).toUpperCase().padStart(8, "0") + HAP_BASE_UUID;
const PRW = ["pr", "pw", "ev"];
export const HUE_IID = { identify: 2, on: 10, brightness: 11, hue: 12, saturation: 13, colorTemperature: 14 } as const;

function deepMerge(into: Record<string, unknown>, from: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(from)) {
    const cur = into[k];
    if (v && typeof v === "object" && !Array.isArray(v) && cur && typeof cur === "object" && !Array.isArray(cur)) {
      deepMerge(cur as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      into[k] = v;
    }
  }
}

interface Ctx {
  events: EventLog;
  persist: () => void;
  timeoutMs: number;
}

/** The attribute database a Hue light is presented with (fixed iids). */
function lightDb(l: Res): RawAccessory[] {
  const chars: RawCharacteristic[] = [{ iid: HUE_IID.on, type: hap(0x25), format: "bool", perms: PRW }];
  if (l.dimming) {
    chars.push({ iid: HUE_IID.brightness, type: hap(0x08), format: "int", unit: "percentage", minValue: 0, maxValue: 100, minStep: 1, perms: PRW });
  }
  if (l.color) {
    chars.push({ iid: HUE_IID.hue, type: hap(0x13), format: "float", unit: "arcdegrees", minValue: 0, maxValue: 360, perms: PRW });
    chars.push({ iid: HUE_IID.saturation, type: hap(0x2f), format: "float", unit: "percentage", minValue: 0, maxValue: 100, perms: PRW });
  }
  if (l.color_temperature) {
    const ms = l.color_temperature.mirek_schema ?? {};
    chars.push({
      iid: HUE_IID.colorTemperature,
      type: hap(0xce),
      format: "int",
      minValue: Number(ms.mirek_minimum ?? 153),
      maxValue: Number(ms.mirek_maximum ?? 500),
      minStep: 1,
      perms: PRW,
    });
  }
  const str = (iid: number, n: number): RawCharacteristic => ({ iid, type: hap(n), format: "string", perms: ["pr"] });
  return [
    {
      aid: 1,
      services: [
        {
          iid: 1,
          type: hap(0x3e),
          characteristics: [
            { iid: HUE_IID.identify, type: hap(0x14), format: "bool", perms: ["pw"] },
            str(3, 0x20),
            str(4, 0x21),
            str(5, 0x23),
            str(6, 0x30),
            str(7, 0x52),
          ],
        },
        { iid: 9, type: hap(0x43), primary: true, characteristics: chars },
      ],
    },
  ];
}

function gamutOf(l: Res): Gamut | null {
  const g = l.color?.gamut;
  if (g?.red && g?.green && g?.blue) return g as Gamut;
  return GAMUTS[l.color?.gamut_type as string] ?? null;
}

/** One Hue light, shaped like a DeviceSession for the API layer. */
export class HueLight {
  readonly values = new Map<string, unknown>();
  connected = false;
  db: RawAccessory[] = [];
  /** hue/sat we last wrote and the xy it became: reported back while the
   * bridge still shows that xy, so a write reads back exactly. */
  private memo: { x: number; y: number; hue: number; sat: number } | null = null;

  constructor(
    readonly session: HueBridgeSession,
    readonly rid: string,
  ) {}

  get id(): string {
    return `hue:${this.session.id}:${this.rid}`;
  }

  get resource(): Res | undefined {
    return this.session.resources.get(this.rid);
  }

  get device(): Res | undefined {
    const l = this.resource;
    return l?.owner?.rid ? this.session.resources.get(l.owner.rid) : undefined;
  }

  get lastSeen(): string | null {
    return this.session.lastSeen;
  }

  /** Recompute values / connectivity from the resource cache; changes go to
   * /events. */
  refresh(): void {
    const l = this.resource;
    if (!l) return;
    const dev = this.device;
    this.db = lightDb(l);
    const pd = dev?.product_data ?? {};
    const next = new Map<number, unknown>([
      [3, pd.manufacturer_name ?? "Signify Netherlands B.V."],
      [4, pd.product_name ?? pd.model_id ?? null],
      [5, l.metadata?.name ?? dev?.metadata?.name ?? null],
      [6, dev?.id ?? l.id],
      [7, pd.software_version ?? null],
      [HUE_IID.on, !!l.on?.on],
    ]);
    if (l.dimming) next.set(HUE_IID.brightness, Math.round(Number(l.dimming.brightness ?? 0)));
    if (l.color) {
      const xy = l.color.xy;
      if (xy && Number.isFinite(xy.x) && Number.isFinite(xy.y)) {
        const m = this.memo;
        const hs =
          m && Math.abs(m.x - xy.x) < 0.0015 && Math.abs(m.y - xy.y) < 0.0015 ? { hue: m.hue, sat: m.sat } : xyToHs(xy);
        next.set(HUE_IID.hue, hs.hue);
        next.set(HUE_IID.saturation, hs.sat);
      }
    }
    if (l.color_temperature) {
      const ct = l.color_temperature;
      next.set(HUE_IID.colorTemperature, ct.mirek_valid === false || ct.mirek == null ? null : Number(ct.mirek));
    }
    for (const [iid, value] of next) {
      const key = `1.${iid}`;
      const had = this.values.has(key);
      if (had && JSON.stringify(this.values.get(key)) === JSON.stringify(value)) continue;
      this.values.set(key, value);
      if (had && iid >= HUE_IID.on) this.session.events.push({ id: this.id, kind: "value", aid: 1, iid, value });
    }
    const connected = this.session.connected && this.session.zigbeeOk(dev);
    if (connected !== this.connected) {
      this.connected = connected;
      this.session.events.push({ id: this.id, kind: "connection", connected });
    }
  }

  readAll(): Promise<void> {
    return this.session.readLight(this.rid);
  }

  /** Validated write (same rules as HomeKit), one CLIP PUT, then a re-read. */
  async write(sets: { aid: number; iid: number; value: unknown }[]): Promise<void> {
    const l = this.resource;
    if (!l) throw new ApiError("not_found", `${this.id} is gone from its bridge`);
    const vals = new Map<number, unknown>();
    for (const s of sets) {
      if (!Number.isInteger(s?.aid) || !Number.isInteger(s?.iid)) {
        throw new ApiError("bad_request", "each set entry needs integer aid and iid");
      }
      const c = findCharacteristic(this.db, s.aid, s.iid);
      if (!c) throw new ApiError("not_found", `no characteristic ${s.aid}.${s.iid} on ${this.id}`);
      vals.set(s.iid, validateWrite(c, s.value, `${s.aid}.${s.iid}`));
    }
    if (vals.get(HUE_IID.identify) === true) await this.identify();
    vals.delete(HUE_IID.identify);

    const body: Record<string, unknown> = {};
    if (vals.has(HUE_IID.on)) body.on = { on: vals.get(HUE_IID.on) };
    if (vals.has(HUE_IID.brightness)) {
      const b = vals.get(HUE_IID.brightness) as number;
      if (b === 0) body.on = { on: false };
      else {
        body.dimming = { brightness: b };
        // Like the Home app: raising brightness turns the light on.
        if (!vals.has(HUE_IID.on)) body.on = { on: true };
      }
    }
    if (vals.has(HUE_IID.hue) || vals.has(HUE_IID.saturation)) {
      const h = (vals.get(HUE_IID.hue) ?? this.values.get(`1.${HUE_IID.hue}`) ?? 0) as number;
      const s = (vals.get(HUE_IID.saturation) ?? this.values.get(`1.${HUE_IID.saturation}`) ?? 100) as number;
      const xy = hsToXy(h, s, gamutOf(l));
      const raw = hsToXy(h, s, null);
      this.memo = raw.x === xy.x && raw.y === xy.y ? { ...xy, hue: h, sat: s } : null;
      body.color = { xy };
    }
    if (vals.has(HUE_IID.colorTemperature)) body.color_temperature = { mirek: vals.get(HUE_IID.colorTemperature) };
    if (Object.keys(body).length) await this.session.put("light", this.rid, body, "light");
    await this.readAll();
  }

  /** CLIP `identify: {action: "identify"}` on the light's device. */
  async identify(): Promise<void> {
    const owner = this.resource?.owner?.rid;
    if (!owner) throw new ApiError("not_found", `${this.id} has no Hue device to identify`);
    await this.session.clip("PUT", `/clip/v2/resource/device/${owner}`, { identify: { action: "identify" } }, "light");
  }
}

/** One linked bridge: resource cache, event stream with reconnect + full
 * resync, and a serialized, rate-limited request queue. */
export class HueBridgeSession {
  readonly resources = new Map<string, Res>();
  readonly lights = new Map<string, HueLight>();
  readonly client: HueClient;
  connected = false;
  lastSeen: string | null = null;

  private closed = false;
  private stopStream: (() => void) | null = null;
  private timer: NodeJS.Timeout | null = null;
  private backoffMs = BACKOFF_MIN_MS;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly lastCmd = { light: 0, group: 0 };
  /** Stream events that arrive while a resync is in flight. */
  private pending: HueStreamEvent[] | null = null;
  private readonly syncWaiters = new Set<() => void>();

  constructor(
    readonly stored: StoredHueBridge,
    private readonly ctx: Ctx,
  ) {
    this.client = new HueClient(
      { bridgeId: stored.bridge_id, address: stored.address, appKey: stored.app_key, pin: stored.cert_sha256 },
      ctx.timeoutMs,
    );
    this.client.onTrust = (t) => {
      if (t.trust === "ca" && this.stored.cert_sha256) {
        log.info(`hue ${this.id}: bridge now serves a CA-signed certificate; dropping the pinned one`);
        this.stored.cert_sha256 = null;
        this.client.target.pin = null;
        this.ctx.persist();
      }
    };
  }

  get id(): string {
    return this.stored.bridge_id;
  }

  get events(): EventLog {
    return this.ctx.events;
  }

  start(): void {
    this.openStream();
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.stopStream?.();
    this.stopStream = null;
    for (const w of [...this.syncWaiters]) w();
  }

  /** Resolves once the stream is up and the cache synced, or after `ms`. */
  waitConnected(ms: number): Promise<void> {
    if (this.connected) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(t);
        this.syncWaiters.delete(done);
        resolve();
      };
      const t = setTimeout(done, ms);
      this.syncWaiters.add(done);
    });
  }

  updateAddress(address: string): void {
    if (this.stored.address === address) return;
    log.info(`hue ${this.id}: address changed to ${address}`);
    this.stored.address = address;
    this.client.target.address = address;
    this.ctx.persist();
    if (!this.connected && !this.stopStream) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      this.backoffMs = BACKOFF_MIN_MS;
      this.openStream();
    }
  }

  private openStream(): void {
    if (this.closed || this.stopStream) return;
    this.pending = [];
    this.stopStream = this.client.stream({
      onOpen: () => void this.resyncAfterOpen(),
      onEvents: (evs) => {
        if (this.pending) this.pending.push(...evs);
        else this.apply(evs);
      },
      onClose: (err) => {
        this.stopStream = null;
        this.pending = null;
        if (this.closed) return;
        log.info(`hue ${this.id}: event stream closed (${err?.message ?? "closed"})`);
        this.setConnected(false);
        this.scheduleReconnect();
      },
    });
  }

  private async resyncAfterOpen(): Promise<void> {
    try {
      await this.resync();
      if (this.closed) return;
      const queued = this.pending ?? [];
      this.pending = null;
      if (queued.length) this.apply(queued);
      this.backoffMs = BACKOFF_MIN_MS;
      this.setConnected(true);
    } catch (e) {
      log.warn(`hue ${this.id}: resync failed: ${(e as Error).message}`);
      const stop = this.stopStream;
      this.stopStream = null;
      this.pending = null;
      stop?.();
      if (!this.closed) {
        this.setConnected(false);
        this.scheduleReconnect();
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.closed || this.timer) return;
    const d = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.openStream();
    }, d);
  }

  private setConnected(v: boolean): void {
    if (v) this.lastSeen = new Date().toISOString();
    if (this.connected !== v) {
      this.connected = v;
      log.info(`hue ${this.id}: ${v ? "connected" : "disconnected"}`);
    }
    for (const l of this.lights.values()) l.refresh();
    if (v) for (const w of [...this.syncWaiters]) w();
  }

  /** Runs `fn` after every earlier request to this bridge; commands keep
   * Signify's rate limits per kind. */
  private run<T>(fn: () => Promise<T>, kind?: "light" | "group"): Promise<T> {
    const p = this.chain.then(async () => {
      if (this.closed) throw new ApiError("not_linked", `bridge ${this.id} was unlinked`);
      if (kind) {
        const wait = this.lastCmd[kind] + (kind === "light" ? LIGHT_GAP_MS : GROUP_GAP_MS) - Date.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      }
      try {
        return await fn();
      } finally {
        if (kind) this.lastCmd[kind] = Date.now();
      }
    });
    this.chain = p.catch(() => undefined);
    return p;
  }

  /** CLIP v2 request → `data`, errors mapped to API codes. */
  clip(method: string, path: string, body?: unknown, kind?: "light" | "group"): Promise<Res[]> {
    return this.run(async () => {
      const r = await this.client.request(method, path, body);
      const errs = ((r.json as { errors?: { description?: string }[] })?.errors ?? [])
        .map((e) => e?.description)
        .filter(Boolean)
        .join("; ");
      const what = `bridge ${this.id}: ${method} ${path}`;
      if (r.status === 401 || r.status === 403) {
        throw new ApiError(
          "not_linked",
          `${what}: the bridge rejected our application key (removed in the Hue app?); unlink and link again`,
        );
      }
      if (r.status === 404) throw new ApiError("not_found", `${what}: not found${errs ? ` (${errs})` : ""}`);
      if (r.status === 429 || r.status === 503) throw new ApiError("hue_unreachable", `${what}: bridge busy (HTTP ${r.status})`);
      if (r.status >= 400) {
        throw new ApiError(method === "PUT" ? "invalid_value" : "bad_request", `${what}: HTTP ${r.status}${errs ? `: ${errs}` : ""}`);
      }
      this.lastSeen = new Date().toISOString();
      return ((r.json as { data?: Res[] })?.data ?? []).filter((d) => d && typeof d.id === "string");
    }, kind);
  }

  /** PUT a resource, then fold the change into the cache. */
  async put(type: string, rid: string, body: Record<string, unknown>, kind: "light" | "group"): Promise<void> {
    await this.clip("PUT", `/clip/v2/resource/${type}/${rid}`, body, kind);
    const cur = this.resources.get(rid);
    if (cur && type !== "scene") deepMerge(cur, body);
    this.refreshLights();
  }

  /** Full resync: every resource, replacing the cache. */
  async resync(): Promise<void> {
    const data = await this.clip("GET", "/clip/v2/resource");
    this.resources.clear();
    for (const d of data) this.resources.set(d.id, d);
    this.updateInfo();
    this.refreshLights();
  }

  async readLight(rid: string): Promise<void> {
    await this.readResource("light", rid);
    this.refreshLights();
  }

  async readResource(type: string, rid: string): Promise<void> {
    for (const d of await this.clip("GET", `/clip/v2/resource/${type}/${rid}`)) this.resources.set(d.id, d);
  }

  private apply(evs: HueStreamEvent[]): void {
    for (const ev of evs) {
      for (const d of ev?.data ?? []) {
        if (!d?.id) continue;
        if (ev.type === "delete") this.resources.delete(d.id);
        else if (ev.type === "add") this.resources.set(d.id, d as Res);
        else if (ev.type === "update") {
          const cur = this.resources.get(d.id);
          if (cur) deepMerge(cur, d);
        }
      }
    }
    this.lastSeen = new Date().toISOString();
    this.refreshLights();
  }

  private refreshLights(): void {
    const seen = new Set<string>();
    for (const r of this.resources.values()) {
      if (r.type !== "light") continue;
      seen.add(r.id);
      let l = this.lights.get(r.id);
      if (!l) {
        l = new HueLight(this, r.id);
        this.lights.set(r.id, l);
      }
      l.refresh();
    }
    for (const rid of [...this.lights.keys()]) if (!seen.has(rid)) this.lights.delete(rid);
  }

  private updateInfo(): void {
    const br = [...this.resources.values()].find((r) => r.type === "bridge");
    const dev = br?.owner?.rid ? this.resources.get(br.owner.rid) : undefined;
    const name = dev?.metadata?.name ?? null;
    const model = dev?.product_data?.model_id ?? null;
    if ((name && name !== this.stored.name) || (model && model !== this.stored.model)) {
      this.stored.name = name ?? this.stored.name;
      this.stored.model = model ?? this.stored.model;
      this.ctx.persist();
    }
  }

  zigbeeOk(dev: Res | undefined): boolean {
    const svc = (dev?.services as { rid: string; rtype: string }[] | undefined)?.find(
      (s) => s.rtype === "zigbee_connectivity",
    );
    const z = svc ? this.resources.get(svc.rid) : undefined;
    return !z || z.status === "connected";
  }

  byType(type: string): Res[] {
    return [...this.resources.values()].filter((r) => r.type === type);
  }

  /** Light rids of a room (device children) or zone (light children). */
  groupLightRids(g: Res): string[] {
    const out: string[] = [];
    for (const c of (g.children ?? []) as { rid: string; rtype: string }[]) {
      if (c.rtype === "light") out.push(c.rid);
      else if (c.rtype === "device") {
        const dev = this.resources.get(c.rid);
        for (const s of (dev?.services ?? []) as { rid: string; rtype: string }[]) if (s.rtype === "light") out.push(s.rid);
      }
    }
    return out.filter((rid) => this.lights.has(rid));
  }

  roomOf(light: HueLight): Res | null {
    const l = light.resource;
    if (!l) return null;
    return (
      this.byType("room").find((r) =>
        ((r.children ?? []) as { rid: string }[]).some((c) => c.rid === l.owner?.rid || c.rid === l.id),
      ) ?? null
    );
  }

  groupedLight(g: Res): Res | undefined {
    const svc = ((g.services ?? []) as { rid: string; rtype: string }[]).find((s) => s.rtype === "grouped_light");
    return svc ? this.resources.get(svc.rid) : undefined;
  }
}

export interface HueOptions {
  dataDir: string;
  discovery: boolean;
  events: EventLog;
  timeoutMs: number;
}

/** Splits "<bridge_id>:<rid>". */
function splitScoped(raw: string): { bridgeId: string; rid: string } | null {
  const i = raw.indexOf(":");
  if (i < 0) return null;
  const bridgeId = normalizeBridgeId(raw.slice(0, i));
  const rid = raw.slice(i + 1);
  return bridgeId && rid ? { bridgeId, rid } : null;
}

export class HueManager {
  readonly sessions = new Map<string, HueBridgeSession>();
  readonly discovery: HueDiscovery;
  private readonly store: HueStore;
  private readonly ctx: Ctx;

  constructor(opts: HueOptions) {
    this.store = new HueStore(opts.dataDir);
    this.ctx = { events: opts.events, persist: this.persist, timeoutMs: opts.timeoutMs };
    this.discovery = new HueDiscovery(opts.discovery, (b: SeenBridge) => this.sessions.get(b.bridge_id)?.updateAddress(b.address));
  }

  start(): void {
    for (const stored of this.store.load()) {
      log.info(`loaded Hue bridge ${stored.bridge_id} (${stored.address})`);
      const s = new HueBridgeSession(stored, this.ctx);
      this.sessions.set(stored.bridge_id, s);
      s.start();
    }
    this.discovery.start();
  }

  stop(): void {
    this.discovery.stop();
    for (const s of this.sessions.values()) s.close();
  }

  persist = (): void => {
    this.store.save([...this.sessions.values()].map((s) => s.stored));
  };

  health() {
    return { hue_bridges: this.listBridges().length, hue_linked: this.sessions.size };
  }

  private session(bridgeId: string): HueBridgeSession {
    const s = this.sessions.get(bridgeId);
    if (!s) throw new ApiError("not_linked", `Hue bridge ${bridgeId} is not linked`);
    return s;
  }

  bridgeJson(s: HueBridgeSession) {
    const seen = this.discovery.get(s.id);
    return {
      bridge_id: s.id,
      name: s.stored.name ?? seen?.name ?? "Hue Bridge",
      model: s.stored.model ?? seen?.model ?? null,
      address: s.stored.address,
      linked: true,
      connected: s.connected,
      lights: s.lights.size,
    };
  }

  listBridges() {
    const out = [...this.sessions.values()].map((s) => this.bridgeJson(s));
    for (const b of this.discovery.list()) {
      if (this.sessions.has(b.bridge_id)) continue;
      out.push({
        bridge_id: b.bridge_id,
        name: b.name ?? "Hue Bridge",
        model: b.model,
        address: b.address,
        linked: false,
        connected: false,
        lights: 0,
      });
    }
    return out;
  }

  /** POST /hue/link: application key via the link button. */
  async link(body: Record<string, unknown>) {
    if (body.address != null && typeof body.address !== "string") throw new ApiError("bad_request", "address must be a string");
    let bridgeId = normalizeBridgeId(body.bridge_id);
    if (!bridgeId && body.bridge_id != null && body.bridge_id !== "") {
      throw new ApiError("bad_request", "bridge_id must be the 16-hex-digit Hue bridge id");
    }
    // Manual add by address only: the bridge names itself.
    if (!bridgeId) {
      const addr = (body.address as string | undefined)?.trim();
      if (!addr) throw new ApiError("bad_request", "pass bridge_id, address, or both");
      bridgeId = await lookupBridgeId(addr, this.ctx.timeoutMs);
    }
    const existing = this.sessions.get(bridgeId);
    if (existing) return this.bridgeJson(existing);
    const seen = this.discovery.get(bridgeId);
    const address = (body.address as string | undefined)?.trim() || seen?.address;
    if (!address) {
      throw new ApiError("bad_request", `Hue bridge ${bridgeId} was not discovered; pass its address`);
    }
    parseAddress(address);

    const client = new HueClient({ bridgeId, address, appKey: null, pin: null }, this.ctx.timeoutMs);
    const devicetype = `peckboard#${hostname().slice(0, 19) || "host"}`;
    const r = await client.request("POST", "/api", { devicetype, generateclientkey: true }, { tofu: true });
    const first = Array.isArray(r.json) ? (r.json[0] as Record<string, Record<string, unknown>>) : null;
    if (first?.error) {
      if (Number(first.error.type) === 101) {
        throw new ApiError("link_button_not_pressed", "press the link button on the Hue bridge, then retry within 30 s");
      }
      throw new ApiError("hue_unreachable", `bridge ${bridgeId} refused linking: ${String(first.error.description ?? "error")}`);
    }
    const ok = first?.success;
    if (!ok || typeof ok.username !== "string") {
      throw new ApiError("hue_unreachable", `bridge ${bridgeId}: unexpected answer to POST /api (HTTP ${r.status})`);
    }
    if (this.sessions.has(bridgeId)) return this.bridgeJson(this.sessions.get(bridgeId)!);
    const stored: StoredHueBridge = {
      bridge_id: bridgeId,
      address,
      app_key: ok.username,
      client_key: typeof ok.clientkey === "string" ? ok.clientkey : null,
      cert_sha256: r.trusted.trust === "pin" ? r.trusted.fingerprint : null,
      name: seen?.name ?? null,
      model: seen?.model ?? null,
      labels: {},
      linked_at: new Date().toISOString(),
    };
    const s = new HueBridgeSession(stored, this.ctx);
    this.sessions.set(bridgeId, s);
    this.persist();
    log.info(`linked Hue bridge ${bridgeId} at ${address} (${stored.cert_sha256 ? "pinned self-signed cert" : "Signify CA"})`);
    s.start();
    await s.waitConnected(this.ctx.timeoutMs);
    return this.bridgeJson(s);
  }

  unlink(rawId: string): { ok: true } {
    const id = normalizeBridgeId(rawId);
    const s = id ? this.sessions.get(id) : undefined;
    if (!s) throw new ApiError("not_linked", `Hue bridge ${rawId} is not linked`);
    s.close();
    this.sessions.delete(s.id);
    this.persist();
    log.info(`unlinked Hue bridge ${s.id}`);
    return { ok: true };
  }

  allLights(): HueLight[] {
    return [...this.sessions.values()].flatMap((s) => [...s.lights.values()]);
  }

  /** Light by device id `hue:<bridge_id>:<rid>`. */
  light(id: string): HueLight {
    const scoped = splitScoped(id.replace(/^hue:/, ""));
    const l = scoped ? this.sessions.get(scoped.bridgeId)?.lights.get(scoped.rid) : undefined;
    if (!l) throw new ApiError("not_found", `no Hue light ${id}`);
    return l;
  }

  rename(l: HueLight, name: string): void {
    l.session.stored.labels[l.rid] = name;
    this.persist();
  }

  toDevice(l: HueLight) {
    const s = l.session;
    const { host, port } = parseAddress(s.stored.address);
    const accessoryName = (l.values.get("1.5") as string | null) ?? null;
    const room = s.roomOf(l);
    return {
      id: l.id,
      name: s.stored.labels[l.rid] ?? accessoryName ?? l.id,
      accessory_name: accessoryName,
      model: (l.values.get("1.4") as string | null) ?? null,
      manufacturer: (l.values.get("1.3") as string | null) ?? null,
      firmware: (l.values.get("1.7") as string | null) ?? null,
      category: 5,
      category_name: categoryName(5),
      address: host,
      port,
      connected: l.connected,
      last_seen: l.lastSeen,
      source: "hue" as const,
      room: (room?.metadata?.name as string | undefined) ?? null,
      room_id: room ? `${s.id}:${room.id}` : null,
      accessories: toAccessoriesJson(l.db, l.values),
    };
  }

  private groupJson(s: HueBridgeSession, g: Res) {
    const gl = s.groupedLight(g);
    return {
      id: `${s.id}:${g.id}`,
      bridge_id: s.id,
      kind: g.type as "room" | "zone",
      name: (g.metadata?.name as string | undefined) ?? null,
      device_ids: s.groupLightRids(g).map((rid) => `hue:${s.id}:${rid}`),
      on: gl?.on ? !!gl.on.on : null,
      brightness: gl?.dimming ? Math.round(Number(gl.dimming.brightness ?? 0)) : null,
    };
  }

  groups() {
    return [...this.sessions.values()].flatMap((s) =>
      [...s.byType("room"), ...s.byType("zone")].map((g) => this.groupJson(s, g)),
    );
  }

  private group(rawId: string): { s: HueBridgeSession; g: Res } {
    const scoped = splitScoped(rawId);
    if (!scoped) throw new ApiError("not_found", `no Hue group ${rawId}`);
    const s = this.session(scoped.bridgeId);
    const g = s.resources.get(scoped.rid);
    if (!g || (g.type !== "room" && g.type !== "zone")) throw new ApiError("not_found", `no Hue group ${rawId}`);
    return { s, g };
  }

  async setGroup(rawId: string, body: Record<string, unknown>) {
    const { s, g } = this.group(rawId);
    const put: Record<string, unknown> = {};
    if (body.on !== undefined) {
      if (typeof body.on !== "boolean") throw new ApiError("invalid_value", "on must be a boolean");
      put.on = { on: body.on };
    }
    if (body.brightness !== undefined) {
      const b = body.brightness;
      if (typeof b !== "number" || !Number.isFinite(b) || b < 0 || b > 100) {
        throw new ApiError("invalid_value", "brightness must be a number 0–100");
      }
      if (b === 0) put.on = { on: false };
      else {
        put.dimming = { brightness: b };
        if (body.on === undefined) put.on = { on: true };
      }
    }
    if (!Object.keys(put).length) throw new ApiError("bad_request", 'body must carry "on" and/or "brightness"');
    const gl = s.groupedLight(g);
    if (!gl) throw new ApiError("bad_request", `${rawId} has no grouped_light to control`);
    await s.put("grouped_light", gl.id, put, "group");
    await s.readResource("grouped_light", gl.id).catch(() => undefined);
    return this.groupJson(s, g);
  }

  scenes(groupId?: string | null) {
    const out = [...this.sessions.values()].flatMap((s) =>
      s.byType("scene").map((sc) => {
        const g = sc.group?.rid ? s.resources.get(sc.group.rid) : undefined;
        return {
          id: `${s.id}:${sc.id}`,
          bridge_id: s.id,
          name: (sc.metadata?.name as string | undefined) ?? null,
          group_id: sc.group?.rid ? `${s.id}:${sc.group.rid}` : null,
          group_name: (g?.metadata?.name as string | undefined) ?? null,
        };
      }),
    );
    return groupId ? out.filter((sc) => sc.group_id === groupId) : out;
  }

  async recall(rawId: string): Promise<{ ok: true }> {
    const scoped = splitScoped(rawId);
    if (!scoped) throw new ApiError("not_found", `no Hue scene ${rawId}`);
    const s = this.session(scoped.bridgeId);
    if (s.resources.get(scoped.rid)?.type !== "scene") throw new ApiError("not_found", `no Hue scene ${rawId}`);
    await s.put("scene", scoped.rid, { recall: { action: "active" } }, "group");
    return { ok: true };
  }
}

/** Reads the bridge id from the bridge's public `/api/0/config` (answered
 * without a key) for a manual add by address. The cert is NOT trusted here:
 * the id only names the bridge, and the real link that follows verifies the
 * cert against that id (Signify CA + CN) or pins it (old self-signed). */
async function lookupBridgeId(address: string, timeoutMs: number): Promise<string> {
  const { host, port } = parseAddress(address);
  const body = await new Promise<string>((resolve, reject) => {
    const req = httpsRequest(
      { host, port, path: "/api/0/config", method: "GET", rejectUnauthorized: false, timeout: timeoutMs },
      (res) => {
        let s = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (s += c));
        res.on("end", () => resolve(s));
      },
    );
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", reject);
    req.end();
  }).catch((e: Error) => {
    throw new ApiError("hue_unreachable", `no Hue bridge answered at ${address}: ${e.message}`);
  });
  let id: string | null = null;
  try {
    id = normalizeBridgeId((JSON.parse(body) as { bridgeid?: unknown }).bridgeid);
  } catch {
    id = null;
  }
  if (!id) throw new ApiError("hue_unreachable", `${address} does not look like a Hue bridge (no bridgeid in /api/0/config)`);
  return id;
}