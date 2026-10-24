#!/usr/bin/env node
// DEV ONLY (never bundled): a fake Philips Hue Bridge speaking just enough
// CLIP v2 for homekit-bridge and the Peckboard homekit plugin to be tested
// without hardware: HTTPS with a self-signed cert (CN = bridge id, like old
// bridge firmware, so the daemon pins it on link), POST /api link flow,
// /clip/v2/resource, PUT on lights / grouped_light / scene / device and an
// /eventstream/clip/v2 SSE stream. Resources: 2 lights in room "Living room",
// zone "Reading" (light 1), scene "Relax".
//
//   node scripts/fake-hue-bridge.mjs [--port 0] [--host 127.0.0.1] [--advertise]
//
// Prints one JSON line {"bridge_id","address","port"}. Link with
//   POST /hue/link {"bridge_id": <bridge_id>, "address": "<address>:<port>"}
// It answers 101 (link button not pressed) until you type `press` + Enter.
// Other stdin commands: `on <1|2>`, `off <1|2>`, `b <1|2> <0-100>`, `drop`
// (ends every event stream). Exits on stdin EOF and after 15 minutes.
// mDNS advertising is OFF unless --advertise is given: it would show up in
// real Discover lists on the LAN.
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:https";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

export const FAKE_BRIDGE_ID = "001788fffe00beef";

// Self-signed, CN=001788fffe00beef, valid until 2126. Test-only key.
const CERT = `-----BEGIN CERTIFICATE-----
MIIB1DCCAXmgAwIBAgIUSpM80EMUM0zMaQiR7O06mkYNTCMwCgYIKoZIzj0EAwIw
PjELMAkGA1UEBhMCTkwxFDASBgNVBAoMC1BoaWxpcHMgSHVlMRkwFwYDVQQDDBAw
MDE3ODhmZmZlMDBiZWVmMCAXDTI2MTAyNDA1MTg1NloYDzIxMjYwOTMwMDUxODU2
WjA+MQswCQYDVQQGEwJOTDEUMBIGA1UECgwLUGhpbGlwcyBIdWUxGTAXBgNVBAMM
EDAwMTc4OGZmZmUwMGJlZWYwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAAScsLn6
rfsnYGA4pKT9sF9SnNwTUBmsw8rSUoa3+13wPLsVrlpxuMtc7f/9qSzwr45VUIlw
BApeFHRFXfaiD8Cso1MwUTAdBgNVHQ4EFgQU43QJ5lLfBMdb3ud5hyWAy0aeqk0w
HwYDVR0jBBgwFoAU43QJ5lLfBMdb3ud5hyWAy0aeqk0wDwYDVR0TAQH/BAUwAwEB
/zAKBggqhkjOPQQDAgNJADBGAiEAwSb9tXwwkhxNkMZIx0vwAbtY63bEq28DBAXd
tr150EkCIQCijO/MrwGmcESC43zFs45rptSYiWOWCEP62+w2tmLLzw==
-----END CERTIFICATE-----`;
const KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg4bKLzS4wsZKsmR7D
T9wd7x2HebAoME2W2rDaauI+ce2hRANCAAScsLn6rfsnYGA4pKT9sF9SnNwTUBms
w8rSUoa3+13wPLsVrlpxuMtc7f/9qSzwr45VUIlwBApeFHRFXfaiD8Cs
-----END PRIVATE KEY-----`;

const id = (prefix, n) => `${prefix}000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const FAKE_IDS = {
  bridgeDevice: id("b0", 1),
  bridge: id("b0", 2),
  devices: [id("d1", 1), id("d1", 2)],
  lights: [id("11", 1), id("11", 2)],
  zigbee: [id("2b", 1), id("2b", 2)],
  room: id("a0", 1),
  zone: id("a0", 2),
  roomGroupedLight: id("9a", 1),
  zoneGroupedLight: id("9a", 2),
  scene: id("5c", 1),
};

function initialResources() {
  const I = FAKE_IDS;
  const ref = (rid, rtype) => ({ rid, rtype });
  const gamutC = { red: { x: 0.6915, y: 0.3083 }, green: { x: 0.17, y: 0.7 }, blue: { x: 0.1532, y: 0.0475 } };
  const res = [
    {
      id: I.bridgeDevice,
      type: "device",
      product_data: { model_id: "BSB002", manufacturer_name: "Signify Netherlands B.V.", product_name: "Hue Bridge", software_version: "1.70.0" },
      metadata: { name: "Fake Hue Bridge", archetype: "bridge_v2" },
      services: [ref(I.bridge, "bridge")],
    },
    { id: I.bridge, type: "bridge", bridge_id: FAKE_BRIDGE_ID, owner: ref(I.bridgeDevice, "device") },
  ];
  const names = ["Sofa lamp", "Ceiling"];
  for (const i of [0, 1]) {
    res.push({
      id: I.devices[i],
      type: "device",
      product_data: {
        model_id: i === 0 ? "LCA001" : "LTA001",
        manufacturer_name: "Signify Netherlands B.V.",
        product_name: i === 0 ? "Hue color lamp" : "Hue ambiance lamp",
        software_version: "1.104.2",
      },
      metadata: { name: names[i], archetype: "sultan_bulb" },
      services: [ref(I.lights[i], "light"), ref(I.zigbee[i], "zigbee_connectivity")],
    });
    res.push({
      id: I.zigbee[i],
      type: "zigbee_connectivity",
      owner: ref(I.devices[i], "device"),
      status: "connected",
      mac_address: `00:17:88:01:00:00:00:0${i + 1}`,
    });
    const light = {
      id: I.lights[i],
      type: "light",
      owner: ref(I.devices[i], "device"),
      metadata: { name: names[i], archetype: "sultan_bulb" },
      on: { on: false },
      dimming: { brightness: 50, min_dim_level: 0.2 },
      color_temperature: { mirek: 366, mirek_valid: true, mirek_schema: { mirek_minimum: 153, mirek_maximum: 500 } },
      mode: "normal",
    };
    if (i === 0) light.color = { xy: { x: 0.4573, y: 0.41 }, gamut: gamutC, gamut_type: "C" };
    res.push(light);
  }
  res.push(
    {
      id: I.room,
      type: "room",
      metadata: { name: "Living room", archetype: "living_room" },
      children: I.devices.map((d) => ref(d, "device")),
      services: [ref(I.roomGroupedLight, "grouped_light")],
    },
    {
      id: I.zone,
      type: "zone",
      metadata: { name: "Reading", archetype: "reading" },
      children: [ref(I.lights[0], "light")],
      services: [ref(I.zoneGroupedLight, "grouped_light")],
    },
    { id: I.roomGroupedLight, type: "grouped_light", owner: ref(I.room, "room"), on: { on: false }, dimming: { brightness: 50 } },
    { id: I.zoneGroupedLight, type: "grouped_light", owner: ref(I.zone, "zone"), on: { on: false }, dimming: { brightness: 50 } },
    {
      id: I.scene,
      type: "scene",
      metadata: { name: "Relax" },
      group: ref(I.room, "room"),
      actions: [
        { target: ref(I.lights[0], "light"), action: { on: { on: true }, dimming: { brightness: 30 }, color: { xy: { x: 0.5, y: 0.4 } } } },
        { target: ref(I.lights[1], "light"), action: { on: { on: true }, dimming: { brightness: 30 }, color_temperature: { mirek: 447 } } },
      ],
      status: { active: "inactive" },
    },
  );
  return new Map(res.map((r) => [r.id, r]));
}

/** Starts the fake bridge; resolves once it is listening. */
export async function startFakeHueBridge({ port = 0, host = "127.0.0.1", advertise = false } = {}) {
  const resources = initialResources();
  const appKeys = new Set();
  const streams = new Set();
  const commands = [];
  const identified = [];
  let pressedUntil = 0;

  const emit = (type, data) => {
    const msg = [{ creationtime: new Date().toISOString(), id: randomUUID(), type, data }];
    const frame = `id: ${Math.floor(Date.now() / 1000)}:0\ndata: ${JSON.stringify(msg)}\n\n`;
    for (const s of streams) s.write(frame);
  };

  /** Applies a light-shaped change; returns the partial for the event. */
  const applyLight = (light, body) => {
    const delta = { id: light.id, type: "light", owner: light.owner };
    if (body.on) light.on = delta.on = { on: !!body.on.on };
    if (body.dimming?.brightness != null) {
      light.dimming.brightness = Math.max(light.dimming.min_dim_level ?? 0, Number(body.dimming.brightness));
      delta.dimming = { brightness: light.dimming.brightness };
    }
    if (body.color?.xy && light.color) {
      light.color.xy = { x: Number(body.color.xy.x), y: Number(body.color.xy.y) };
      delta.color = { xy: light.color.xy };
      if (light.color_temperature) {
        light.color_temperature.mirek = null;
        light.color_temperature.mirek_valid = false;
        delta.color_temperature = { mirek: null, mirek_valid: false };
      }
    }
    if (body.color_temperature?.mirek != null && light.color_temperature) {
      light.color_temperature.mirek = Number(body.color_temperature.mirek);
      light.color_temperature.mirek_valid = true;
      delta.color_temperature = { mirek: light.color_temperature.mirek, mirek_valid: true };
    }
    return delta;
  };

  const groupLights = (group) =>
    group.children.flatMap((c) =>
      c.rtype === "light" ? [c.rid] : (resources.get(c.rid)?.services ?? []).filter((s) => s.rtype === "light").map((s) => s.rid),
    );

  const syncGroupedLights = () => {
    const out = [];
    for (const r of resources.values()) {
      if (r.type !== "grouped_light") continue;
      const lights = groupLights(resources.get(r.owner.rid)).map((rid) => resources.get(rid));
      const on = lights.some((l) => l.on.on);
      const lit = lights.filter((l) => l.on.on);
      const bri = lit.length ? lit.reduce((a, l) => a + l.dimming.brightness, 0) / lit.length : 0;
      if (r.on.on !== on || r.dimming.brightness !== bri) {
        r.on = { on };
        r.dimming = { brightness: bri };
        out.push({ id: r.id, type: "grouped_light", owner: r.owner, on: r.on, dimming: r.dimming });
      }
    }
    return out;
  };

  const json = (res, status, body) => {
    const data = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(data) });
    res.end(data);
  };
  const clip = (res, status, data, errors = []) => json(res, status, { errors, data });

  const server = createServer({ cert: CERT, key: KEY }, async (req, res) => {
    const url = new URL(req.url ?? "/", "https://bridge");
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let body = {};
    try {
      body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    } catch {
      return clip(res, 400, [], [{ description: "body contains invalid JSON" }]);
    }

    if (req.method === "POST" && url.pathname === "/api") {
      if (Date.now() > pressedUntil) {
        return json(res, 200, [{ error: { type: 101, address: "", description: "link button not pressed" } }]);
      }
      const username = randomBytes(20).toString("hex");
      appKeys.add(username);
      return json(res, 200, [{ success: { username, clientkey: randomBytes(16).toString("hex").toUpperCase() } }]);
    }
    // Real bridges answer the public config without a key (name, ids, model).
    if (req.method === "GET" && url.pathname === "/api/0/config") {
      return json(res, 200, { name: "Fake Hue Bridge", bridgeid: FAKE_BRIDGE_ID.toUpperCase(), modelid: "BSB002", swversion: "1967054020", apiversion: "1.67.0" });
    }
    if (!appKeys.has(req.headers["hue-application-key"])) {
      return clip(res, 403, [], [{ description: "unauthorized user" }]);
    }
    if (req.method === "GET" && url.pathname === "/eventstream/clip/v2") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write(": hi\n\n");
      streams.add(res);
      res.on("close", () => streams.delete(res));
      return;
    }
    const m = /^\/clip\/v2\/resource(?:\/([a-z_]+)(?:\/([0-9a-f-]+))?)?$/.exec(url.pathname);
    if (!m) return clip(res, 404, [], [{ description: "not found" }]);
    const [, type, rid] = m;
    if (req.method === "GET") {
      const all = [...resources.values()].filter((r) => (!type || r.type === type) && (!rid || r.id === rid));
      if (rid && !all.length) return clip(res, 404, [], [{ description: "Not Found" }]);
      return clip(res, 200, structuredClone(all));
    }
    if (req.method !== "PUT" || !rid) return clip(res, 405, [], [{ description: "method not allowed" }]);
    const target = resources.get(rid);
    if (!target || target.type !== type) return clip(res, 404, [], [{ description: "Not Found" }]);
    commands.push({ type, rid, body, at: Date.now() });
    const changed = [];
    if (type === "light") {
      if (body.dimming?.brightness != null && (body.dimming.brightness < 0 || body.dimming.brightness > 100)) {
        return clip(res, 400, [], [{ description: "dimming.brightness out of range" }]);
      }
      changed.push(applyLight(target, body));
    } else if (type === "grouped_light") {
      for (const lrid of groupLights(resources.get(target.owner.rid))) {
        changed.push(applyLight(resources.get(lrid), { on: body.on, dimming: body.dimming }));
      }
    } else if (type === "scene") {
      if (body.recall?.action) {
        for (const a of target.actions) changed.push(applyLight(resources.get(a.target.rid), a.action));
        target.status = { active: "static" };
        changed.push({ id: target.id, type: "scene", status: target.status });
      }
    } else if (type === "device") {
      if (body.identify?.action === "identify") identified.push(rid);
    } else {
      return clip(res, 405, [], [{ description: `PUT not supported on ${type}` }]);
    }
    changed.push(...syncGroupedLights());
    clip(res, 200, [{ rid, rtype: type }]);
    if (changed.length) setTimeout(() => emit("update", changed), 20);
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const actualPort = server.address().port;

  let ad = null;
  if (advertise) {
    const dnssd = createRequire(import.meta.url)("dnssd");
    ad = new dnssd.Advertisement(new dnssd.ServiceType("_hue._tcp"), actualPort, {
      name: `Fake Hue Bridge - ${FAKE_BRIDGE_ID.slice(-6).toUpperCase()}`,
      txt: { bridgeid: FAKE_BRIDGE_ID, modelid: "BSB002" },
    });
    ad.on("error", (e) => process.stderr.write(`mDNS advertise error: ${e.message}\n`));
    ad.start();
  }

  return {
    bridgeId: FAKE_BRIDGE_ID,
    address: host,
    port: actualPort,
    ids: FAKE_IDS,
    resources,
    commands,
    identified,
    /** The link button: POST /api succeeds for the next 30 s. */
    pressButton() {
      pressedUntil = Date.now() + 30_000;
    },
    /** Bridge-side change (a wall switch, the Hue app), pushed on the stream
     * unless `silent`. */
    setLight(n, body, { silent = false } = {}) {
      const changed = [applyLight(resources.get(FAKE_IDS.lights[n]), body), ...syncGroupedLights()];
      if (!silent) emit("update", changed);
    },
    /** Ends every event stream (the daemon must reconnect and resync). */
    dropStreams() {
      for (const s of streams) s.destroy();
      streams.clear();
    },
    async stop() {
      try {
        ad?.stop();
      } catch {
        // ignore
      }
      for (const s of streams) s.destroy();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { values } = parseArgs({
    options: {
      port: { type: "string", default: "0" },
      host: { type: "string", default: "127.0.0.1" },
      advertise: { type: "boolean", default: false },
    },
  });
  const fake = await startFakeHueBridge({ port: Number(values.port), host: values.host, advertise: values.advertise });
  process.stdout.write(JSON.stringify({ bridge_id: fake.bridgeId, address: fake.address, port: fake.port }) + "\n");
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    fake.stop().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  createInterface({ input: process.stdin })
    .on("line", (line) => {
      const [cmd, a, b] = line.trim().split(/\s+/);
      const n = Number(a) - 1;
      if (cmd === "press") {
        fake.pressButton();
        process.stderr.write("link button pressed (30 s)\n");
      } else if (cmd === "on" || cmd === "off") fake.setLight(n, { on: { on: cmd === "on" } });
      else if (cmd === "b") fake.setLight(n, { dimming: { brightness: Number(b) } });
      else if (cmd === "drop") fake.dropStreams();
      else if (cmd) process.stderr.write("commands: press | on <1|2> | off <1|2> | b <1|2> <0-100> | drop\n");
    })
    // stdin EOF = whoever spawned us is gone. Never linger (and never keep
    // advertising) on the user's LAN.
    .on("close", stop);
  // Hard cap for the same reason, in case stdin is held open by an orphan.
  setTimeout(stop, 15 * 60 * 1000).unref();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
