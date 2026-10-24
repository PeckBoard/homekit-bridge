// The bridge: paired devices, pairing / unpairing, discovery bookkeeping.
import { DeviceSession, mapError } from "./device.js";
import { ApiError, isNetworkError, withTimeout } from "./errors.js";
import { EventLog } from "./events.js";
import { HttpClient, PairMethods } from "./hap.js";
import { HueLight, HueManager } from "./hue/hue.js";
import { log } from "./log.js";
import { UUID, categoryName, guessCategory, infoValue, toAccessoriesJson } from "./model.js";
import { normalizeId, parseSetupCode } from "./setupCode.js";
import { Discovery } from "./discovery.js";
import { Store, type StoredDevice } from "./store.js";

export interface BridgeOptions {
  dataDir: string;
  discovery: boolean;
  /** Per accessory call. */
  timeoutMs?: number;
}

/** kTLVError_* codes from pair-setup (HAP spec table 5-5). */
function pairSetupError(e: unknown): ApiError {
  if (e instanceof ApiError) return e;
  if (isNetworkError(e)) return new ApiError("unreachable", `accessory unreachable: ${(e as Error).message}`);
  const msg = (e as Error)?.message ?? String(e);
  const m = /^M(\d): Error: (\d+)$/.exec(msg);
  const code = m ? Number(m[2]) : null;
  if (code === 2 || /Invalid PIN/.test(msg) || /M4: Proof verification failed/.test(msg)) {
    return new ApiError("bad_setup_code", "the accessory rejected the setup code");
  }
  if (code === 6) {
    return new ApiError(
      "pair_failed",
      "the accessory is already paired with another controller: remove it from Apple Home (or factory-reset it) first",
    );
  }
  if (code === 3 || code === 5) {
    return new ApiError("pair_failed", "the accessory refuses pairing after too many attempts: power-cycle it and retry");
  }
  if (code === 4) return new ApiError("pair_failed", "the accessory cannot accept more pairings");
  if (code === 7) return new ApiError("pair_failed", "the accessory is busy pairing with another controller");
  return new ApiError("pair_failed", `pairing failed: ${msg}`);
}

export class Bridge {
  readonly events = new EventLog(500);
  readonly devices = new Map<string, DeviceSession>();
  readonly discovery: Discovery;
  readonly hue: HueManager;
  private readonly store: Store;
  private readonly timeoutMs: number;
  private readonly pairing = new Set<string>();

  constructor(opts: BridgeOptions) {
    this.store = new Store(opts.dataDir);
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.discovery = new Discovery(opts.discovery, (d) => {
      const dev = this.devices.get(d.id);
      if (!dev) return;
      if (dev.stored.category == null && d.category != null) {
        dev.stored.category = d.category;
        this.persist();
      }
      dev.updateAddress(d.address, d.port);
      if (d.config_number != null) dev.configChanged(d.config_number);
    });
    this.hue = new HueManager({
      dataDir: opts.dataDir,
      discovery: opts.discovery,
      events: this.events,
      timeoutMs: this.timeoutMs,
    });
  }

  /** Load pairings + Hue links, start sessions and the mDNS browses. */
  start(): void {
    for (const stored of this.store.load().values()) {
      log.info(`loaded pairing ${stored.id} (${stored.address}:${stored.port})`);
      this.addSession(stored).start();
    }
    this.discovery.start();
    this.hue.start();
  }

  async stop(): Promise<void> {
    this.discovery.stop();
    this.hue.stop();
    this.events.wakeAll();
    await Promise.all([...this.devices.values()].map((d) => d.close()));
  }

  persist = (): void => {
    this.store.save([...this.devices.values()].map((d) => d.stored));
  };

  private addSession(stored: StoredDevice): DeviceSession {
    const s = new DeviceSession(stored, { events: this.events, persist: this.persist, timeoutMs: this.timeoutMs });
    this.devices.set(stored.id, s);
    return s;
  }

  /** Session by URL id (with or without colons), or a Hue light (`hue:…`). */
  get(rawId: string): DeviceSession | HueLight {
    if (rawId.startsWith("hue:")) return this.hue.light(rawId);
    const id = normalizeId(rawId);
    const dev = id ? this.devices.get(id) : undefined;
    if (dev) return dev;
    if (id && this.discovery.get(id)) {
      throw new ApiError("not_paired", `${id} is not paired with this bridge`);
    }
    throw new ApiError("not_found", `no paired device ${rawId}`);
  }

  health() {
    const all = [...this.devices.values()];
    return { paired: all.length, connected: all.filter((d) => d.connected).length, ...this.hue.health() };
  }

  discover() {
    return this.discovery.list().map((d) => ({
      id: d.id,
      name: d.name,
      model: d.model,
      category: d.category,
      category_name: categoryName(d.category),
      address: d.address,
      port: d.port,
      paired_with_us: this.devices.has(d.id),
      available_for_pairing: d.available_for_pairing,
    }));
  }

  /** Every device: paired HomeKit accessories, then lights of linked Hue bridges. */
  listDevices(): (DeviceSession | HueLight)[] {
    return [...this.devices.values(), ...this.hue.allLights()];
  }

  toDevice(d: DeviceSession | HueLight) {
    if (d instanceof HueLight) return this.hue.toDevice(d);
    const s = d.stored;
    const acc1 = s.accessories.find((a) => a.aid === 1) ?? s.accessories[0];
    const accessoryName = infoValue(acc1, UUID.name, d.values);
    const category = s.category ?? guessCategory(s.accessories);
    return {
      id: s.id,
      name: s.name ?? accessoryName ?? s.id,
      accessory_name: accessoryName,
      model: infoValue(acc1, UUID.model, d.values),
      manufacturer: infoValue(acc1, UUID.manufacturer, d.values),
      firmware: infoValue(acc1, UUID.firmwareRevision, d.values),
      category,
      category_name: categoryName(category),
      address: s.address,
      port: s.port,
      connected: d.connected,
      last_seen: d.lastSeen,
      source: "homekit" as const,
      room: null,
      room_id: null,
      accessories: toAccessoriesJson(s.accessories, d.values),
    };
  }

  async pair(body: Record<string, unknown>): Promise<DeviceSession> {
    const pin = parseSetupCode(body.setup_code);
    const requested = typeof body.id === "string" ? normalizeId(body.id) : null;
    if (!requested) throw new ApiError("bad_request", "id must be a HAP device id like A1:B2:C3:D4:E5:F6");
    if (this.devices.has(requested)) throw new ApiError("already_paired", `${requested} is already paired`);
    if (this.pairing.has(requested)) throw new ApiError("already_paired", `${requested} is being paired right now`);
    if (body.name != null && typeof body.name !== "string") throw new ApiError("bad_request", "name must be a string");

    const seen = this.discovery.get(requested);
    const address = typeof body.address === "string" && body.address ? body.address : seen?.address;
    const port = body.port != null ? Number(body.port) : seen?.port;
    if (!address || !port || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new ApiError(
        "bad_request",
        `${requested} was not found via mDNS; pass address and port for a manual add`,
      );
    }
    if (seen && !seen.available_for_pairing) {
      throw new ApiError(
        "pair_failed",
        "the accessory is already paired with another controller: remove it from Apple Home (or factory-reset it) first",
      );
    }

    this.pairing.add(requested);
    try {
      const client = new HttpClient(requested, address, port);
      // MFi-certified accessories advertise ff bit 0 and expect the
      // "with auth" method; everything else takes plain PairSetup.
      const method = seen && seen.feature_flags & 1 ? PairMethods.PairSetupWithAuth : PairMethods.PairSetup;
      try {
        await withTimeout(client.pairSetup(pin, method), 30_000, "pair-setup");
      } catch (e) {
        throw pairSetupError(e);
      } finally {
        await client.close().catch(() => undefined);
      }
      const pairing = client.getLongTermData();
      if (!pairing) throw new ApiError("pair_failed", "pair-setup finished without long-term keys");
      // Key the device by the id the accessory proved, not the one we were
      // told (a manual add may carry a typo).
      const proven = normalizeId(Buffer.from(pairing.AccessoryPairingID, "hex").toString("utf8")) ?? requested;
      if (proven !== requested) log.warn(`${requested}: accessory identifies as ${proven}; using that id`);

      const stored: StoredDevice = {
        id: proven,
        name: typeof body.name === "string" && body.name.trim() ? body.name.trim() : null,
        address,
        port,
        category: seen?.category ?? null,
        config_number: seen?.config_number ?? null,
        pairing,
        accessories: [],
        paired_at: new Date().toISOString(),
      };
      // Persist before anything else can fail: the accessory now only
      // answers to these keys.
      const dev = this.addSession(stored);
      this.persist();
      log.info(`paired ${proven} at ${address}:${port}`);
      try {
        await dev.readAll();
      } catch (e) {
        log.warn(`${proven}: paired, but the first session failed: ${mapError(e, "connect").message}`);
      }
      return dev;
    } finally {
      this.pairing.delete(requested);
    }
  }

  async unpair(rawId: string, force: boolean): Promise<{ ok: true; removed_from_accessory: boolean }> {
    const dev = this.get(rawId);
    if (dev instanceof HueLight) {
      throw new ApiError("bad_request", `${dev.id} is a Hue light: unlink the bridge instead`);
    }
    let removed = false;
    try {
      await dev.removePairing();
      removed = true;
    } catch (e) {
      if (!force) throw e;
      log.warn(`${dev.id}: remove-pairing failed, forgetting anyway (force): ${(e as Error).message}`);
    }
    await dev.close();
    this.devices.delete(dev.id);
    this.persist();
    log.info(`unpaired ${dev.id} (removed_from_accessory=${removed})`);
    return { ok: true, removed_from_accessory: removed };
  }

  rename(rawId: string, name: unknown): DeviceSession | HueLight {
    const dev = this.get(rawId);
    if (typeof name !== "string" || !name.trim()) throw new ApiError("bad_request", "name must be a non-empty string");
    if (dev instanceof HueLight) {
      this.hue.rename(dev, name.trim());
      return dev;
    }
    dev.stored.name = name.trim();
    this.persist();
    return dev;
  }
}
