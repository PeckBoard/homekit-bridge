// End-to-end against an in-process fake Hue Bridge (HTTPS + CLIP v2 + SSE),
// driven through the daemon's HTTP API: link → lights with room → writes →
// eventstream on /events → reconnect resync → groups → scene → restart →
// unlink.
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiServer } from "../src/api.js";
import { Bridge } from "../src/bridge.js";
import { setQuiet } from "../src/log.js";
// @ts-expect-error plain .mjs dev script
import { startFakeHueBridge } from "../scripts/fake-hue-bridge.mjs";

const TOKEN = "test-token-0123456789abcdef";
type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

let fake: Json;
let dataDir: string;
let bridge: Bridge;
let server: Server;
let base: string;

async function startBridge() {
  bridge = new Bridge({ dataDir, discovery: false, timeoutMs: 5000 });
  bridge.start();
  server = createApiServer(bridge, TOKEN);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function stopBridge() {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await bridge.stop();
}

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Json };
}

const char = (dev: Json, iid: number) =>
  dev.accessories[0].services.flatMap((s: Json) => s.characteristics).find((c: Json) => c.iid === iid);

async function until<T>(f: () => Promise<T>, ok: (v: T) => boolean, ms = 10_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (ok(v) || Date.now() > deadline) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
}

beforeAll(async () => {
  setQuiet(!process.env.HKB_VERBOSE);
  fake = await startFakeHueBridge();
  dataDir = mkdtempSync(join(tmpdir(), "hkb-hue-test-"));
  await startBridge();
});

afterAll(async () => {
  await stopBridge();
  await fake?.stop();
});

describe("Hue bridge support against a fake CLIP v2 bridge", () => {
  const bid = () => fake.bridgeId as string;
  const lightId = (n: number) => `hue:${bid()}:${fake.ids.lights[n]}`;
  const devPath = (n: number) => `/devices/${encodeURIComponent(lightId(n))}`;
  const roomId = () => `${bid()}:${fake.ids.room}`;

  it("links only after the link button is pressed, pinning the self-signed cert", async () => {
    const body = { bridge_id: bid(), address: `127.0.0.1:${fake.port}` };
    const early = await api("POST", "/hue/link", body);
    expect(early.status).toBe(409);
    expect(early.body.code).toBe("link_button_not_pressed");

    fake.pressButton();
    const res = await api("POST", "/hue/link", body);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ bridge_id: bid(), linked: true, connected: true, lights: 2, model: "BSB002", name: "Fake Hue Bridge" });

    const file = join(dataDir, "hue.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const stored = JSON.parse(readFileSync(file, "utf8")).bridges[bid()];
    expect(stored.app_key).toMatch(/^[0-9a-f]{40}$/);
    expect(stored.cert_sha256).toMatch(/^[0-9a-f]{64}$/);

    expect((await api("GET", "/health")).body).toMatchObject({ hue_bridges: 1, hue_linked: 1 });
    expect((await api("GET", "/hue/bridges")).body.bridges).toEqual([expect.objectContaining({ bridge_id: bid(), linked: true })]);
  });

  it("lists the lights as Devices with room and fixed iids", async () => {
    const { devices } = (await api("GET", "/devices")).body;
    expect(devices.map((d: Json) => d.id).sort()).toEqual([lightId(0), lightId(1)].sort());
    const color = devices.find((d: Json) => d.id === lightId(0));
    expect(color).toMatchObject({
      name: "Sofa lamp",
      source: "hue",
      room: "Living room",
      room_id: roomId(),
      category: 5,
      model: "Hue color lamp",
      manufacturer: "Signify Netherlands B.V.",
      connected: true,
    });
    const svc = color.accessories[0].services.find((s: Json) => s.type === "lightbulb");
    expect(svc.characteristics.map((c: Json) => [c.iid, c.type])).toEqual([
      [10, "on"],
      [11, "brightness"],
      [12, "hue"],
      [13, "saturation"],
      [14, "color-temperature"],
    ]);
    expect(char(color, 14)).toMatchObject({ min: 153, max: 500, value: 366 });
    const ambiance = devices.find((d: Json) => d.id === lightId(1));
    expect(ambiance.accessories[0].services[1].characteristics.map((c: Json) => c.iid)).toEqual([10, 11, 14]);
  });

  it("writes brightness + hue/saturation through validation, gamut-clamped", async () => {
    const res = await api("POST", `${devPath(0)}/characteristics`, {
      set: [
        { aid: 1, iid: 11, value: 40 },
        { aid: 1, iid: 12, value: 30 },
        { aid: 1, iid: 13, value: 60 },
      ],
    });
    expect(res.status).toBe(200);
    const dev = res.body.device;
    expect([char(dev, 10).value, char(dev, 11).value, char(dev, 12).value, char(dev, 13).value]).toEqual([true, 40, 30, 60]);
    const light = fake.resources.get(fake.ids.lights[0]);
    expect(light.on.on).toBe(true);
    expect(light.dimming.brightness).toBe(40);
    expect(light.color.xy.x).toBeGreaterThan(0.4);

    // Fully saturated green lies outside gamut C: the bridge is sent the
    // closest point on the gamut edge.
    await api("POST", `${devPath(0)}/characteristics`, { set: [{ aid: 1, iid: 12, value: 120 }, { aid: 1, iid: 13, value: 100 }] });
    const xy = fake.resources.get(fake.ids.lights[0]).color.xy;
    expect(xy.x).toBeGreaterThanOrEqual(0.17);
    expect(xy.y).toBeLessThanOrEqual(0.7);

    const bad = await api("POST", `${devPath(0)}/characteristics`, { set: [{ aid: 1, iid: 11, value: 150 }] });
    expect(bad.body.code).toBe("invalid_value");
    const ct = await api("POST", `${devPath(1)}/characteristics`, { set: [{ aid: 1, iid: 12, value: 10 }] });
    expect(ct.body.code).toBe("not_found");
    expect((await api("POST", `${devPath(1)}/identify`)).body).toEqual({ ok: true });
    expect(fake.identified).toContain(fake.ids.devices[1]);
  });

  it("delivers eventstream updates on /events", async () => {
    const start = (await api("GET", "/events")).body.seq as number;
    const pending = api("GET", `/events?since=${start}`);
    await new Promise((r) => setTimeout(r, 100));
    fake.setLight(1, { dimming: { brightness: 77 } });
    const { body } = await pending;
    expect(body.events).toContainEqual(expect.objectContaining({ id: lightId(1), kind: "value", aid: 1, iid: 11, value: 77 }));
  });

  it("reconnects the stream and resyncs what it missed", async () => {
    fake.dropStreams();
    fake.setLight(1, { on: { on: true } }, { silent: true });
    const dev = await until(
      () => api("GET", devPath(1)),
      (r) => r.body.connected && char(r.body, 10).value === true,
    );
    expect(char(dev.body, 10).value).toBe(true);
    const evs = (await api("GET", "/events")).body.events.filter((e: Json) => e.id === lightId(1));
    expect(evs.filter((e: Json) => e.kind === "connection").map((e: Json) => e.connected).slice(-2)).toEqual([false, true]);
  });

  it("switches a room through its grouped_light and recalls a scene", async () => {
    const { groups } = (await api("GET", "/hue/groups")).body;
    const room = groups.find((g: Json) => g.kind === "room");
    expect(room).toMatchObject({ id: roomId(), name: "Living room", bridge_id: bid() });
    expect(room.device_ids.sort()).toEqual([lightId(0), lightId(1)].sort());
    expect(groups.find((g: Json) => g.kind === "zone")).toMatchObject({ name: "Reading", device_ids: [lightId(0)] });

    const off = await api("POST", `/hue/groups/${encodeURIComponent(roomId())}`, { on: false });
    expect(off.body).toMatchObject({ id: roomId(), on: false });
    expect(fake.ids.lights.map((rid: string) => fake.resources.get(rid).on.on)).toEqual([false, false]);
    const dim = await api("POST", `/hue/groups/${encodeURIComponent(roomId())}`, { brightness: 60 });
    expect(dim.body).toMatchObject({ on: true, brightness: 60 });
    // ≤ 1 group command per second.
    const groupCmds = fake.commands.filter((c: Json) => c.type === "grouped_light");
    expect(groupCmds[1].at - groupCmds[0].at).toBeGreaterThanOrEqual(950);

    const { scenes } = (await api("GET", `/hue/scenes?group_id=${encodeURIComponent(roomId())}`)).body;
    expect(scenes).toEqual([
      { id: `${bid()}:${fake.ids.scene}`, bridge_id: bid(), name: "Relax", group_id: roomId(), group_name: "Living room" },
    ]);
    expect((await api("POST", `/hue/scenes/${encodeURIComponent(scenes[0].id)}/recall`)).body).toEqual({ ok: true });
    expect(fake.resources.get(fake.ids.lights[1]).color_temperature.mirek).toBe(447);
    const dev = await until(
      () => api("GET", devPath(1)),
      (r) => char(r.body, 14).value === 447,
    );
    expect(char(dev.body, 11).value).toBe(30);
  });

  it("renames locally, refuses DELETE on a light, survives a restart", async () => {
    expect((await api("PATCH", devPath(0), { name: "Reading lamp" })).body.name).toBe("Reading lamp");
    const del = await api("DELETE", devPath(0));
    expect(del.status).toBe(400);
    expect(del.body.code).toBe("bad_request");

    await stopBridge();
    await startBridge();
    const dev = await until(
      () => api("GET", devPath(0)),
      (r) => r.status === 200 && r.body.connected,
    );
    expect(dev.body).toMatchObject({ name: "Reading lamp", source: "hue", connected: true });
  });

  it("unlinks and drops the lights", async () => {
    expect((await api("DELETE", `/hue/bridges/${bid()}`)).body).toEqual({ ok: true });
    expect((await api("GET", "/devices")).body.devices).toEqual([]);
    expect((await api("GET", devPath(0))).body.code).toBe("not_found");
    expect((await api("DELETE", `/hue/bridges/${bid()}`)).body.code).toBe("not_linked");
    expect(JSON.parse(readFileSync(join(dataDir, "hue.json"), "utf8")).bridges).toEqual({});
  });

  it("links by address alone, reading the bridge id from /api/0/config", async () => {
    const nothere = await api("POST", "/hue/link", { address: "127.0.0.1:1" });
    expect(nothere.body.code).toBe("hue_unreachable");
    fake.pressButton();
    const res = await api("POST", "/hue/link", { address: `127.0.0.1:${fake.port}` });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ bridge_id: bid(), linked: true });
    expect((await api("DELETE", `/hue/bridges/${bid()}`)).body).toEqual({ ok: true });
  });
});