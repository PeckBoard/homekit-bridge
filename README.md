# homekit-bridge

A small local daemon that acts as a **HomeKit controller** for IP accessories
(HAP over TCP/mDNS) and exposes them over a token-protected HTTP API on
`127.0.0.1:7782`. It is the backend of the Peckboard `homekit` plugin; the
API is specified in [`BRIDGE_API.md`](BRIDGE_API.md).

Built on [`hap-controller`](https://github.com/Apollon77/hap-controller-node)
(IP transport only). Ships as one file, `homekit-bridge.mjs`, that runs on the
system `node` (>= 20).

## Scope

- **IP accessories only** — Wi-Fi/Ethernet HomeKit devices advertised as
  `_hap._tcp`. No Bluetooth LE, no Thread, no Matter.
- The bridge is a controller, not a HomeKit bridge: nothing is exposed back to
  Apple Home.

## Install

With the Peckboard **App Manager** (`homekit-bridge` entry) — it uses the
system `node` when it is >= 20 and otherwise fetches a private official
Node 22 into `~/.local/lib/homekit-bridge/node` — or by hand:

```bash
curl -fsSLO https://github.com/PeckBoard/homekit-bridge/releases/latest/download/homekit-bridge.mjs
curl -fsSLO https://github.com/PeckBoard/homekit-bridge/releases/latest/download/homekit-bridge.mjs.sha256
sha256sum -c homekit-bridge.mjs.sha256
install -Dm644 homekit-bridge.mjs ~/.local/lib/homekit-bridge/homekit-bridge.mjs
# wrapper pins the node binary, so the unit works with an nvm-only node too
printf '#!/bin/sh\nexec "%s" "%s" "$@"\n' "$(command -v node)" \
  "$HOME/.local/lib/homekit-bridge/homekit-bridge.mjs" > ~/.local/bin/homekit-bridge
chmod 755 ~/.local/bin/homekit-bridge
install -Dm644 homekit-bridge.service ~/.config/systemd/user/homekit-bridge.service
mkdir -p ~/.config/homekit-bridge
(umask 077; head -c 32 /dev/urandom | base64 > ~/.config/homekit-bridge/token)
systemctl --user daemon-reload
systemctl --user enable --now homekit-bridge
loginctl enable-linger "$USER"   # keep running while logged out
```
```

The host must be on the same L2 network as the accessories (mDNS).

## Flags

| Flag                  | Env                            | Default                                                  |
| --------------------- | ------------------------------ | -------------------------------------------------------- |
| `--bind host:port`    | `HOMEKIT_BRIDGE_BIND`          | `127.0.0.1:7782`                                         |
| `--token <t>`         | `HOMEKIT_BRIDGE_TOKEN`         | — (≥ 16 chars, required unless a token file is given)    |
| `--token-file <path>` | `HOMEKIT_BRIDGE_TOKEN_FILE`    | —                                                        |
| `--data-dir <path>`   | `HOMEKIT_BRIDGE_DATA_DIR`      | `$XDG_DATA_HOME/homekit-bridge` or `~/.local/share/homekit-bridge` |
| `--no-discovery`      | `HOMEKIT_BRIDGE_NO_DISCOVERY=1`| mDNS browse on (off: manual adds only)                   |
| `--version`           |                                | prints `homekit-bridge <version>`                        |

`HOMEKIT_BRIDGE_LOG=debug` adds debug logs; `DEBUG=hap-controller:*` traces the
HAP wire protocol.

Pairings (controller long-term keys, the accessory's public key, label,
address and the cached accessory database) live in `{data-dir}/pairings.json`,
mode `0600`. **Back it up**: losing it means every accessory has to be
factory-reset before it can be paired again.

## Pairing Notes

- An accessory pairs with **one** admin controller at a time. If it is in Apple
  Home, **remove it from the Home app first** (or factory-reset it), otherwise
  pairing fails with `pair_failed` ("already paired with another controller").
  `/discover` reports such devices as `available_for_pairing: false`.
- The setup code is the 8-digit code on the device or its QR label
  (`123-45-678` or `12345678`). A wrong code returns `bad_setup_code`; many
  accessories lock pairing after a few failures until power-cycled.
- Accessories mDNS can't see (other subnet, VPN) can be added manually by
  passing `address` and `port` to `POST /devices/pair`.
- `DELETE /devices/{id}` removes our pairing on the accessory so it can go
  back to Apple Home; `?force=1` forgets it locally when the accessory is gone
  (it then needs a factory reset).

## Behaviour

- One persistent encrypted session per paired accessory (a request connection
  plus an event-subscription connection, both pair-verified), re-established
  automatically with exponential backoff (1 s → 60 s) and immediately when mDNS
  reports a new address. A bumped mDNS configuration number re-reads the
  accessory database.
- Every `ev` characteristic is subscribed; HAP events update the value cache
  and the `/events` ring buffer (last 500).
- Calls to one accessory are serialized; each has a 10 s timeout
  (`timeout` error).
- Writes are validated against format / min / max / step / valid-values /
  perms before anything is sent (`invalid_value`, `read_only`).

HTTP status per error code: `bad_request`, `bad_setup_code`, `invalid_value`,
`read_only` → 400; `unauthorized` → 401; `not_found`, `not_paired` → 404;
`already_paired` → 409; `pair_failed`, `unreachable` → 502; `timeout` → 504.

## Development

```bash
npm ci
npm test             # vitest: unit + a real hap-nodejs accessory end-to-end
npx tsc --noEmit
npm run build        # dist/homekit-bridge.mjs
npm run smoke        # boots the bundle + fake accessory as processes
npm run fake-accessory -- --port 51826   # fake lightbulb for manual testing
npm run gen-names    # regenerate src/hapNames.ts from hap-nodejs
```

`scripts/fake-accessory.mjs` runs a hap-nodejs Lightbulb (on, brightness) plus
a read-only temperature sensor and prints
`{"id","setup_code","port","address","name"}`; type `on`, `off`, `b 40` or
`t 23.5` on its stdin to change state from the accessory side. It is
dev-only and never part of the bundle.

Releases: push a `v*` tag; `.github/workflows/release.yml` tests, builds and
attaches `homekit-bridge.mjs` + `homekit-bridge.mjs.sha256`.
