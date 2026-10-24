import { describe, expect, it } from "vitest";
import { ApiError } from "../src/errors.js";
import { characteristicTypeName, serviceTypeName, validateWrite, type RawCharacteristic } from "../src/model.js";
import { normalizeId, parseSetupCode } from "../src/setupCode.js";

const code = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return (e as ApiError).code;
  }
  return "ok";
};

describe("setup codes and ids", () => {
  it("accepts both forms and rejects garbage", () => {
    expect(parseSetupCode("12345678")).toBe("123-45-678");
    expect(parseSetupCode(" 031-45-154 ")).toBe("031-45-154");
    for (const bad of ["1234567", "123-456-78", "abc-de-fgh", 12345678, ""]) {
      expect(code(() => parseSetupCode(bad))).toBe("bad_setup_code");
    }
  });

  it("normalizes device ids with or without colons", () => {
    expect(normalizeId("a1b2c3d4e5f6")).toBe("A1:B2:C3:D4:E5:F6");
    expect(normalizeId("A1:B2:C3:D4:E5:F6")).toBe("A1:B2:C3:D4:E5:F6");
    expect(normalizeId("nope")).toBeNull();
  });
});

describe("friendly names", () => {
  it("maps HAP UUIDs to the contract's kebab names", () => {
    expect(serviceTypeName("00000043-0000-1000-8000-0026BB765291")).toBe("lightbulb");
    expect(serviceTypeName("000000B7-0000-1000-8000-0026BB765291")).toBe("fan-v2");
    expect(serviceTypeName("000000A2-0000-1000-8000-0026BB765291")).toBe("protocol-information");
    expect(characteristicTypeName("0000000F-0000-1000-8000-0026BB765291")).toBe("current-heating-cooling-state");
    expect(serviceTypeName("E863F007-079E-48FF-8F27-9C2605A29F52")).toBe("custom");
  });
});

describe("validateWrite", () => {
  const brightness: RawCharacteristic = {
    iid: 11,
    type: "00000008-0000-1000-8000-0026BB765291",
    format: "int",
    perms: ["pr", "pw", "ev"],
    minValue: 0,
    maxValue: 100,
    minStep: 1,
  };
  const temp: RawCharacteristic = {
    iid: 20,
    type: "00000035-0000-1000-8000-0026BB765291",
    format: "float",
    perms: ["pr", "pw"],
    minValue: 10,
    maxValue: 38,
    minStep: 0.5,
  };
  const mode: RawCharacteristic = {
    iid: 21,
    type: "00000033-0000-1000-8000-0026BB765291",
    format: "uint8",
    perms: ["pr", "pw"],
    "valid-values": [0, 1, 3],
  };

  it("enforces perms, type, range, step and valid values", () => {
    expect(validateWrite(brightness, 80)).toBe(80);
    expect(code(() => validateWrite(brightness, 101))).toBe("invalid_value");
    expect(code(() => validateWrite(brightness, 50.5))).toBe("invalid_value");
    expect(code(() => validateWrite(brightness, "80"))).toBe("invalid_value");
    expect(validateWrite(temp, 21.5)).toBe(21.5);
    expect(code(() => validateWrite(temp, 21.3))).toBe("invalid_value");
    expect(code(() => validateWrite(mode, 2))).toBe("invalid_value");
    expect(validateWrite(mode, 3)).toBe(3);
    expect(code(() => validateWrite({ ...brightness, perms: ["pr", "ev"] }, 10))).toBe("read_only");
    const on: RawCharacteristic = { iid: 10, type: "x", format: "bool", perms: ["pw"] };
    expect(validateWrite(on, 1)).toBe(true);
    expect(code(() => validateWrite(on, "yes"))).toBe("invalid_value");
  });
});
