import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText } from "./clipboard";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("copyText", () => {
  it("writes through the desktop shell when running in Electron", async () => {
    const copyToClipboard = vi.fn().mockResolvedValue(undefined);
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("window", { katharaDesktop: { copyToClipboard } });
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    await copyText("hello");

    expect(copyToClipboard).toHaveBeenCalledWith("hello");
    expect(writeText).not.toHaveBeenCalled();
  });

  it("falls back to the browser Clipboard API outside the shell", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    await copyText("hello");

    expect(writeText).toHaveBeenCalledWith("hello");
  });
});
