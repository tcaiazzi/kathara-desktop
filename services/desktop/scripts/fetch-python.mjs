// Downloads and verifies the Python interpreter this app bundles, so a packaged build never
// requires the user to have Python installed (see paths.ts's bundledPythonPath(), prereqs.ts's
// pythonCandidates()). Run once per OS job in .github/workflows/build-desktop.yml, before
// `npm run dist:<os>` — each job builds both its architectures in one electron-builder pass, so
// this fetches both.
//
// Source: astral-sh/python-build-standalone's "install_only_stripped" builds — the same
// relocatable CPython distribution `uv`/`rye` use for this exact purpose. Release, version and
// checksums are pinned below (from that release's own SHA256SUMS file) rather than resolved at
// build time, so a compromised or altered upstream asset can't silently substitute itself in.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PYTHON_VERSION } from "./python-version.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vendorDir = path.join(root, "vendor");

const PBS_RELEASE = "20260901";

// One entry per (desktop-shell-os, arch) pair this app ships. `triple` is the target triple in
// python-build-standalone's own asset names; `sha256` is that asset's checksum from this
// release's SHA256SUMS.
const TARGETS = {
  linux: [
    { arch: "x64", triple: "x86_64-unknown-linux-gnu", sha256: "3959f92825141e04adf44982d3a83ee57af0877e893b0796e04c1468749d9b04" },
    { arch: "arm64", triple: "aarch64-unknown-linux-gnu", sha256: "8a0798baa8a2c27b5751d590aced543eaa85e20b3f73d93c1af049688acdc9c5" },
  ],
  mac: [
    { arch: "x64", triple: "x86_64-apple-darwin", sha256: "7e151a7c9028855b61a7d6e78381f2020a1ef185281399f3b1aafc5e1c9a1a64" },
    { arch: "arm64", triple: "aarch64-apple-darwin", sha256: "4632cb1a6edad9e73d3c81b6d2e69131637d995173e3e85005df14102b0592ba" },
  ],
  win: [
    { arch: "x64", triple: "x86_64-pc-windows-msvc", sha256: "ca3c33ca924dfcab3b74205a7a58a88b0255135c53f95497b26b5e60700fd66d" },
    { arch: "arm64", triple: "aarch64-pc-windows-msvc", sha256: "0a798034b712c34589b90192282dc45534c1fb5c01279e68d3d163df0ed49773" },
  ],
};

function assetUrl(triple) {
  const name = `cpython-${PYTHON_VERSION}+${PBS_RELEASE}-${triple}-install_only_stripped.tar.gz`;
  return `https://github.com/astral-sh/python-build-standalone/releases/download/${PBS_RELEASE}/${name}`;
}

/** The one file every target's tarball is guaranteed to contain at its (stripped) root, used to
 * decide whether a destination already holds a real extracted interpreter. */
function markerFile(destDir, os) {
  return os === "win" ? path.join(destDir, "python.exe") : path.join(destDir, "bin", "python3");
}

/** Records the sha256 of the asset destDir was extracted from. The marker file alone can't tell a
 * 3.12 interpreter from a 3.14 one, and vendor-python-deps.mjs installs wheels for the ABI pinned in
 * python-version.mjs, so a stale interpreter kept across a version bump would ship with C
 * extensions it can't import. A sibling of destDir, not a file inside it: electron-builder packs
 * destDir whole, and `make clean-python`'s `python-*` glob still removes it. */
function receiptFile(destDir) {
  return `${destDir}.sha256`;
}

function isCurrent(destDir, os, sha256) {
  if (!existsSync(markerFile(destDir, os))) return false;
  try {
    return readFileSync(receiptFile(destDir), "utf8").trim() === sha256;
  } catch {
    return false;
  }
}

async function fetchTarget(os, { arch, triple, sha256 }) {
  const destDir = path.join(vendorDir, `python-${os}-${arch}`);
  if (isCurrent(destDir, os, sha256)) {
    console.log(`[fetch-python] ${os}/${arch}: CPython ${PYTHON_VERSION} already present, skipping`);
    return;
  }

  const url = assetUrl(triple);
  console.log(`[fetch-python] ${os}/${arch}: downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed for ${os}/${arch}: HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());

  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== sha256) {
    throw new Error(`checksum mismatch for ${os}/${arch}: expected ${sha256}, got ${actual}`);
  }

  const tmpDir = mkdtempSync(path.join(tmpdir(), "fetch-python-"));
  const tarPath = path.join(tmpDir, "python.tar.gz");
  writeFileSync(tarPath, bytes);
  try {
    // The receipt goes first and is rewritten last, so an extraction that dies halfway is fetched
    // again on the next run instead of being taken for current.
    rmSync(receiptFile(destDir), { force: true });
    rmSync(destDir, { recursive: true, force: true });
    mkdirSync(destDir, { recursive: true });
    // --strip-components=1: every asset's tarball wraps its contents in a single top-level
    // "python/" directory, but destDir itself is already that per-arch identity, so bin/lib/etc.
    // should land directly inside it (matching what paths.ts's bundledPythonPath() expects).
    execFileSync("tar", ["xzf", tarPath, "-C", destDir, "--strip-components=1"], { stdio: "inherit" });
    writeFileSync(receiptFile(destDir), `${sha256}\n`);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
  console.log(`[fetch-python] ${os}/${arch}: extracted to ${path.relative(root, destDir)}`);
}

async function main() {
  const os = process.argv[2];
  // Optional third arg restricts the fetch to a single arch (e.g. a host-only build that only
  // needs its own arch's interpreter, not every arch this OS ships). Omit it to fetch all of
  // them, as CI does.
  const archFilter = process.argv[3];
  let targets = TARGETS[os];
  if (!targets) {
    console.error(`usage: node fetch-python.mjs <${Object.keys(TARGETS).join("|")}> [arch]`);
    process.exit(1);
  }
  if (archFilter) {
    targets = targets.filter((t) => t.arch === archFilter);
    if (targets.length === 0) {
      console.error(`no target for ${os}/${archFilter} (known archs: ${TARGETS[os].map((t) => t.arch).join(", ")})`);
      process.exit(1);
    }
  }
  mkdirSync(vendorDir, { recursive: true });
  for (const target of targets) await fetchTarget(os, target);
}

await main();
