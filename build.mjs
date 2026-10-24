// Bundles src/main.ts into ONE file, dist/homekit-bridge.mjs, runnable with
// system node (>= 20). The BLE stack hap-controller can pull in is never
// imported (src/hap.ts uses the IP-only modules); it is also marked
// external so a stray import could never drag a native addon in.
import { build } from "esbuild";
import { chmodSync, readFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
const outfile = "dist/homekit-bridge.mjs";

await build({
  entryPoints: ["src/main.ts"],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  minify: false,
  legalComments: "eof",
  // dnssd's ResourceRecord.clone() looks the subclass up by
  // `this.constructor.name`; esbuild's scope-hoisting renames (PTR -> PTR2)
  // made every mDNS known-answer query throw and kill the daemon.
  keepNames: true,
  external: ["@stoprocent/noble", "@abandonware/noble", "noble"],
  define: { __HOMEKIT_BRIDGE_VERSION__: JSON.stringify(version) },
  banner: {
    // Shebang, plus `require` / `__filename` / `__dirname` for the CJS
    // dependencies esbuild wraps (dnssd reads __filename at load time).
    js: [
      "#!/usr/bin/env node",
      'import { createRequire as __hkbCreateRequire } from "node:module";',
      'import { fileURLToPath as __hkbFileURLToPath } from "node:url";',
      'import { dirname as __hkbDirname } from "node:path";',
      "const require = __hkbCreateRequire(import.meta.url);",
      "const __filename = __hkbFileURLToPath(import.meta.url);",
      "const __dirname = __hkbDirname(__filename);",
    ].join("\n"),
  },
  logLevel: "info",
});
chmodSync(outfile, 0o755);
