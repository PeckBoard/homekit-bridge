# homekit-bridge HTTP API

Contract between the `homekit-bridge` daemon (Node, `peck-plugins/homekit-bridge`)
and the Peckboard `homekit` plugin (`peck-plugins/homekit`). Both sides
implement exactly this; change it here first.

## Transport

- Plain HTTP, default bind `127.0.0.1:7782`.
- Every request needs `Authorization: Bearer <token>`; token ≥ 16 chars, from
  `--token` / `HOMEKIT_BRIDGE_TOKEN` or `--token-file` /
  `HOMEKIT_BRIDGE_TOKEN_FILE` (default install: `~/.config/homekit-bridge/token`).
  Missing/wrong token → `401`.
- JSON bodies, `Content-Type: application/json`.
- Errors: non-2xx with `{"error": "<human message>", "code": "<slug>"}`.
  Codes: `unauthorized`, `bad_request`, `not_found`, `not_paired`,
  `already_paired`, `pair_failed`, `bad_setup_code`, `unreachable`,
  `read_only`, `invalid_value`, `timeout`.
- Data dir `--data-dir` / `HOMEKIT_BRIDGE_DATA_DIR`, default
  `~/.local/share/homekit-bridge`. Pairings (controller long-term keys +
  accessory LTPK) persist in `{data-dir}/pairings.json`, mode `0600`.

## Identifiers

- `id`: accessory's HAP device id from mDNS TXT `id`, e.g. `"A1:B2:C3:D4:E5:F6"`.
  URL-encode in paths (`A1%3AB2...`); the bridge also accepts it without colons.
- `aid` / `iid`: HAP accessory / instance ids (ints). A characteristic is
  addressed as `"<aid>.<iid>"`.

## Endpoints

### `GET /health`
`{"ok": true, "version": "0.1.0", "paired": 3, "connected": 2}`

### `GET /discover`
Accessories currently seen via mDNS `_hap._tcp` (cached; browse runs
continuously). Query `?refresh=1` forces a 3 s re-browse before answering.
```json
{"accessories": [{
  "id": "A1:B2:C3:D4:E5:F6", "name": "Eve Energy 1A2B", "model": "Eve Energy",
  "category": 7, "category_name": "outlet",
  "address": "192.168.1.40", "port": 51827,
  "paired_with_us": false,
  "available_for_pairing": true      // TXT sf=1: not paired to anyone
}]}
```
`available_for_pairing: false` + `paired_with_us: false` means it is still
owned by another controller (e.g. Apple Home) — the UI must say so.

### `POST /devices/pair`
```json
{"id": "A1:B2:C3:D4:E5:F6", "setup_code": "123-45-678",
 "address": "192.168.1.40", "port": 51827, "name": "Desk plug"}
```
`address`/`port` optional (taken from discovery); required for an accessory
mDNS can't see (manual add). `setup_code` accepts `12345678` or `123-45-678`.
`name` optional user label. Runs pair-setup, stores the pairing, opens the
session, reads the accessory database. → `201` with the Device object.
Errors: `bad_setup_code`, `already_paired`, `unreachable`, `pair_failed`.

### `GET /devices`
`{"devices": [Device, ...]}` — every paired device, from cache (no network).

### `GET /devices/{id}`
Device object. `?refresh=1` re-reads all readable characteristics first.

### `PATCH /devices/{id}`
`{"name": "Desk plug"}` → Device. Renames the user label only.

### `DELETE /devices/{id}`
Runs HAP remove-pairing on the accessory (so it can go back to Apple Home),
then forgets it locally. `?force=1` forgets locally even if the accessory
is unreachable. → `{"ok": true, "removed_from_accessory": true}`.

### `POST /devices/{id}/characteristics`
Write one or more values:
```json
{"set": [{"aid": 1, "iid": 10, "value": true},
         {"aid": 1, "iid": 11, "value": 80}]}
```
Values are validated against format/min/max/step/valid-values before
sending (`invalid_value`, `read_only`). → `{"device": Device}` with values
re-read after the write.

### `POST /devices/{id}/identify`
Writes Identify (blink). → `{"ok": true}`.

### `GET /events?since=<seq>`
Long-poll (≤ 25 s) for state changes from HAP event subscriptions and
connection changes. Returns immediately if anything newer than `since`.
```json
{"seq": 42, "events": [
  {"seq": 41, "id": "A1:...", "kind": "value", "aid": 1, "iid": 10, "value": false, "at": "2026-10-24T12:00:00Z"},
  {"seq": 42, "id": "A1:...", "kind": "connection", "connected": false, "at": "..."}]}
```
Ring buffer of the last 500 events; a `since` older than the buffer just
returns what is left. Plugin may simply poll `/devices` instead.

## Device Object

```json
{
  "id": "A1:B2:C3:D4:E5:F6",
  "name": "Desk plug",                  // user label, defaults to accessory name
  "accessory_name": "Eve Energy 1A2B",
  "model": "Eve Energy", "manufacturer": "Eve Systems", "firmware": "3.2.1",
  "category": 7, "category_name": "outlet",
  "address": "192.168.1.40", "port": 51827,
  "connected": true,
  "last_seen": "2026-10-24T12:00:00Z",
  "accessories": [{                      // >1 when the device is a HAP bridge
    "aid": 1, "name": "Eve Energy 1A2B",
    "services": [{
      "iid": 9, "type": "outlet",        // friendly name; "custom" if unknown
      "type_uuid": "00000047-0000-1000-8000-0026BB765291",
      "name": "Outlet", "primary": true,
      "characteristics": [{
        "iid": 10, "type": "on",          // friendly name; "custom" if unknown
        "type_uuid": "00000025-0000-1000-8000-0026BB765291",
        "description": "On",
        "format": "bool",                 // bool|uint8|uint16|uint32|uint64|int|float|string|tlv8|data
        "unit": null,                     // celsius|percentage|arcdegrees|lux|seconds|null
        "perms": ["pr", "pw", "ev"],
        "min": null, "max": null, "step": null,
        "valid_values": null,             // e.g. [0,1,2,3] for target heating/cooling state
        "value": true
      }]
    }]
  }]
}
```
Services `accessory-information` and `protocol-information` are included
(the UI hides them). Friendly `type` names are the kebab-case HAP names
(`lightbulb`, `switch`, `outlet`, `thermostat`, `lock-mechanism`,
`window-covering`, `garage-door-opener`, `fan-v2`, `temperature-sensor`,
`humidity-sensor`, `contact-sensor`, `motion-sensor`, `occupancy-sensor`,
`leak-sensor`, `air-quality-sensor`, `battery`, …; characteristics `on`,
`brightness`, `hue`, `saturation`, `color-temperature`,
`current-temperature`, `target-temperature`,
`current-heating-cooling-state`, `target-heating-cooling-state`,
`lock-current-state`, `lock-target-state`, `current-position`,
`target-position`, `contact-sensor-state`, `motion-detected`, …).

## Scope

IP accessories only (HAP over TCP/mDNS). No BLE, no Thread, no bridge
mode (nothing is exposed to Apple Home).
