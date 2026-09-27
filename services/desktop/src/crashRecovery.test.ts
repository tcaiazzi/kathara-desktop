import { describe, expect, it } from "vitest";
import { AUTO_RESTART_WINDOW_MS, parseUiTheme, resumePathOf, shouldAutoRestart } from "./crashRecovery";

describe("shouldAutoRestart", () => {
  it("restarts the first crash of the session", () => {
    expect(shouldAutoRestart(null, 1_000)).toBe(true);
  });

  it("leaves a second crash soon after an automatic restart to the crash page", () => {
    expect(shouldAutoRestart(1_000, 1_000 + AUTO_RESTART_WINDOW_MS - 1)).toBe(false);
  });

  it("restarts again once the window has passed", () => {
    expect(shouldAutoRestart(1_000, 1_000 + AUTO_RESTART_WINDOW_MS)).toBe(true);
  });
});

describe("resumePathOf", () => {
  it("keeps the app's path and query", () => {
    expect(resumePathOf("http://127.0.0.1:41234/workspace/abc?tab=files")).toBe("/workspace/abc?tab=files");
  });

  it("has nothing to resume from the root, a local page or a broken URL", () => {
    expect(resumePathOf("http://127.0.0.1:41234/")).toBeUndefined();
    expect(resumePathOf("file:///opt/app/build/setup.html")).toBeUndefined();
    expect(resumePathOf("not a url")).toBeUndefined();
  });
});

describe("parseUiTheme", () => {
  it("accepts the two themes and nothing else", () => {
    expect(parseUiTheme("dark")).toBe("dark");
    expect(parseUiTheme("light")).toBe("light");
    expect(parseUiTheme("system")).toBeNull();
    expect(parseUiTheme(null)).toBeNull();
    expect(parseUiTheme({ theme: "dark" })).toBeNull();
  });
});
