import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// setup.html and splash.html allow no inline script or style (their Content-Security-Policy),
// so anything inline would silently not run or not apply — including a style="" attribute in the
// HTML a page's script builds.
const read = (file: string) => readFileSync(path.join(__dirname, file), "utf-8");

describe.each(["setup", "splash"])("%s.html", (page) => {
  const html = read(`${page}.html`);
  const script = read(`${page}.js`);

  it("declares a policy that allows only its own files", () => {
    const policy = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1] ?? "";
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("script-src 'self'");
    expect(policy).toContain("style-src 'self'");
    expect(policy).not.toContain("unsafe-inline");
  });

  it("loads its script and stylesheet from files", () => {
    expect(html).toContain(`<script src="${page}.js"></script>`);
    expect(html).toContain(`<link rel="stylesheet" href="${page}.css" />`);
    expect(html).not.toMatch(/<script>|<style\b/);
  });

  it("uses no inline style or event handler, in the page or in what its script writes", () => {
    for (const source of [html, script]) {
      expect(source).not.toMatch(/\sstyle=/);
      expect(source).not.toMatch(/\son[a-z]+=["']/);
    }
  });
});
