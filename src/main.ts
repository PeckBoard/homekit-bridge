// homekit-bridge: a HomeKit (HAP over IP) controller behind a small local
// HTTP API. See README.md and BRIDGE_API.md.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createApiServer } from "./api.js";
import { Bridge } from "./bridge.js";
import { log } from "./log.js";
import { VERSION } from "./version.js";

const HELP = `homekit-bridge ${VERSION} — local HTTP bridge that controls HomeKit IP accessories

Usage: homekit-bridge [options]

  --bind <host:port>     listen address (env HOMEKIT_BRIDGE_BIND, default 127.0.0.1:7782)
  --token <token>        bearer token, >= 16 chars (env HOMEKIT_BRIDGE_TOKEN)
  --token-file <path>    file holding the token (env HOMEKIT_BRIDGE_TOKEN_FILE)
  --data-dir <path>      where pairings.json lives (env HOMEKIT_BRIDGE_DATA_DIR,
                         default $XDG_DATA_HOME/homekit-bridge or ~/.local/share/homekit-bridge)
  --no-discovery         disable the mDNS browse (manual adds only)
                         (env HOMEKIT_BRIDGE_NO_DISCOVERY=1)
  --version              print the version and exit
  --help                 this text
`;

function fail(msg: string): never {
  process.stderr.write(`homekit-bridge: ${msg}\n`);
  process.exit(2);
}

export function parseBind(s: string): { host: string; port: number } {
  const m = /^(?:\[([^\]]+)\]|([^:]+)):(\d+)$/.exec(s.trim());
  const port = m ? Number(m[3]) : NaN;
  if (!m || port < 0 || port > 65535) fail(`--bind must be host:port, got ${JSON.stringify(s)}`);
  return { host: m[1] ?? m[2], port };
}

function defaultDataDir(): string {
  const xdg = process.env.XDG_DATA_HOME;
  if (xdg) return join(xdg, "homekit-bridge");
  return join(homedir(), ".local/share/homekit-bridge");
}

async function main(): Promise<void> {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        bind: { type: "string" },
        token: { type: "string" },
        "token-file": { type: "string" },
        "data-dir": { type: "string" },
        "no-discovery": { type: "boolean" },
        version: { type: "boolean", short: "V" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
    }));
  } catch (e) {
    fail(`${(e as Error).message}\n\n${HELP}`);
  }
  if (values.help) {
    process.stdout.write(HELP);
    return;
  }
  if (values.version) {
    process.stdout.write(`homekit-bridge ${VERSION}\n`);
    return;
  }

  const env = process.env;
  const bind = parseBind(values.bind ?? env.HOMEKIT_BRIDGE_BIND ?? "127.0.0.1:7782");
  if (values.token && values["token-file"]) fail("pass either --token or --token-file, not both");
  let token = values.token ?? (values["token-file"] ? undefined : env.HOMEKIT_BRIDGE_TOKEN);
  const tokenFile = values["token-file"] ?? (token ? undefined : env.HOMEKIT_BRIDGE_TOKEN_FILE);
  if (!token && tokenFile) {
    try {
      token = readFileSync(tokenFile, "utf8");
    } catch (e) {
      fail(`reading token file ${tokenFile}: ${(e as Error).message}`);
    }
  }
  token = token?.trim();
  if (!token) fail("a token is required: pass --token, --token-file or HOMEKIT_BRIDGE_TOKEN");
  if (token.length < 16) fail("token must be at least 16 characters");

  const dataDir = values["data-dir"] ?? env.HOMEKIT_BRIDGE_DATA_DIR ?? defaultDataDir();
  const discovery = !(values["no-discovery"] || /^(1|true|yes)$/i.test(env.HOMEKIT_BRIDGE_NO_DISCOVERY ?? ""));

  const bridge = new Bridge({ dataDir, discovery });
  try {
    bridge.start();
  } catch (e) {
    fail(`loading ${dataDir}: ${(e as Error).message}`);
  }
  const server = createApiServer(bridge, token);
  server.on("error", (e) => fail(`binding ${bind.host}:${bind.port}: ${e.message}`));
  server.listen(bind.port, bind.host, () => {
    log.info(`homekit-bridge ${VERSION} listening on ${bind.host}:${bind.port} (data dir ${dataDir})`);
  });

  const shutdown = () => {
    log.info("shutting down");
    server.closeAllConnections();
    server.close();
    bridge.stop().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => fail((e as Error)?.stack ?? String(e)));
