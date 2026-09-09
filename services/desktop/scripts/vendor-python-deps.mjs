// Installs the backend's entire Python dependency closure into the app at *build* time, so a
// packaged app never downloads — and never installs — anything on first launch. Run once per OS
// job in .github/workflows/build-desktop.yml, after fetch-python.mjs and before `npm run
// dist:<os>`; each job builds both its architectures in one electron-builder pass, so this
// vendors both.
//
// Output: vendor/site-packages-<os>-<arch>/, shipped as a platform+arch-scoped extraResource (see
// electron-builder.yml) and put on PYTHONPATH when the shell spawns uvicorn (see paths.ts's
// bundledSitePackages() and backend.ts's buildBackendCommand()). Deliberately a plain
// `pip install --target` tree rather than a venv or an install into the bundled interpreter's own
// site-packages: it is the one layout that works identically on every OS, including the
// installations where nothing inside the app is writable at runtime (an AppImage's read-only
// squashfs, a root-owned /opt from the .deb/.rpm, a Program Files directory chosen in the NSIS
// installer) and macOS, where writing into Contents/Resources would invalidate the ad-hoc bundle
// signature that scripts/sign-mac-arm64.js applies and make Apple Silicon refuse to launch at all.
//
// Two passes, and the split is the point:
//
//   A. Resolve the closure ONCE, on this runner, with the target's Python version. pip evaluates
//      `sys_platform` markers from the *running* environment, so this has to run on the OS it is
//      vendoring for — which is exactly what the per-OS CI jobs give us. `uvloop` therefore drops
//      out on Windows on its own, with no special-casing here.
//
//   B. Install those exact (name, version) pairs one at a time, with --no-deps, once per
//      architecture with that architecture's wheel tags. pip does NOT re-evaluate
//      `platform_machine` markers from --platform (it reads them from the runner), so the
//      cross-arch resolution is deliberately not delegated to the resolver — pass A decided the
//      versions, pass B only fetches them. One package per invocation is what makes a failure
//      unambiguous: pip names the one distribution that has no wheel for this target instead of
//      reporting an unsatisfiable graph.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PYTHON_VERSION } from "./python-version.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vendorDir = path.join(root, "vendor");

// Derived from the interpreter fetch-python.mjs actually ships, so the two can't drift: the wheels
// vendored here have to match that interpreter's ABI exactly or every C extension fails to import.
const PY_TAG = PYTHON_VERSION.split(".").slice(0, 2).join("."); // "3.12"
const ABI_TAG = `cp${PY_TAG.replace(".", "")}`; // "cp312"

/**
 * Wheel tags accepted per (os, arch), most specific first. `--platform` is repeatable and pip
 * treats the set as "any of these is acceptable", which is what lets one entry cover both the
 * arch-specific and the universal2 wheels a project may publish.
 */
const TARGETS = {
  linux: {
    x64: ["manylinux_2_28_x86_64", "manylinux_2_17_x86_64", "manylinux2014_x86_64"],
    arm64: ["manylinux_2_28_aarch64", "manylinux_2_17_aarch64", "manylinux2014_aarch64"],
  },
  mac: {
    x64: ["macosx_11_0_x86_64", "macosx_10_13_x86_64", "macosx_10_9_x86_64", "macosx_11_0_universal2", "macosx_10_9_universal2"],
    arm64: ["macosx_14_0_arm64", "macosx_12_0_arm64", "macosx_11_0_arm64", "macosx_11_0_universal2", "macosx_10_9_universal2"],
  },
  win: {
    x64: ["win_amd64"],
    arm64: ["win_arm64"],
  },
};

/**
 * Packages that are pure speed-ups: the backend runs correctly without them, on a documented
 * fallback. Anything NOT in this set that has no wheel for a target fails the build, so a genuine
 * gap surfaces in CI instead of on a user's machine.
 *
 * Verified against PyPI for cp312: `httptools` publishes no win_arm64 wheel and has no
 * py3-none-any fallback either. backend.ts spawns uvicorn without `--http`, so uvicorn picks its
 * h11 implementation by itself when httptools isn't importable — same behaviour, marginally slower
 * HTTP parsing on a loopback socket. `uvloop` (no Windows wheels at all) is already excluded by its
 * own `sys_platform != 'win32'` marker in pass A and is listed here only as a backstop; uvicorn
 * falls back to the asyncio event loop. `watchfiles` is reload-only and unused in production.
 */
const OPTIONAL_ACCELERATORS = new Set(["httptools", "uvloop", "watchfiles"]);

/**
 * Shipped into every vendored tree, because a `pip install --target` directory reached through
 * PYTHONPATH is **not** a site directory: Python runs `.pth` files only for real site-packages
 * directories, so any package that relies on one is silently half-installed here.
 *
 * That is not hypothetical. `pywin32` — a dependency of the `docker` SDK on Windows — ships
 * `pywin32.pth`, and it is the only thing that puts pywin32's `win32/`, `win32/lib/` and
 * `pythonwin/` subdirectories on sys.path *and* calls `os.add_dll_directory()` for the DLLs in
 * `pywin32_system32/`. Without it `import win32pipe` fails outright, and on Windows the docker SDK
 * needs exactly that module to reach Docker Desktop over its named pipe — which surfaced as every
 * Docker-touching API call failing with `ImportError`.
 *
 * `site` imports a module named `sitecustomize` at interpreter startup, after PYTHONPATH is
 * already on sys.path, so this file is found here without any further wiring.
 */
const SITECUSTOMIZE = `"""Run the .pth files in this directory.

Written by services/desktop/scripts/vendor-python-deps.mjs. This tree is a \`pip install --target\`
directory handed to the interpreter on PYTHONPATH, and Python only processes .pth files for real
site directories — so without this, a package that ships one (pywin32, via the docker SDK on
Windows) is on sys.path but not actually usable. site.addsitedir() is the documented API that
processes them, \`import\` lines included.
"""

import os
import site

try:
    site.addsitedir(os.path.dirname(os.path.abspath(__file__)))
except Exception:
    # Never let a startup hook take the backend down. A dependency that genuinely needed its .pth
    # will still fail at its own import, with a message naming it — far easier to diagnose than an
    # interpreter that refuses to start at all.
    pass
`;

/** PEP 503 normalisation, so "kathara-api-rest" and "kathara_api_rest" compare equal. */
function normalize(name) {
  return name.replace(/[-_.]+/g, "-").toLowerCase();
}

/** The Python running pip here — only its pip matters, not its version: every resolution and
 * install below is pinned to the *target* interpreter with --python-version/--abi. The env
 * override exists for a machine whose default `python3` is too old to have pip's --report. */
function hostPython() {
  return process.env.KATHARA_VENDOR_PYTHON || (process.platform === "win32" ? "python" : "python3");
}

/** The wheel `python -m build` put here (Makefile's `wheel` target, or the CI step before this).
 *
 * Exactly one, or this refuses to guess. `make wheel` clears vendor/*.whl before building for that
 * reason, but a hand-run `python -m build` doesn't: pick "the first .whl in readdir order" and a
 * leftover from before a version bump wins silently, and the whole installer ships the previous
 * release's backend with nothing in the build log to say so. */
function localWheel() {
  const wheels = existsSync(vendorDir) ? readdirSync(vendorDir).filter((f) => f.endsWith(".whl")) : [];
  if (wheels.length === 0) {
    throw new Error(
      `no kathara-api-rest wheel in ${path.relative(root, vendorDir)} — run \`make wheel\` ` +
        `(python -m build --wheel --outdir services/desktop/vendor .) first`,
    );
  }
  if (wheels.length > 1) {
    throw new Error(
      `${wheels.length} wheels in ${path.relative(root, vendorDir)} (${wheels.sort().join(", ")}) — ` +
        `refusing to guess which one to vendor. Delete the stale ones, or run \`make wheel\`, ` +
        `which clears them before building.`,
    );
  }
  return path.join(vendorDir, wheels[0]);
}

function pip(args, { capture = false } = {}) {
  const res = spawnSync(hostPython(), ["-m", "pip", ...args], {
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    encoding: "utf8",
  });
  // res.error covers the case pip never ran at all (no such interpreter) — without it that shows
  // up as an empty failure whose message blames the dependency graph.
  if (res.error) throw new Error(`could not run "${hostPython()} -m pip": ${res.error.message}`);
  return { ok: res.status === 0, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

/**
 * Pass A. `--target` + `--only-binary=:all:` is what unlocks `--python-version`, which makes
 * `python_version` markers resolve for the interpreter this app ships rather than for whatever
 * Python happens to run this script. No `--platform`: the runner's own platform is the target OS,
 * and leaving the arch unconstrained lets the resolver pick the newest coherent set instead of
 * backtracking around a single missing cross-arch wheel — pass B is where a missing wheel is
 * supposed to be reported, one package at a time.
 */
function resolveClosure(wheel) {
  const tmp = mkdtempSync(path.join(tmpdir(), "vendor-deps-resolve-"));
  const reportPath = path.join(tmp, "report.json");
  try {
    const res = pip([
      "install", "--dry-run", "--ignore-installed", "--quiet",
      "--report", reportPath,
      "--target", path.join(tmp, "target"),
      "--only-binary=:all:",
      "--python-version", PY_TAG, "--implementation", "cp", "--abi", ABI_TAG,
      wheel,
    ], { capture: true });
    if (!res.ok) {
      process.stderr.write(res.stdout + res.stderr);
      throw new Error("could not resolve the dependency closure — see pip's output above");
    }
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    if (!Array.isArray(report.install)) {
      throw new Error(`unexpected pip report schema (version ${report.version ?? "?"}): no "install" array`);
    }
    const packages = report.install.map((entry) => ({
      name: entry.metadata.name,
      version: entry.metadata.version,
    }));
    // The one package whose absence would produce a perfectly healthy-looking site-packages tree
    // with no backend in it — worth an explicit assertion rather than a runtime ImportError.
    if (!packages.some((pkg) => normalize(pkg.name) === normalize("kathara-api-rest"))) {
      throw new Error("resolved closure does not contain kathara-api-rest — refusing to vendor it");
    }
    return packages;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Pass B, for one (os, arch). Returns the packages it deliberately skipped. */
function vendorTarget(os, arch, wheel, packages) {
  const destDir = path.join(vendorDir, `site-packages-${os}-${arch}`);
  const manifestPath = path.join(destDir, "vendor-manifest.json");
  const manifest = {
    python: PY_TAG,
    abi: ABI_TAG,
    // The local wheel by *content*, not just by the name==version below. kathara-api-rest is the
    // one package here whose source changes without its version changing — a developer editing
    // src/kathara_api and rebuilding produces a different 0.1.4 wheel every time — so keying on
    // the version alone would report "already vendored" and quietly ship the previous build's
    // backend inside the installer.
    backend: createHash("sha256").update(readFileSync(wheel)).digest("hex").slice(0, 16),
    packages: packages.map((p) => `${p.name}==${p.version}`).sort(),
  };

  // Idempotent like fetch-python.mjs, but keyed on the resolution rather than a marker file: a
  // newer dependency changes the manifest and forces a clean re-vendor. Deliberately not a
  // dotfile — it ships inside the app (electron-builder copies this directory wholesale) and
  // paths.ts's appImagePythonCache() reads it back as the cache key for the one case that has to
  // copy this tree out of the read-only AppImage mount.
  if (existsSync(manifestPath)) {
    try {
      if (readFileSync(manifestPath, "utf8") === JSON.stringify(manifest, null, 2)) {
        console.log(`[vendor-deps] ${os}/${arch}: already vendored (${packages.length} packages), skipping`);
        return [];
      }
    } catch {
      // Unreadable manifest: fall through and re-vendor from scratch.
    }
  }

  // From scratch, never incrementally: a package that dropped out of the closure would otherwise
  // stay behind and keep being importable, which is precisely the kind of drift shipping the whole
  // environment inside the app is meant to make impossible.
  rmSync(destDir, { recursive: true, force: true });
  mkdirSync(destDir, { recursive: true });

  const platformArgs = TARGETS[os][arch].flatMap((tag) => ["--platform", tag]);
  const skipped = [];

  for (const { name, version } of packages) {
    // kathara-api-rest isn't on any index — install the local wheel by path. It's py3-none-any, so
    // the same file is correct for every target.
    const spec = normalize(name) === normalize("kathara-api-rest") ? wheel : `${name}==${version}`;
    const res = pip([
      "install", "--target", destDir,
      "--no-deps", "--upgrade", "--no-compile", "--quiet",
      "--only-binary=:all:",
      "--python-version", PY_TAG, "--implementation", "cp", "--abi", ABI_TAG,
      ...platformArgs,
      spec,
    ], { capture: true });

    if (res.ok) continue;

    if (OPTIONAL_ACCELERATORS.has(normalize(name))) {
      console.warn(
        `[vendor-deps] ${os}/${arch}: ${name} ${version} has no compatible wheel — skipped ` +
          `(optional accelerator, the backend runs without it)`,
      );
      skipped.push(name);
      continue;
    }

    process.stderr.write(res.stdout + res.stderr);
    throw new Error(
      `${os}/${arch}: ${name} ${version} has no wheel for this target and is not an optional ` +
        `accelerator. Either it genuinely cannot be shipped for ${os}/${arch} (drop the target, or ` +
        `pin a version that publishes one), or it belongs in OPTIONAL_ACCELERATORS — decide which, ` +
        `deliberately.`,
    );
  }

  writeFileSync(path.join(destDir, "sitecustomize.py"), SITECUSTOMIZE);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(
    `[vendor-deps] ${os}/${arch}: ${packages.length - skipped.length} packages vendored to ` +
      `${path.relative(root, destDir)}${skipped.length ? ` (${skipped.length} skipped)` : ""}`,
  );
  return skipped;
}

function main() {
  const os = process.argv[2];
  // Optional third arg restricts the vendoring to a single arch (e.g. a host-only build that only
  // needs its own arch — see the Makefile's `vendor-deps-host`). Omit it for all of them, as CI does.
  const archFilter = process.argv[3];
  if (!TARGETS[os]) {
    console.error(`usage: node vendor-python-deps.mjs <${Object.keys(TARGETS).join("|")}> [arch]`);
    process.exit(1);
  }
  let arches = Object.keys(TARGETS[os]);
  if (archFilter) {
    if (!arches.includes(archFilter)) {
      console.error(`no target for ${os}/${archFilter} (known archs: ${arches.join(", ")})`);
      process.exit(1);
    }
    arches = [archFilter];
  }

  // pip's --report is the machine-readable resolution output pass A depends on (pip >= 23.0).
  // Through pip() rather than execFileSync so a missing interpreter reports itself as such instead
  // of as a raw spawnSync ENOENT trace.
  const version = pip(["--version"], { capture: true });
  const major = Number(version.stdout.match(/pip (\d+)/)?.[1] ?? 0);
  if (!version.ok || major < 23) {
    console.error(`pip >= 23 is required for --report (found: ${version.stdout.trim() || "nothing"})`);
    process.exit(1);
  }

  const wheel = localWheel();
  console.log(`[vendor-deps] resolving the closure of ${path.basename(wheel)} for Python ${PY_TAG} on ${os}`);
  const packages = resolveClosure(wheel);
  console.log(`[vendor-deps] resolved ${packages.length} packages`);

  for (const arch of arches) vendorTarget(os, arch, wheel, packages);
}

main();
