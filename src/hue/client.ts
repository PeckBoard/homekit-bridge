// Minimal Hue Bridge HTTPS client on node:http over a verified TLS socket
// (see tls.ts): JSON requests and the CLIP v2 event stream (SSE).
import { request as httpRequest, type IncomingMessage } from "node:http";
import { isIPv6 } from "node:net";
import { ApiError } from "../errors.js";
import { connectTrusted, type Trusted } from "./tls.js";

/** "1.2.3.4", "1.2.3.4:8443", "[fe80::1]:443", "fe80::1", "hue.local". */
export function parseAddress(a: string): { host: string; port: number } {
  const s = a.trim();
  let m = /^\[([^\]]+)\](?::(\d+))?$/.exec(s);
  if (m) return checkPort(m[1], m[2]);
  if (isIPv6(s)) return { host: s, port: 443 };
  m = /^([^:\s/]+)(?::(\d+))?$/.exec(s);
  if (m) return checkPort(m[1], m[2]);
  throw new ApiError("bad_request", `address must be host or host:port, got ${JSON.stringify(a)}`);
}

function checkPort(host: string, p: string | undefined): { host: string; port: number } {
  const port = p ? Number(p) : 443;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ApiError("bad_request", `bad port in address: ${p}`);
  return { host, port };
}

export interface HueTarget {
  bridgeId: string;
  address: string;
  appKey: string | null;
  pin: string | null;
}

export interface HueResponse {
  status: number;
  json: unknown;
  trusted: Trusted;
}

/** One CLIP v2 eventstream message: `{type, data: [partial resources]}`. */
export interface HueStreamEvent {
  type: string;
  data: { id: string; type: string; [k: string]: unknown }[];
}

export class HueClient {
  /** Called with every successful trust decision (lets the owner drop an
   * obsolete pin once the bridge serves a CA-signed cert). */
  onTrust: ((t: Trusted) => void) | null = null;

  constructor(
    readonly target: HueTarget,
    private readonly timeoutMs = 10_000,
  ) {}

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return this.target.appKey ? { "hue-application-key": this.target.appKey, ...extra } : extra;
  }

  private async open(tofu: boolean) {
    const { host, port } = parseAddress(this.target.address);
    const conn = await connectTrusted(
      { bridgeId: this.target.bridgeId, host, port, pin: this.target.pin, tofu },
      this.timeoutMs,
    );
    this.onTrust?.(conn);
    return { ...conn, host, port };
  }

  /** One JSON request on a fresh verified connection. `tofu` (linking only)
   * accepts a self-signed bridge cert; its fingerprint is in `trusted`. */
  async request(method: string, path: string, body?: unknown, opts: { tofu?: boolean } = {}): Promise<HueResponse> {
    const conn = await this.open(!!opts.tofu);
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const what = `bridge ${this.target.bridgeId}: ${method} ${path}`;
    return new Promise((resolve, reject) => {
      const req = httpRequest({
        host: conn.host,
        port: conn.port,
        method,
        path,
        createConnection: () => conn.socket,
        headers: this.headers({
          accept: "application/json",
          ...(payload ? { "content-type": "application/json", "content-length": String(payload.length) } : {}),
        }),
      });
      const timer = setTimeout(() => {
        req.destroy();
        reject(new ApiError("hue_unreachable", `${what} timed out after ${this.timeoutMs} ms`));
      }, this.timeoutMs);
      req.on("error", (e) => {
        clearTimeout(timer);
        reject(new ApiError("hue_unreachable", `${what}: ${e.message}`));
      });
      req.on("response", (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("error", (e) => {
          clearTimeout(timer);
          reject(new ApiError("hue_unreachable", `${what}: ${e.message}`));
        });
        res.on("end", () => {
          clearTimeout(timer);
          let json: unknown = null;
          try {
            json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            // non-JSON error page; status says enough
          }
          resolve({ status: res.statusCode ?? 0, json, trusted: { trust: conn.trust, fingerprint: conn.fingerprint } });
        });
      });
      req.end(payload);
    });
  }

  /** Opens `/eventstream/clip/v2`. `onOpen` fires once the bridge answered
   * 200; `onClose` fires exactly once when the stream ends or fails (not
   * after the returned close function was called). */
  stream(h: {
    onOpen: () => void;
    onEvents: (evs: HueStreamEvent[]) => void;
    onClose: (err: ApiError | null) => void;
  }): () => void {
    let closed = false;
    let destroy: (() => void) | null = null;
    const finish = (err: ApiError | null) => {
      if (closed) return;
      closed = true;
      destroy?.();
      h.onClose(err);
    };
    const what = `bridge ${this.target.bridgeId}: eventstream`;
    this.open(false).then(
      (conn) => {
        if (closed) {
          conn.socket.destroy();
          return;
        }
        conn.socket.setKeepAlive(true, 30_000);
        const req = httpRequest({
          host: conn.host,
          port: conn.port,
          method: "GET",
          path: "/eventstream/clip/v2",
          createConnection: () => conn.socket,
          headers: this.headers({ accept: "text/event-stream" }),
        });
        destroy = () => req.destroy();
        req.on("error", (e) => finish(new ApiError("hue_unreachable", `${what}: ${e.message}`)));
        req.on("response", (res: IncomingMessage) => {
          const status = res.statusCode ?? 0;
          if (status !== 200) {
            res.resume();
            return finish(
              status === 401 || status === 403
                ? new ApiError("not_linked", `${what}: the bridge rejected our application key`)
                : new ApiError("hue_unreachable", `${what}: HTTP ${status}`),
            );
          }
          h.onOpen();
          let buf = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => {
            buf += chunk;
            let i: number;
            while ((i = buf.search(/\r?\n\r?\n/)) >= 0) {
              const block = buf.slice(0, i);
              buf = buf.slice(i).replace(/^\r?\n\r?\n/, "");
              const data = block
                .split(/\r?\n/)
                .filter((l) => l.startsWith("data:"))
                .map((l) => l.slice(5).replace(/^ /, ""))
                .join("\n");
              if (!data) continue;
              try {
                const parsed = JSON.parse(data) as HueStreamEvent[];
                if (!closed && Array.isArray(parsed)) h.onEvents(parsed);
              } catch {
                // ignore a malformed message; the next resync fixes the cache
              }
            }
          });
          res.on("error", (e) => finish(new ApiError("hue_unreachable", `${what}: ${e.message}`)));
          res.on("close", () => finish(new ApiError("hue_unreachable", `${what}: stream ended`)));
        });
        req.end();
      },
      (e: unknown) => finish(e instanceof ApiError ? e : new ApiError("hue_unreachable", `${what}: ${String(e)}`)),
    );
    return () => {
      if (closed) return;
      closed = true;
      destroy?.();
    };
  }
}
