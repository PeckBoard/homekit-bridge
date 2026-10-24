// Continuous mDNS browse for `_hap._tcp` accessories.
import { isIPv4 } from "node:net";
import { IPDiscovery, type HapServiceIp } from "./hap.js";
import { log } from "./log.js";
import { normalizeId } from "./setupCode.js";

export interface Discovered {
  id: string;
  name: string;
  model: string | null;
  category: number | null;
  address: string;
  port: number;
  feature_flags: number;
  config_number: number | null;
  available_for_pairing: boolean;
}

function toDiscovered(s: HapServiceIp): Discovered | null {
  const id = normalizeId(s.id ?? "");
  if (!id) return null;
  const address = s.allAddresses?.find((a) => isIPv4(a)) ?? s.address;
  if (!address) return null;
  return {
    id,
    // "Eve Energy 1A2B._hap._tcp.local." → "Eve Energy 1A2B"
    name: (s.name ?? "").replace(/\._hap\._tcp.*$/, ""),
    model: s.md ?? null,
    category: Number.isFinite(s.ci) ? s.ci : null,
    address,
    port: s.port,
    feature_flags: Number.isFinite(s.ff) ? s.ff : 0,
    config_number: Number.isFinite(s["c#"]) ? s["c#"] : null,
    available_for_pairing: !!s.availableToPair,
  };
}

export class Discovery {
  private readonly seen = new Map<string, Discovered>();
  private ipd: IPDiscovery | null = null;

  /** `onSeen` fires for every up/changed record (address + c# tracking). */
  constructor(
    private readonly enabled: boolean,
    private readonly onSeen: (d: Discovered) => void,
  ) {}

  start(): void {
    if (!this.enabled) return;
    const ipd = new IPDiscovery();
    const up = (s: HapServiceIp) => {
      const d = toDiscovered(s);
      if (!d) return;
      this.seen.set(d.id, d);
      this.onSeen(d);
    };
    ipd.on("serviceUp", up);
    ipd.on("serviceChanged", up);
    ipd.on("serviceDown", (s: HapServiceIp) => {
      const id = normalizeId(s.id ?? "");
      if (id) this.seen.delete(id);
    });
    try {
      ipd.start();
      // dnssd's Browser emits 'error' (no multicast, bad interface); without
      // a listener that would crash the daemon.
      (ipd as unknown as { browser?: NodeJS.EventEmitter }).browser?.on("error", (e: Error) =>
        log.warn(`mDNS browse error: ${e.message}`),
      );
    } catch (e) {
      log.warn(`mDNS browse failed to start: ${(e as Error).message}`);
    }
    this.ipd = ipd;
  }

  stop(): void {
    try {
      this.ipd?.stop();
    } catch {
      // ignore
    }
    this.ipd = null;
  }

  /** Forget everything and browse afresh for `ms`. */
  async refresh(ms = 3000): Promise<void> {
    if (!this.enabled) return;
    this.stop();
    this.seen.clear();
    this.start();
    await new Promise((r) => setTimeout(r, ms));
  }

  get(id: string): Discovered | undefined {
    return this.seen.get(id);
  }

  list(): Discovered[] {
    return [...this.seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
}
