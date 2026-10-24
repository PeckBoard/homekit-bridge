// HAP attribute database → the Device object of BRIDGE_API.md, plus value
// validation for writes.
import { ApiError } from "./errors.js";
import { CHARACTERISTIC_NAMES, SERVICE_NAMES } from "./hapNames.js";
import { categoryFromId, characteristicFromUuid, serviceFromUuid } from "./hap.js";

/** One characteristic as the accessory reports it in `/accessories`. */
export interface RawCharacteristic {
  iid: number;
  type: string;
  perms?: string[];
  format?: string;
  value?: unknown;
  description?: string;
  unit?: string;
  minValue?: number;
  maxValue?: number;
  minStep?: number;
  maxLen?: number;
  maxDataLen?: number;
  "valid-values"?: number[];
  "valid-values-range"?: [number, number];
}

export interface RawService {
  iid: number;
  type: string;
  primary?: boolean;
  hidden?: boolean;
  characteristics: RawCharacteristic[];
}

export interface RawAccessory {
  aid: number;
  services: RawService[];
}

export const HAP_BASE_UUID = "-0000-1000-8000-0026BB765291";
const short = (n: number) => n.toString(16).toUpperCase().padStart(8, "0") + HAP_BASE_UUID;
export const UUID = {
  accessoryInformation: short(0x3e),
  identify: short(0x14),
  manufacturer: short(0x20),
  model: short(0x21),
  name: short(0x23),
  firmwareRevision: short(0x52),
} as const;

/** json-bigint hands back BigNumber for integers past 2^53; flatten those so
 * the value survives JSON.stringify as a number (or a string if it must). */
export function plainValue(v: unknown): unknown {
  if (v && typeof v === "object" && (v as { _isBigNumber?: boolean })._isBigNumber) {
    const s = String(v);
    const n = Number(s);
    return Number.isSafeInteger(n) ? n : s;
  }
  return v;
}

/** A value as the API reports it: BigNumbers flattened, and `bool`
 * characteristics as true/false (accessories commonly send 0/1). */
export function apiValue(format: string | undefined, v: unknown): unknown {
  const p = plainValue(v);
  if (format === "bool" && (p === 0 || p === 1)) return p === 1;
  return p;
}
const num = (v: unknown): number => Number(plainValue(v));

function hapFallbackName(full: string, prefix: string): string | null {
  return full.startsWith(prefix) ? full.slice(prefix.length).replace(/\./g, "-") : null;
}

/** Friendly kebab-case service type, "custom" if unknown. */
export function serviceTypeName(uuid: string): string {
  const u = uuid.toUpperCase();
  return SERVICE_NAMES[u]?.[0] ?? hapFallbackName(serviceFromUuid(u), "public.hap.service.") ?? "custom";
}

/** Friendly kebab-case characteristic type, "custom" if unknown. */
export function characteristicTypeName(uuid: string): string {
  const u = uuid.toUpperCase();
  return (
    CHARACTERISTIC_NAMES[u]?.[0] ??
    hapFallbackName(characteristicFromUuid(u), "public.hap.characteristic.") ??
    "custom"
  );
}

/** Kebab category name for a HAP category id ("Garage Door Opener" →
 * "garage-door-opener"). */
export function categoryName(id: number | null | undefined): string {
  if (id == null) return "other";
  return categoryFromId(id).toLowerCase().replace(/\s+/g, "-");
}

/** Category guessed from the primary service when mDNS never told us
 * (manual add). */
const CATEGORY_BY_SERVICE: Record<string, number> = {
  lightbulb: 5,
  outlet: 7,
  switch: 8,
  thermostat: 9,
  "lock-mechanism": 6,
  "garage-door-opener": 4,
  "window-covering": 14,
  fan: 3,
  "fan-v2": 3,
  "air-purifier": 19,
  "security-system": 11,
  door: 12,
  window: 13,
  "heater-cooler": 21,
  "humidifier-dehumidifier": 22,
  television: 31,
  faucet: 29,
  valve: 28,
  "irrigation-system": 28,
};

export function guessCategory(db: RawAccessory[]): number {
  const acc = db.find((a) => a.aid === 1) ?? db[0];
  if (!acc) return 1;
  if (db.length > 1) return 2; // a HAP bridge
  const services = acc.services.map((s) => serviceTypeName(s.type));
  const primary = acc.services.find((s) => s.primary);
  const order = primary ? [serviceTypeName(primary.type), ...services] : services;
  for (const t of order) {
    if (CATEGORY_BY_SERVICE[t]) return CATEGORY_BY_SERVICE[t];
    if (t.endsWith("-sensor")) return 10;
  }
  return 1;
}

/** Reads a string characteristic off accessory-information. */
export function infoValue(acc: RawAccessory | undefined, charUuid: string, values: Map<string, unknown>): string | null {
  const info = acc?.services.find((s) => s.type.toUpperCase() === UUID.accessoryInformation);
  const c = info?.characteristics.find((c) => c.type.toUpperCase() === charUuid);
  if (!acc || !c) return null;
  const v = values.get(`${acc.aid}.${c.iid}`) ?? c.value;
  return typeof v === "string" ? v : null;
}

export function findCharacteristic(
  db: RawAccessory[],
  aid: number,
  iid: number,
): RawCharacteristic | undefined {
  const acc = db.find((a) => a.aid === aid);
  for (const s of acc?.services ?? []) {
    const c = s.characteristics.find((c) => c.iid === iid);
    if (c) return c;
  }
  return undefined;
}

export function toAccessoriesJson(db: RawAccessory[], values: Map<string, unknown>) {
  return db.map((acc) => {
    const name = infoValue(acc, UUID.name, values);
    return {
      aid: acc.aid,
      name,
      services: acc.services.map((s) => {
        const nameChar = s.characteristics.find((c) => c.type.toUpperCase() === UUID.name);
        const sname = nameChar ? values.get(`${acc.aid}.${nameChar.iid}`) ?? nameChar.value : null;
        const st = s.type.toUpperCase();
        return {
          iid: s.iid,
          type: serviceTypeName(st),
          type_uuid: st,
          name: typeof sname === "string" ? sname : (SERVICE_NAMES[st]?.[1] ?? null),
          primary: !!s.primary,
          characteristics: s.characteristics.map((c) => {
            const ct = c.type.toUpperCase();
            const key = `${acc.aid}.${c.iid}`;
            return {
              iid: c.iid,
              type: characteristicTypeName(ct),
              type_uuid: ct,
              description: c.description ?? CHARACTERISTIC_NAMES[ct]?.[1] ?? null,
              format: c.format ?? null,
              unit: c.unit ?? null,
              perms: c.perms ?? [],
              min: c.minValue != null ? num(c.minValue) : null,
              max: c.maxValue != null ? num(c.maxValue) : null,
              step: c.minStep != null ? num(c.minStep) : null,
              valid_values: c["valid-values"] ? c["valid-values"].map(num) : null,
              value: apiValue(c.format, values.has(key) ? values.get(key) : (c.value ?? null)),
            };
          }),
        };
      }),
    };
  });
}

const INT_RANGE: Record<string, [number, number]> = {
  uint8: [0, 255],
  uint16: [0, 65535],
  uint32: [0, 4294967295],
  uint64: [0, Number.MAX_SAFE_INTEGER],
  int: [-2147483648, 2147483647],
};

/** Validates (and lightly coerces) a value before it is written. Throws
 * `read_only` / `invalid_value`. */
export function validateWrite(c: RawCharacteristic, value: unknown, where = `iid ${c.iid}`): unknown {
  const perms = c.perms ?? [];
  if (!perms.includes("pw")) {
    throw new ApiError("read_only", `${characteristicTypeName(c.type)} (${where}) is not writable`);
  }
  const bad = (why: string): never => {
    throw new ApiError("invalid_value", `${characteristicTypeName(c.type)} (${where}): ${why}`);
  };
  const fmt = c.format ?? "";
  if (value === undefined || value === null) bad("value is required");

  if (fmt === "bool") {
    if (typeof value === "boolean") return value;
    if (value === 0 || value === 1) return value === 1;
    return bad(`expected a boolean, got ${JSON.stringify(value)}`);
  }

  if (fmt in INT_RANGE || fmt === "float") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return bad(`expected a number, got ${JSON.stringify(value)}`);
    }
    if (fmt !== "float") {
      if (!Number.isInteger(value)) bad(`expected an integer, got ${value}`);
      const [lo, hi] = INT_RANGE[fmt];
      if (value < lo || value > hi) bad(`${value} is out of range for ${fmt}`);
    }
    const min = c.minValue != null ? num(c.minValue) : null;
    const max = c.maxValue != null ? num(c.maxValue) : null;
    if (min != null && value < min) bad(`${value} is below the minimum ${min}`);
    if (max != null && value > max) bad(`${value} is above the maximum ${max}`);
    const step = c.minStep != null ? num(c.minStep) : null;
    if (step && step > 0) {
      const k = (value - (min ?? 0)) / step;
      if (Math.abs(k - Math.round(k)) > 1e-6) bad(`${value} is not a multiple of the step ${step}`);
    }
    const valid = c["valid-values"]?.map(num);
    if (valid && valid.length && !valid.includes(value)) {
      bad(`${value} is not one of the valid values [${valid.join(", ")}]`);
    }
    const range = c["valid-values-range"]?.map(num);
    if (range && range.length === 2 && (value < range[0] || value > range[1])) {
      bad(`${value} is outside the valid range ${range[0]}..${range[1]}`);
    }
    return value;
  }

  if (fmt === "string") {
    if (typeof value !== "string") return bad("expected a string");
    const maxLen = c.maxLen ?? 64;
    if (value.length > maxLen) bad(`string longer than ${maxLen} characters`);
    return value;
  }

  if (fmt === "tlv8" || fmt === "data") {
    if (typeof value !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
      return bad("expected a base64 string");
    }
    if (c.maxDataLen != null && Buffer.from(value, "base64").length > c.maxDataLen) {
      bad(`data longer than ${c.maxDataLen} bytes`);
    }
    return value;
  }

  // Unknown format: pass scalars through untouched.
  if (typeof value === "object") bad("expected a scalar value");
  return value;
}
