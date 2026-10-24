// pairings.json: controller long-term keys + accessory LTPK per device, the
// user label, last known address and the cached attribute database (so
// GET /devices answers from disk before the first reconnect). Mode 0600.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PairingData } from "./hap.js";
import type { RawAccessory } from "./model.js";

export interface StoredDevice {
  id: string;
  name: string | null;
  address: string;
  port: number;
  category: number | null;
  config_number: number | null;
  pairing: PairingData;
  accessories: RawAccessory[];
  paired_at: string;
}

interface FileShape {
  version: 1;
  devices: Record<string, StoredDevice>;
}

export class Store {
  readonly path: string;

  constructor(readonly dataDir: string) {
    this.path = join(dataDir, "pairings.json");
  }

  load(): Map<string, StoredDevice> {
    if (!existsSync(this.path)) return new Map();
    const parsed = JSON.parse(readFileSync(this.path, "utf8")) as FileShape;
    if (parsed.version !== 1 || typeof parsed.devices !== "object") {
      throw new Error(`${this.path}: unsupported format (version ${String(parsed.version)})`);
    }
    // Tighten permissions left loose by a hand edit.
    chmodSync(this.path, 0o600);
    return new Map(Object.entries(parsed.devices));
  }

  save(devices: Iterable<StoredDevice>): void {
    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    const body: FileShape = { version: 1, devices: {} };
    for (const d of devices) body.devices[d.id] = d;
    const tmp = `${this.path}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(body, null, 2) + "\n", { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.path);
  }
}
