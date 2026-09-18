import { describe, expect, it, vi } from "vitest";
import { showSudoRetry, sudoRetryMessages } from "./sudoFailure";

const messages = sudoRetryMessages("timed out", (m) => `failed: ${m}`);

const fields = () => ({ setPassword: vi.fn(), setError: vi.fn(), setBusy: vi.fn() });

describe("sudoRetryMessages", () => {
  it.each([
    ["wrong-password", "Incorrect password. Try again."],
    ["not-permitted", "This account isn't allowed to use sudo."],
    ["timeout", "timed out"],
  ])("%s is phrased for the user, not from the raw message", (reason, expected) => {
    expect(messages[reason]?.("raw backend detail")).toBe(expected);
  });

  it("threads the raw message into the per-operation error wording", () => {
    expect(messages.error?.("no such file")).toBe("failed: no such file");
  });

  it("passes a rate-limit message straight through", () => {
    // The limiter already phrases its own wait, so rewording it here would lose the countdown.
    expect(messages["rate-limited"]?.("Try again in 30s.")).toBe("Try again in 30s.");
  });

  it("has no entry for a cancelled prompt", () => {
    // The absence is the behaviour: dismissing the OS dialog must close the modal, not reopen it
    // with an error, because closing is exactly what the user asked for.
    expect(messages.cancelled).toBeUndefined();
  });
});

describe("showSudoRetry", () => {
  it("clears the password, shows the error and stops the spinner on a retryable reason", () => {
    const f = fields();

    expect(showSudoRetry(messages, { reason: "wrong-password", message: "" }, f)).toBe(true);

    expect(f.setPassword).toHaveBeenCalledWith("");
    expect(f.setError).toHaveBeenCalledWith("Incorrect password. Try again.");
    expect(f.setBusy).toHaveBeenCalledWith(false);
  });

  it("touches nothing and reports false when there is no retry message", () => {
    // The caller then closes with its own outcome — "cancelled" or "skipped" — which is why that
    // decision deliberately does not live in this helper.
    const f = fields();

    expect(showSudoRetry(messages, { reason: "cancelled", message: "" }, f)).toBe(false);

    expect(f.setPassword).not.toHaveBeenCalled();
    expect(f.setError).not.toHaveBeenCalled();
    expect(f.setBusy).not.toHaveBeenCalled();
  });

  it("does not blank the password box for an unknown reason either", () => {
    const f = fields();
    expect(showSudoRetry(messages, { reason: "something-new", message: "x" }, f)).toBe(false);
    expect(f.setPassword).not.toHaveBeenCalled();
  });
});
