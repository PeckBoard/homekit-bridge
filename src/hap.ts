// IP-only imports from hap-controller. Deliberately NOT the package index:
// that one eagerly requires the BLE transport (and its native noble
// dependency), which this bridge never uses.
import * as httpClientNs from "hap-controller/lib/transport/ip/http-client.js";
import * as ipDiscoveryNs from "hap-controller/lib/transport/ip/ip-discovery.js";
import * as pairingNs from "hap-controller/lib/protocol/pairing-protocol.js";
import * as serviceNs from "hap-controller/lib/model/service.js";
import * as characteristicNs from "hap-controller/lib/model/characteristic.js";
import * as categoryNs from "hap-controller/lib/model/category.js";
// Under NodeNext, `ns.default` of a CJS module is `module.exports`; the class
// is its `default` property.
type HttpClientClass = (typeof httpClientNs)["default"]["default"];
type IPDiscoveryClass = (typeof ipDiscoveryNs)["default"]["default"];

export type { PairingData } from "hap-controller/lib/protocol/pairing-protocol.js";
export type { HapServiceIp } from "hap-controller/lib/transport/ip/ip-discovery.js";

/** CJS interop: Node's ESM loader, esbuild and vitest wrap
 * `exports.default` at different depths; unwrap until we hit the class. */
function cjsDefault<T>(ns: unknown): T {
  let x = ns as { default?: unknown };
  while (x && typeof x !== "function" && x.default) x = x.default as { default?: unknown };
  return x as T;
}

/** A named CJS export, wherever the interop layer put it. */
function cjsNamed<T>(ns: unknown, name: string): T {
  const n = ns as Record<string, unknown> & { default?: Record<string, unknown> };
  return (n[name] ?? n.default?.[name]) as T;
}

export const HttpClient = cjsDefault<HttpClientClass>(httpClientNs);
export type HttpClient = InstanceType<HttpClientClass>;
export const IPDiscovery = cjsDefault<IPDiscoveryClass>(ipDiscoveryNs);
export type IPDiscovery = InstanceType<IPDiscoveryClass>;
export const PairMethods = cjsNamed<{ PairSetup: number; PairSetupWithAuth: number }>(pairingNs, "PairMethods");

export const serviceFromUuid = cjsNamed<(uuid: string) => string>(serviceNs, "serviceFromUuid");
export const characteristicFromUuid = cjsNamed<(uuid: string) => string>(characteristicNs, "characteristicFromUuid");
export const categoryFromId = cjsNamed<(id: number) => string>(categoryNs, "categoryFromId");
