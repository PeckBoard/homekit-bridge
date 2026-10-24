#!/usr/bin/env node
// DEV ONLY (never bundled): a real HAP accessory served by hap-nodejs — a
// Lightbulb (on, brightness) plus a read-only TemperatureSensor — so the
// bridge and the Peckboard homekit plugin can be tested without hardware.
//
//   node scripts/fake-accessory.mjs [--port 51826] [--pin 031-45-154]
//        [--id AA:BB:CC:DD:EE:01] [--name "Fake Light"] [--storage <dir>]
//
// Prints one JSON line: {"id","setup_code","port","address","name"}. Pair it
// with POST /devices/pair using address 127.0.0.1 and that port. While it
// runs, type `on`, `off`, `b <0-100>` or `t <celsius>` + Enter to change
// state from the accessory side (exercises HAP events).
import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

/** Starts the fake accessory; resolves once it is listening. */
export async function startFakeAccessory({
  port = 0,
  pincode = "031-45-154",
  username = "AA:BB:CC:DD:EE:01",
  name = "Fake Light",
  storageDir = mkdtempSync(join(tmpdir(), "hk-fake-")),
  advertise = true,
} = {}) {
  const hap = require("hap-nodejs");
  const { Accessory, Service, Characteristic, Categories, HAPStorage, MDNSAdvertiser, uuid } = hap;
  // HAPStorage is a process-wide singleton: the path can be set only once,
  // so a restart in the same process (tests) keeps the first one.
  if (!startFakeAccessory.storageDir) {
    HAPStorage.setCustomStoragePath(storageDir);
    startFakeAccessory.storageDir = storageDir;
  }
  storageDir = startFakeAccessory.storageDir;

  const state = { on: false, brightness: 50, temperature: 21.5 };
  const accessory = new Accessory(name, uuid.generate(`homekit-bridge-fake:${username}`));
  accessory
    .getService(Service.AccessoryInformation)
    .setCharacteristic(Characteristic.Manufacturer, "Peckboard")
    .setCharacteristic(Characteristic.Model, "Fake Light 1")
    .setCharacteristic(Characteristic.SerialNumber, username.replace(/:/g, ""))
    .setCharacteristic(Characteristic.FirmwareRevision, "1.0.0");

  const light = accessory.addService(Service.Lightbulb, name);
  light
    .getCharacteristic(Characteristic.On)
    .onGet(() => state.on)
    .onSet((v) => {
      state.on = !!v;
    });
  light
    .getCharacteristic(Characteristic.Brightness)
    .onGet(() => state.brightness)
    .onSet((v) => {
      state.brightness = Number(v);
    });

  const sensor = accessory.addService(Service.TemperatureSensor, `${name} Temperature`);
  sensor.getCharacteristic(Characteristic.CurrentTemperature).onGet(() => state.temperature);

  const identified = [];
  accessory.on("identify", (paired, cb) => {
    identified.push(paired);
    cb();
  });

  const listening = new Promise((resolve) => accessory.once("listening", (p) => resolve(p)));
  await accessory.publish({
    username,
    pincode,
    port,
    category: Categories.LIGHTBULB,
    // advertise=false binds server + mDNS responder to loopback only (tests).
    advertiser: MDNSAdvertiser.CIAO,
    ...(advertise ? {} : { bind: "127.0.0.1" }),
  });
  const actualPort = await listening;

  return {
    id: username,
    setupCode: pincode,
    port: actualPort,
    name,
    storageDir,
    state,
    identified,
    accessory,
    /** Change state from the accessory side (pushes HAP events). */
    setOn(v) {
      state.on = v;
      light.getCharacteristic(Characteristic.On).updateValue(v);
    },
    setBrightness(v) {
      state.brightness = v;
      light.getCharacteristic(Characteristic.Brightness).updateValue(v);
    },
    setTemperature(v) {
      state.temperature = v;
      sensor.getCharacteristic(Characteristic.CurrentTemperature).updateValue(v);
    },
    isPaired: () => accessory._accessoryInfo?.paired() ?? false,
    /** Stop serving. `keepPairing` leaves the persisted keys so a new
     * startFakeAccessory() with the same id + storage comes back paired
     * (a power cycle); otherwise the accessory is wiped. */
    async stop({ keepPairing = false } = {}) {
      await accessory.unpublish();
      if (!keepPairing) await accessory.destroy();
    },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { values } = parseArgs({
    options: {
      port: { type: "string", default: "51826" },
      pin: { type: "string", default: "031-45-154" },
      id: { type: "string", default: "AA:BB:CC:DD:EE:01" },
      name: { type: "string", default: "Fake Light" },
      storage: { type: "string" },
    },
  });
  const fake = await startFakeAccessory({
    port: Number(values.port),
    pincode: values.pin,
    username: values.id,
    name: values.name,
    ...(values.storage ? { storageDir: values.storage } : {}),
  });
  process.stdout.write(
    JSON.stringify({ id: fake.id, setup_code: fake.setupCode, port: fake.port, address: "127.0.0.1", name: fake.name }) +
      "\n",
  );
  const stop = () => fake.stop().finally(() => process.exit(0));
  createInterface({ input: process.stdin })
    .on("line", (line) => {
      const [cmd, arg] = line.trim().split(/\s+/);
      if (cmd === "on") fake.setOn(true);
      else if (cmd === "off") fake.setOn(false);
      else if (cmd === "b") fake.setBrightness(Number(arg));
      else if (cmd === "t") fake.setTemperature(Number(arg));
      else if (cmd) process.stderr.write("commands: on | off | b <0-100> | t <celsius>\n");
    })
    // stdin EOF = the test that spawned us died. Never linger advertising a
    // fake accessory on the user's LAN (it shows up in their Discover tab).
    .on("close", stop);
  // Hard cap for the same reason, in case stdin is held open by an orphan.
  setTimeout(stop, 15 * 60 * 1000).unref();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
