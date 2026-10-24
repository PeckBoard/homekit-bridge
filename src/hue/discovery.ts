// Hue Bridge discovery: continuous mDNS browse for `_hue._tcp` (the same
// dnssd stack hap-controller uses), falling back to Signify's cloud endpoint
// https://discovery.meethue.com — rate-limited by Signify, so it is asked at
// most once per 15 minutes and the answer cached.
import dnssd from "dnssd";
import { isIPv4 } from "node:net";
import { log } from "../log.js";

export interface SeenBridge {
  bridge_id: string;
  name: string | null;
  model: string | null;
  /** host, or host:port when not 443. */
  address: string;
  via: "mdns" | "cloud";
}

const CLOUD_URL = "https://discovery.meethue.com";
const CLOUD_MIN_INTERVAL_MS = 15 * 60_000;

export function normalizeBridgeId(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase().replace(/[:-]/g, "");
  return /^[0-9a-f]{16}$/.test(s) ? s : null;
}

interface DnssdService {
  name?: string;
  addresses?: string[];
  port?: number;
  txt?: Record<string, string>;
}

export class HueDiscovery {
  private readonly mdns = new Map<string, SeenBridge>();
  private cloud: SeenBridge[] = [];
  private cloudAt = 0;
  private cloudInFlight: Promise<void> | null = null;
  private browser: { stop(): void; on(ev: string, fn: (...a: never[]) => void): unknown; start(): unknown } | null =
    null;
  private fallbackTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly enabled: boolean,
    private readonly onSeen: (b: SeenBridge) => void,
  ) {}

  start(): void {
    if (!this.enabled) return;
    try {
      const b = new dnssd.Browser(new dnssd.ServiceType("_hue._tcp"));
      const up = (s: DnssdService) => {
        const id = normalizeBridgeId(s.txt?.bridgeid);
        const host = s.addresses?.find((a) => isIPv4(a)) ?? s.addresses?.[0];
        if (!id || !host) return;
        const port = s.port && s.port !== 443 ? s.port : null;
        const d: SeenBridge = {
          bridge_id: id,
          // "Hue Bridge - 0A1B2C._hue._tcp.local." → "Hue Bridge - 0A1B2C"
          name: (s.name ?? "").replace(/\._hue\._tcp.*$/, "") || null,
          model: s.txt?.modelid ?? null,
          address: port ? `${host.includes(":") ? `[${host}]` : host}:${port}` : host,
          via: "mdns",
        };
        this.mdns.set(id, d);
        this.onSeen(d);
      };
      b.on("serviceUp", up);
      b.on("serviceChanged", up);
      b.on("serviceDown", (s: DnssdService) => {
        const id = normalizeBridgeId(s.txt?.bridgeid);
        if (id) this.mdns.delete(id);
      });
      b.on("error", (e: Error) => log.warn(`Hue mDNS browse error: ${e.message}`));
      b.start();
      this.browser = b;
    } catch (e) {
      log.warn(`Hue mDNS browse failed to start: ${(e as Error).message}`);
    }
    // Nothing on mDNS after a while (multicast blocked, other VLAN): ask the cloud.
    this.fallbackTimer = setTimeout(() => {
      if (!this.mdns.size) void this.fetchCloud();
    }, 5000);
    this.fallbackTimer.unref();
  }

  stop(): void {
    if (this.fallbackTimer) clearTimeout(this.fallbackTimer);
    this.fallbackTimer = null;
    try {
      this.browser?.stop();
    } catch {
      // ignore
    }
    this.browser = null;
  }

  /** Re-browse mDNS for `ms`; ask the cloud when mDNS still sees nothing. */
  async refresh(ms = 3000): Promise<void> {
    if (!this.enabled) return;
    this.stop();
    this.mdns.clear();
    this.start();
    await new Promise((r) => setTimeout(r, ms));
    if (!this.mdns.size) await this.fetchCloud();
  }

  private fetchCloud(): Promise<void> {
    if (Date.now() - this.cloudAt < CLOUD_MIN_INTERVAL_MS) return Promise.resolve();
    if (this.cloudInFlight) return this.cloudInFlight;
    this.cloudAt = Date.now();
    this.cloudInFlight = (async () => {
      try {
        const res = await fetch(CLOUD_URL, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const list = (await res.json()) as { id?: string; internalipaddress?: string; port?: number }[];
        this.cloud = (Array.isArray(list) ? list : []).flatMap((b) => {
          const id = normalizeBridgeId(b.id);
          if (!id || typeof b.internalipaddress !== "string") return [];
          const port = b.port && b.port !== 443 ? `:${b.port}` : "";
          return [{ bridge_id: id, name: null, model: null, address: b.internalipaddress + port, via: "cloud" as const }];
        });
        for (const b of this.cloud) this.onSeen(b);
      } catch (e) {
        log.warn(`Hue cloud discovery failed: ${(e as Error).message}`);
      } finally {
        this.cloudInFlight = null;
      }
    })();
    return this.cloudInFlight;
  }

  get(id: string): SeenBridge | undefined {
    return this.mdns.get(id) ?? this.cloud.find((b) => b.bridge_id === id);
  }

  list(): SeenBridge[] {
    const all = new Map<string, SeenBridge>();
    for (const b of this.cloud) all.set(b.bridge_id, b);
    for (const b of this.mdns.values()) all.set(b.bridge_id, b);
    return [...all.values()];
  }
}
