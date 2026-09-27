import { describe, expect, it } from "vitest";
import {
  validateDeviceName,
  validateDomainName,
  validateInterfaceNumber,
  validateLabName,
  validateMacAddress,
  validateMem,
} from "./names";

describe("every validator", () => {
  it.each([validateLabName, validateDeviceName, validateDomainName, validateMacAddress, validateMem, validateInterfaceNumber])(
    "leaves an empty or blank value to the form's own required check",
    (validate) => {
      expect(validate("")).toBeNull();
      expect(validate("   ")).toBeNull();
    },
  );
});

describe("validateLabName", () => {
  it.each(["my-lab", "lab_1.v2", "A".repeat(64), "  padded  "])("accepts %j", (name) => {
    expect(validateLabName(name)).toBeNull();
  });

  it.each(["my lab", "a/b", "a\\b", "è", "A".repeat(65)])("rejects %j", (name) => {
    expect(validateLabName(name)).toBe("Use letters, digits, dot, dash or underscore (at most 64 characters).");
  });

  it.each([".", ".."])("rejects %j, which the pattern alone would allow", (name) => {
    expect(validateLabName(name)).toBe(`"${name}" can't be used as a lab name.`);
  });
});

describe("validateDeviceName", () => {
  it.each(["pc1", "r_1", "a".repeat(30)])("accepts %j", (name) => {
    expect(validateDeviceName(name)).toBeNull();
  });

  it.each(["PC1", "pc 1", "pc-1", "a".repeat(31)])("rejects %j", (name) => {
    expect(validateDeviceName(name)).toBe("Use only lowercase letters, digits and underscores (at most 30 characters).");
  });

  it.each(["shared", "_test"])("rejects the reserved name %j", (name) => {
    expect(validateDeviceName(name)).toBe(`"${name}" is a reserved name, it can't be used for a device.`);
  });
});

describe("validateDomainName", () => {
  it.each(["A", "lan_1", "LAN"])("accepts %j", (name) => {
    expect(validateDomainName(name)).toBeNull();
  });

  it.each(["a-b", "a b", "a.b"])("rejects %j", (name) => {
    expect(validateDomainName(name)).toBe("Use only letters, digits and underscores.");
  });
});

describe("validateMacAddress", () => {
  it.each(["02:00:00:00:00:01", "02:AB:cd:ef:00:ff"])("accepts %j", (mac) => {
    expect(validateMacAddress(mac)).toBeNull();
  });

  it.each(["zz", "02:00:00:00:00", "02-00-00-00-00-01", "02:00:00:00:00:0g", "02:00:00:00:00:01:02"])("rejects %j", (mac) => {
    expect(validateMacAddress(mac)).not.toBeNull();
  });
});

describe("validateMem", () => {
  it.each(["256m", "1G", "512", "64k", "100b"])("accepts %j", (mem) => {
    expect(validateMem(mem)).toBeNull();
  });

  it.each(["abc", "1.5g", "256mb", "m", "-5m", "256 m"])("rejects %j", (mem) => {
    expect(validateMem(mem)).toBe("Use a whole number with an optional b, k, m or g unit, like 256m.");
  });
});

describe("validateInterfaceNumber", () => {
  it.each(["0", "3", "12"])("accepts %j", (n) => {
    expect(validateInterfaceNumber(n)).toBeNull();
  });

  it.each(["-1", "1.5", "eth0", "1e2"])("rejects %j", (n) => {
    expect(validateInterfaceNumber(n)).toBe("Use a whole number, 0 or more.");
  });
});
