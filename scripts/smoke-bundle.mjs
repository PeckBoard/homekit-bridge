#!/usr/bin/env node
// DEV ONLY: boots dist/homekit-bridge.mjs (the release artifact) and the
// fake accessory as separate processes, then pairs / writes / unpairs over
// HTTP. `npm run smoke` after `npm run build`.
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const here = new URL("..", import.meta.url).pathname;
const port = 20000 + Math.floor(Math.random() * 10000);
const token = "smoke-token-0123456789abcdef";
const procs = [];
const done = (code) => {
  for (const p of procs) p.kill("SIGTERM");
  process.exit(code);
};

const fake = spawn(process.execPath, [join(here, "scripts/fake-accessory.mjs"), "--port", "0", "--storage", mkdtempSync(join(tmpdir(), "hk-smoke-fake-"))], { stdio: ["pipe", "pipe", "inherit"] });
procs.push(fake);
const info = await new Promise((resolve) => createInterface({ input: fake.stdout }).once("line", (l) => resolve(JSON.parse(l))));

const bridge = spawn(
  process.execPath,
  [join(here, "dist/homekit-bridge.mjs"), "--bind", `127.0.0.1:${port}`, "--token", token, "--data-dir", mkdtempSync(join(tmpdir(), "hk-smoke-"))],
  { stdio: "inherit" },
);
bridge.on("exit", (code, sig) => {
  console.log(`FAIL bridge exited (${code ?? sig})`);
  done(1);
});
setTimeout(() => {
  console.log("FAIL smoke timed out");
  done(1);
}, 60_000).unref();
procs.push(bridge);

const api = async (method, path, body) => {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body && JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
};
const check = (ok, what, detail) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) {
    console.log(JSON.stringify(detail, null, 2));
    done(1);
  }
};

for (let i = 0; ; i++) {
  try {
    await api("GET", "/health");
    break;
  } catch {
    if (i > 50) check(false, "bridge came up");
    await new Promise((r) => setTimeout(r, 100));
  }
}
const health = await api("GET", "/health");
check(health.body.ok && health.body.paired === 0, `/health ${JSON.stringify(health.body)}`, health);

const paired = await api("POST", "/devices/pair", { id: info.id, setup_code: info.setup_code, address: "127.0.0.1", port: info.port });
check(paired.status === 201 && paired.body.connected, "pair (manual add)", paired);

const chars = paired.body.accessories.flatMap((a) => a.services.flatMap((s) => s.characteristics.map((c) => ({ aid: a.aid, ...c }))));
const on = chars.find((c) => c.type === "on");
const set = await api("POST", `/devices/${encodeURIComponent(info.id)}/characteristics`, { set: [{ aid: on.aid, iid: on.iid, value: true }] });
check(set.status === 200 && set.body.device.accessories.some((a) => a.services.some((s) => s.characteristics.some((c) => c.type === "on" && c.value === true))), "set on=true", set);

const del = await api("DELETE", `/devices/${encodeURIComponent(info.id)}`);
check(del.body.removed_from_accessory === true, "unpair", del);
const disc = await api("GET", "/discover");
check(Array.isArray(disc.body.accessories), `/discover (${disc.body.accessories?.length} seen via mDNS)`, disc);
// mDNS re-queries carry known answers, which clone cached records by class
// name — a bundling rename used to crash the daemon here. Let a few rounds run.
for (let i = 0; i < 3; i++) await api("GET", "/discover?refresh=1");
const alive = await api("GET", "/health");
check(bridge.exitCode === null && alive.body.ok === true, "still alive after mDNS re-queries", alive);

// Philips Hue: link (button press via the fake's stdin), list, write, unlink.
const hueFake = spawn(process.execPath, [join(here, "scripts/fake-hue-bridge.mjs"), "--port", "0"], { stdio: ["pipe", "pipe", "inherit"] });
procs.push(hueFake);
const hue = await new Promise((resolve) => createInterface({ input: hueFake.stdout }).once("line", (l) => resolve(JSON.parse(l))));
const linkBody = { bridge_id: hue.bridge_id, address: `${hue.address}:${hue.port}` };
const early = await api("POST", "/hue/link", linkBody);
check(early.status === 409 && early.body.code === "link_button_not_pressed", "hue link refused before button press", early);
hueFake.stdin.write("press\n");
await new Promise((r) => setTimeout(r, 200));
const linked = await api("POST", "/hue/link", linkBody);
check(linked.status === 201 && linked.body.linked && linked.body.lights === 2, "hue link after button press", linked);
const hueLight = (await api("GET", "/devices")).body.devices.find((d) => d.source === "hue" && d.room === "Living room");
check(!!hueLight, "hue light listed with room", hueLight);
const hueSet = await api("POST", `/devices/${encodeURIComponent(hueLight.id)}/characteristics`, { set: [{ aid: 1, iid: 11, value: 30 }] });
const bri = hueSet.body.device?.accessories[0].services.flatMap((s) => s.characteristics).find((c) => c.iid === 11);
check(hueSet.status === 200 && bri?.value === 30, "hue set brightness=30", hueSet);
const unlinked = await api("DELETE", `/hue/bridges/${hue.bridge_id}`);
check(unlinked.body.ok === true, "hue unlink", unlinked);
hueFake.stdin.end(); // EOF: the fake must exit on its own
const hueExit = await Promise.race([new Promise((r) => hueFake.once("exit", () => r(true))), new Promise((r) => setTimeout(() => r(false), 5000))]);
check(hueExit, "fake hue bridge exits on stdin EOF");
done(0);
