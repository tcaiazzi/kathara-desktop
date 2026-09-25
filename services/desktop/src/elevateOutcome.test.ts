import { describe, expect, it } from "vitest";
import { toElevateOutcome } from "./elevateOutcome";

describe("toElevateOutcome", () => {
  it("reports a success without the new backend's address or token", () => {
    const outcome = toElevateOutcome({
      ok: true,
      handle: { port: 41234, baseUrl: "http://127.0.0.1:41234", token: "s3cr3t-t0ken" },
    });

    expect(outcome).toEqual({ ok: true });
    expect(JSON.stringify(outcome)).not.toContain("s3cr3t");
  });

  it("passes a failure through with its reason, message and restart flag", () => {
    const failure = { ok: false as const, reason: "wrong-password" as const, message: "Sorry, try again.", restarted: false };

    expect(toElevateOutcome(failure)).toEqual(failure);
  });
});
