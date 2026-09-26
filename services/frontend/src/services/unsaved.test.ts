import { describe, expect, it } from "vitest";
import { describeUnsaved } from "./unsaved";

describe("describeUnsaved", () => {
  it("names the single dirty buffer", () => {
    expect(describeUnsaved(["/r1.startup in qa-lab"])).toBe("Your unsaved edits to /r1.startup in qa-lab will be lost.");
  });

  it("lists several buffers with a final 'and'", () => {
    expect(describeUnsaved(["/lab.conf in qa-lab", "/etc/hosts on r1"])).toBe(
      "Your unsaved edits to /lab.conf in qa-lab and /etc/hosts on r1 will be lost.",
    );
    expect(describeUnsaved(["a", "b", "c"])).toBe("Your unsaved edits to a, b and c will be lost.");
  });

  it("mentions a buffer once even when it is registered twice", () => {
    expect(describeUnsaved(["a", "a"])).toBe("Your unsaved edits to a will be lost.");
  });

  it("still says something sensible with no label", () => {
    expect(describeUnsaved([])).toBe("Unsaved changes will be lost.");
  });
});
