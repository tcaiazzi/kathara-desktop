import { describe, expect, it, vi } from "vitest";
import { authorizeDeployWith, type DeployAuthorizationSteps } from "./privilegedAction";

// Linux, a password sudo accepts, a backend that grants: each test changes the one step it is about.
function steps(overrides: Partial<DeployAuthorizationSteps> = {}) {
  return {
    platform: "linux" as NodeJS.Platform,
    sudoRunsWithoutPassword: vi.fn(async () => false),
    verifyPassword: vi.fn(async () => ({ ok: true as const })),
    grant: vi.fn(async () => ({ ok: true as const })),
    ...overrides,
  };
}

describe("authorizeDeployWith", () => {
  it("grants the deploy only after the password checks out", async () => {
    const s = steps();

    expect(await authorizeDeployWith(s, "lab1", "secret")).toEqual({ ok: true });
    expect(s.verifyPassword).toHaveBeenCalledWith("secret");
    expect(s.grant).toHaveBeenCalledWith("lab1");
  });

  it("asks for no grant when the password is wrong", async () => {
    const failure = { ok: false as const, reason: "wrong-password" as const, message: "Sorry, try again." };
    const s = steps({ verifyPassword: vi.fn(async () => failure) });

    expect(await authorizeDeployWith(s, "lab1", "wrong")).toEqual(failure);
    expect(s.grant).not.toHaveBeenCalled();
  });

  it("on Linux, takes a missing password only where sudo really asks for none", async () => {
    const s = steps();

    const result = await authorizeDeployWith(s, "lab1");

    expect(result).toMatchObject({ ok: false, reason: "error" });
    expect(s.verifyPassword).not.toHaveBeenCalled();
    expect(s.grant).not.toHaveBeenCalled();
  });

  it("on Linux with NOPASSWD, grants the deploy on the confirmation alone", async () => {
    const s = steps({ sudoRunsWithoutPassword: vi.fn(async () => true) });

    expect(await authorizeDeployWith(s, "lab1")).toEqual({ ok: true });
    expect(s.verifyPassword).not.toHaveBeenCalled();
    expect(s.grant).toHaveBeenCalledWith("lab1");
  });

  it("elsewhere, leaves the asking to the OS dialog even without a password", async () => {
    const s = steps({ platform: "darwin" });

    expect(await authorizeDeployWith(s, "lab1")).toEqual({ ok: true });
    expect(s.sudoRunsWithoutPassword).not.toHaveBeenCalled();
    expect(s.verifyPassword).toHaveBeenCalledWith(undefined);
  });

  it("reports a grant the backend refused", async () => {
    const s = steps({ grant: vi.fn(async () => ({ ok: false as const, message: "Lab `x` not found." })) });

    expect(await authorizeDeployWith(s, "x", "secret")).toEqual({
      ok: false,
      reason: "error",
      message: "Lab `x` not found.",
    });
  });
});
