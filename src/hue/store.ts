// hue.json: per linked bridge its address, application key (+ client key),
// pinned self-signed cert fingerprint and the user's light labels. Mode 0600.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface StoredHueBridge {
  bridge_id: string;
  /** host or host:port. */
  address: string;
  app_key: string;
  client_key: string | null;
  /** SHA-256 hex of a pinned self-signed cert; null when the bridge's cert
   * chains to the Signify root CA. */
  cert_sha256: string | null;
  name: string | null;
  model: string | null;
  /** light rid → user label (PATCH /devices/{id}). */
  labels: Record<string, string>;
  linked_at: string;
}

interface FileShape {
  version: 1;
  bridges: Record<string, StoredHueBridge>;
}

export class HueStore {
  readonly path: string;

  constructor(readonly dataDir: string) {
    this.path = join(dataDir, "hue.json");
  }

  load(): StoredHueBridge[] {
    if (!existsSync(this.path)) return [];
    const parsed = JSON.parse(readFileSync(this.path, "utf8")) as FileShape;
    if (parsed.version !== 1 || typeof parsed.bridges !== "object") {
      throw new Error(`${this.path}: unsupported format (version ${String(parsed.version)})`);
    }
    chmodSync(this.path, 0o600);
    return Object.values(parsed.bridges).map((b) => ({ ...b, labels: b.labels ?? {} }));
  }

  save(bridges: Iterable<StoredHueBridge>): void {
    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    const body: FileShape = { version: 1, bridges: {} };
    for (const b of bridges) body.bridges[b.bridge_id] = b;
    const tmp = `${this.path}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(body, null, 2) + "\n", { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.path);
  }
}
