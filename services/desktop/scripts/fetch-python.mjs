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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vendorDir = path.join(root, "vendor");

const PBS_RELEASE = "20260901";
const PYTHON_VERSION = "3.12.14";

// One entry per (desktop-shell-os, arch) pair this app ships. `triple` is the target triple in
// python-build-standalone's own asset names; `sha256` is that asset's checksum from this
// release's SHA256SUMS.
const TARGETS = {
  linux: [
    { arch: "x64", triple: "x86_64-unknown-linux-gnu", sha256: "72748da13197c1fb161e3afeef20a6a385ff24f2165e6e2758e47008e7faba4c" },
    { arch: "arm64", triple: "aarch64-unknown-linux-gnu", sha256: "577b4bec0793ad1ff0cbff9adbd0df078eddde38a4c41bf5d83ad381a85ee39d" },
  ],
  mac: [
    { arch: "x64", triple: "x86_64-apple-darwin", sha256: "65b195c9cedc1fef6767f044f9822069adbd1bd9204d424ece4628776fdc04bb" },
    { arch: "arm64", triple: "aarch64-apple-darwin", sha256: "81a359f1cfadd4da11766534c5913791cea55f26e1bb902cacd2a531bb1e4b2b" },
  ],
  win: [
    { arch: "x64", triple: "x86_64-pc-windows-msvc", sha256: "7c45c9622400d578709a9b2cddbe8124cc21d382409d9f13406d706d28e31b14" },
    { arch: "arm64", triple: "aarch64-pc-windows-msvc", sha256: "72f4713d056a17961bdba7b43be82a878035040fa1eee30cfd5e43b91a2852d9" },
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

async function fetchTarget(os, { arch, triple, sha256 }) {
  const destDir = path.join(vendorDir, `python-${os}-${arch}`);
  if (existsSync(markerFile(destDir, os))) {
    console.log(`[fetch-python] ${os}/${arch}: already present, skipping`);
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
    rmSync(destDir, { recursive: true, force: true });
    mkdirSync(destDir, { recursive: true });
    // --strip-components=1: every asset's tarball wraps its contents in a single top-level
    // "python/" directory, but destDir itself is already that per-arch identity, so bin/lib/etc.
    // should land directly inside it (matching what paths.ts's bundledPythonPath() expects).
    execFileSync("tar", ["xzf", tarPath, "-C", destDir, "--strip-components=1"], { stdio: "inherit" });
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
  console.log(`[fetch-python] ${os}/${arch}: extracted to ${path.relative(root, destDir)}`);
}

async function main() {
  const os = process.argv[2];
  const targets = TARGETS[os];
  if (!targets) {
    console.error(`usage: node fetch-python.mjs <${Object.keys(TARGETS).join("|")}>`);
    process.exit(1);
  }
  mkdirSync(vendorDir, { recursive: true });
  for (const target of targets) await fetchTarget(os, target);
}

await main();
