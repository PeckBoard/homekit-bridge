import { ApiError } from "./errors.js";

/** Accepts `12345678` or `123-45-678` (surrounding whitespace ignored) and
 * returns the `XXX-XX-XXX` form hap-controller wants. */
export function parseSetupCode(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new ApiError("bad_setup_code", "setup_code must be a string like 123-45-678");
  }
  const s = raw.trim();
  const m = /^(\d{3})-?(\d{2})-?(\d{3})$/.exec(s);
  if (!m) {
    throw new ApiError("bad_setup_code", "setup_code must be 8 digits: 12345678 or 123-45-678");
  }
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/** Canonical HAP device id `AA:BB:CC:DD:EE:FF` from either form; null if
 * it is not 6 hex bytes. */
export function normalizeId(raw: string): string | null {
  const hex = raw.trim().replace(/[:-]/g, "").toUpperCase();
  if (!/^[0-9A-F]{12}$/.test(hex)) return null;
  return hex.match(/../g)!.join(":");
}
