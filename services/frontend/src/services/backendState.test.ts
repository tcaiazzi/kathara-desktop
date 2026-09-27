import { describe, expect, it } from "vitest";
import { parseBackendState } from "./backendState";

describe("parseBackendState", () => {
  it("reads the three notices the shell sends", () => {
    expect(parseBackendState({ state: "restarting", cause: "It stopped." })).toEqual({ state: "restarting", cause: "It stopped." });
    expect(parseBackendState({ state: "restarted" })).toEqual({ state: "restarted" });
    expect(parseBackendState({ state: "down", cause: "Again." })).toEqual({ state: "down", cause: "Again." });
  });

  it("rejects anything else", () => {
    expect(parseBackendState(null)).toBeNull();
    expect(parseBackendState("restarted")).toBeNull();
    expect(parseBackendState({ state: "down" })).toBeNull();
    expect(parseBackendState({ state: "gone", cause: "x" })).toBeNull();
  });
});
