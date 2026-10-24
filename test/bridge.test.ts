// End-to-end against a REAL HAP accessory (hap-nodejs, in-process): pair →
// list → write → re-read → HAP event on /events → restart → unpair.
import { mkdtempSync, statSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiServer } from "../src/api.js";
import { Bridge } from "../src/bridge.js";
import { setQuiet } from "../src/log.js";
// @ts-expect-error plain .mjs dev script
import { startFakeAccessory } from "../scripts/fake-accessory.mjs";

const TOKEN = "test-token-0123456789abcdef";
const ON = "00000025-0000-1000-8000-0026BB765291";
const BRIGHTNESS = "00000008-0000-1000-8000-0026BB765291";
const CURRENT_TEMP = "00000011-0000-1000-8000-0026BB765291";

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

async function api(method: string, path: string, body?: unknown, token = TOKEN) {
  const res = await fetch(base + path, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Json };
}

function findChar(device: Json, typeUuid: string) {
  for (const a of device.accessories) {
    for (const s of a.services) {
      const c = s.characteristics.find((c: Json) => c.type_uuid === typeUuid);
      if (c) return { aid: a.aid as number, ...c };
    }
  }
  throw new Error(`no ${typeUuid}`);
}

beforeAll(async () => {
  setQuiet(!process.env.HKB_VERBOSE);
  fake = await startFakeAccessory({ port: 0, advertise: false });
  dataDir = mkdtempSync(join(tmpdir(), "hkb-test-"));
  await startBridge();
}, 30_000);

afterAll(async () => {
  await stopBridge();
  await fake?.stop();
});

describe("homekit-bridge against a hap-nodejs accessory", () => {
  const devPath = () => `/devices/${encodeURIComponent(fake.id)}`;

  it("rejects a missing token and reports health", async () => {
    expect((await api("GET", "/health", undefined, "wrong-token-wrong-token")).body.code).toBe("unauthorized");
    const h = await api("GET", "/health");
    expect(h.body).toMatchObject({ ok: true, paired: 0, connected: 0 });
  });

  it("refuses a wrong setup code, then pairs with the right one", async () => {
    const manual = { id: fake.id, address: "127.0.0.1", port: fake.port };
    const bad = await api("POST", "/devices/pair", { ...manual, setup_code: "111-22-333" });
    expect(bad.body).toMatchObject({ code: "bad_setup_code" });
    expect(bad.status).toBe(400);

    const res = await api("POST", "/devices/pair", { ...manual, setup_code: fake.setupCode.replace(/-/g, ""), name: "Desk lamp" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      id: fake.id,
      name: "Desk lamp",
      accessory_name: expect.stringMatching(/^Fake Light/),
      manufacturer: "Peckboard",
      category_name: "lighting",
      connected: true,
    });
    const types = res.body.accessories[0].services.map((s: Json) => s.type);
    expect(types).toEqual(expect.arrayContaining(["accessory-information", "lightbulb", "temperature-sensor"]));
    expect(findChar(res.body, ON)).toMatchObject({ type: "on", format: "bool", value: false });
    expect(findChar(res.body, BRIGHTNESS)).toMatchObject({ type: "brightness", min: 0, max: 100, unit: "percentage" });
    expect(findChar(res.body, CURRENT_TEMP)).toMatchObject({ type: "current-temperature", value: 21.5 });
    expect(findChar(res.body, CURRENT_TEMP).perms).not.toContain("pw");
    expect(fake.isPaired()).toBe(true);

    expect(statSync(join(dataDir, "pairings.json")).mode & 0o777).toBe(0o600);
    expect((await api("POST", "/devices/pair", { ...manual, setup_code: fake.setupCode })).body.code).toBe(
      "already_paired",
    );
    const list = await api("GET", "/devices");
    expect(list.body.devices.map((d: Json) => d.id)).toEqual([fake.id]);
  }, 30_000);

  it("writes on + brightness and returns re-read values", async () => {
    const dev = (await api("GET", devPath())).body;
    const on = findChar(dev, ON);
    const br = findChar(dev, BRIGHTNESS);
    const res = await api("POST", `${devPath()}/characteristics`, {
      set: [
        { aid: on.aid, iid: on.iid, value: true },
        { aid: br.aid, iid: br.iid, value: 80 },
      ],
    });
    expect(res.status).toBe(200);
    expect(findChar(res.body.device, ON).value).toBe(true);
    expect(findChar(res.body.device, BRIGHTNESS).value).toBe(80);
    expect(fake.state).toMatchObject({ on: true, brightness: 80 });

    // Accessory-side change, then an explicit refresh re-reads it.
    fake.state.brightness = 33;
    const refreshed = await api("GET", `${devPath()}?refresh=1`);
    expect(findChar(refreshed.body, BRIGHTNESS).value).toBe(33);

    const tooBright = await api("POST", `${devPath()}/characteristics`, {
      set: [{ aid: br.aid, iid: br.iid, value: 150 }],
    });
    expect(tooBright.body.code).toBe("invalid_value");
    const t = findChar(dev, CURRENT_TEMP);
    const ro = await api("POST", `${devPath()}/characteristics`, { set: [{ aid: t.aid, iid: t.iid, value: 30 }] });
    expect(ro.body.code).toBe("read_only");

    expect((await api("POST", `${devPath()}/identify`)).body).toEqual({ ok: true });
  }, 30_000);

  it("delivers HAP events on /events", async () => {
    const start = (await api("GET", "/events")).body.seq as number;
    const onIid = findChar((await api("GET", devPath())).body, ON).iid;
    const pending = api("GET", `/events?since=${start}`);
    await new Promise((r) => setTimeout(r, 100));
    fake.setOn(false);
    const { body } = await pending;
    expect(body.seq).toBeGreaterThan(start);
    expect(body.events).toContainEqual(
      expect.objectContaining({ id: fake.id, kind: "value", aid: 1, iid: onIid, value: false }),
    );
    expect(findChar((await api("GET", devPath())).body, ON).value).toBe(false);
  }, 30_000);

  async function waitConnected(n: number) {
    const deadline = Date.now() + 15_000;
    while ((await api("GET", "/health")).body.connected !== n && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect((await api("GET", "/health")).body).toMatchObject({ paired: 1, connected: n });
  }

  it("reconnects from pairings.json after a bridge restart", async () => {
    await stopBridge();
    await startBridge();
    const listed = (await api("GET", "/devices")).body.devices;
    expect(listed[0]).toMatchObject({ id: fake.id, name: "Desk lamp", accessory_name: expect.stringMatching(/^Fake Light/) });
    await waitConnected(1);
  }, 30_000);

  it("reconnects after the accessory restarts", async () => {
    const { port, storageDir } = fake;
    await fake.stop({ keepPairing: true });
    await waitConnected(0);
    fake = await startFakeAccessory({ port, storageDir, advertise: false });
    await waitConnected(1);
    const ev = (await api("GET", "/events")).body.events;
    expect(ev.filter((e: Json) => e.kind === "connection").map((e: Json) => e.connected).slice(-2)).toEqual([false, true]);
  }, 30_000);

  it("unpairs on the accessory and forgets the device", async () => {
    const res = await api("DELETE", devPath());
    expect(res.body).toEqual({ ok: true, removed_from_accessory: true });
    expect(fake.isPaired()).toBe(false);
    expect((await api("GET", "/devices")).body.devices).toEqual([]);
    expect((await api("GET", devPath())).body.code).toBe("not_found");
  }, 30_000);
});
