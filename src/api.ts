// HTTP API (BRIDGE_API.md) on node:http.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { Bridge } from "./bridge.js";
import { ApiError } from "./errors.js";
import { log } from "./log.js";
import { VERSION } from "./version.js";

const LONG_POLL_MS = 25_000;
const MAX_BODY = 1 << 20;

function send(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(data),
    "cache-control": "no-store",
  });
  res.end(data);
}

function tokenOk(header: string | undefined, token: string): boolean {
  const m = /^Bearer\s+(.+)$/i.exec(header ?? "");
  if (!m) return false;
  const a = Buffer.from(m[1].trim());
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new ApiError("bad_request", "request body too large");
    chunks.push(c as Buffer);
  }
  if (!size) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ApiError("bad_request", "body is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ApiError("bad_request", "body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

const flag = (u: URL, k: string) => /^(1|true|yes)$/i.test(u.searchParams.get(k) ?? "");

async function route(bridge: Bridge, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const method = req.method ?? "GET";
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);

  if (method === "GET" && url.pathname === "/health") {
    return send(res, 200, { ok: true, version: VERSION, ...bridge.health() });
  }
  if (method === "GET" && url.pathname === "/discover") {
    if (flag(url, "refresh")) await bridge.discovery.refresh(3000);
    return send(res, 200, { accessories: bridge.discover() });
  }
  if (method === "GET" && url.pathname === "/events") {
    const raw = url.searchParams.get("since");
    const since = raw == null || raw === "" ? null : Number(raw);
    if (since != null && !Number.isFinite(since)) throw new ApiError("bad_request", "since must be a number");
    if (since == null) {
      // No cursor yet: hand back what is buffered right away.
      return send(res, 200, { seq: bridge.events.latest, events: bridge.events.since(0) });
    }
    const ac = new AbortController();
    res.on("close", () => ac.abort());
    const events = await bridge.events.wait(since, LONG_POLL_MS, ac.signal);
    if (res.destroyed) return;
    return send(res, 200, { seq: bridge.events.latest, events });
  }
  if (parts[0] === "hue") return routeHue(bridge, req, res, url, method, parts);
  if (parts[0] !== "devices") throw new ApiError("not_found", `no route ${method} ${url.pathname}`);

  if (parts.length === 1) {
    if (method === "GET") {
      return send(res, 200, { devices: bridge.listDevices().map((d) => bridge.toDevice(d)) });
    }
  } else if (parts.length === 2 && parts[1] === "pair") {
    if (method === "POST") {
      const dev = await bridge.pair(await readJson(req));
      return send(res, 201, bridge.toDevice(dev));
    }
  } else if (parts.length === 2) {
    const id = parts[1];
    if (method === "GET") {
      const dev = bridge.get(id);
      if (flag(url, "refresh")) await dev.readAll();
      return send(res, 200, bridge.toDevice(dev));
    }
    if (method === "PATCH") {
      const body = await readJson(req);
      return send(res, 200, bridge.toDevice(bridge.rename(id, body.name)));
    }
    if (method === "DELETE") {
      return send(res, 200, await bridge.unpair(id, flag(url, "force")));
    }
  } else if (parts.length === 3 && parts[2] === "characteristics") {
    if (method === "POST") {
      const dev = bridge.get(parts[1]);
      const body = await readJson(req);
      if (!Array.isArray(body.set) || !body.set.length) {
        throw new ApiError("bad_request", 'body must be {"set": [{"aid", "iid", "value"}, ...]}');
      }
      await dev.write(body.set as { aid: number; iid: number; value: unknown }[]);
      return send(res, 200, { device: bridge.toDevice(dev) });
    }
  } else if (parts.length === 3 && parts[2] === "identify") {
    if (method === "POST") {
      await bridge.get(parts[1]).identify();
      return send(res, 200, { ok: true });
    }
  } else {
    throw new ApiError("not_found", `no route ${method} ${url.pathname}`);
  }
  throw new ApiError("bad_request", `method ${method} not allowed on ${url.pathname}`);
}

/** `/hue/...` (BRIDGE_API.md "Philips Hue"). */
async function routeHue(
  bridge: Bridge,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  method: string,
  parts: string[],
): Promise<void> {
  const hue = bridge.hue;
  const [, a, b, c] = parts;
  if (a === "bridges" && parts.length === 2 && method === "GET") {
    if (flag(url, "refresh")) await hue.discovery.refresh(3000);
    return send(res, 200, { bridges: hue.listBridges() });
  }
  if (a === "bridges" && parts.length === 3 && method === "DELETE") {
    return send(res, 200, hue.unlink(b));
  }
  if (a === "link" && parts.length === 2 && method === "POST") {
    return send(res, 201, await hue.link(await readJson(req)));
  }
  if (a === "groups" && parts.length === 2 && method === "GET") {
    return send(res, 200, { groups: hue.groups() });
  }
  if (a === "groups" && parts.length === 3 && method === "POST") {
    return send(res, 200, await hue.setGroup(b, await readJson(req)));
  }
  if (a === "scenes" && parts.length === 2 && method === "GET") {
    return send(res, 200, { scenes: hue.scenes(url.searchParams.get("group_id")) });
  }
  if (a === "scenes" && parts.length === 4 && c === "recall" && method === "POST") {
    return send(res, 200, await hue.recall(b));
  }
  throw new ApiError("not_found", `no route ${method} ${url.pathname}`);
}

export function createApiServer(bridge: Bridge, token: string): Server {
  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://bridge.local");
    if (!tokenOk(req.headers.authorization, token)) {
      return send(res, 401, { error: "missing or wrong bearer token", code: "unauthorized" });
    }
    route(bridge, req, res, url).catch((e: unknown) => {
      const err =
        e instanceof ApiError
          ? e
          : new ApiError("bad_request", (e as Error)?.message ?? "internal error");
      if (!(e instanceof ApiError)) log.error(`${req.method} ${url.pathname}: ${(e as Error)?.stack ?? String(e)}`);
      if (res.headersSent || res.destroyed) return;
      send(res, err.status, { error: err.message, code: err.code });
    });
  });
}
