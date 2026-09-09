// electron-builder afterPack hook.
//
// The app is deliberately unsigned (electron-builder.yml: identity: null — no Apple Developer
// certificate). On Intel Macs an unsigned app just gets a Gatekeeper "unidentified developer"
// warning that right-click → Open bypasses. On Apple Silicon, macOS additionally refuses to even
// launch an app whose bundle has no signature at all — not a Gatekeeper policy, a kernel-level
// code-signing requirement — and reports it as "damaged" instead, with no GUI override.
//
// `identity: null` skips ALL signing, including the ad-hoc signature that would satisfy that
// requirement (see app-builder-lib's MacPackager.sign(): "identity explicitly is set to null" →
// signing skipped outright). So sign arm64 builds ourselves, ad-hoc (`-s -`, no certificate
// needed), after electron-builder packs the .app but before it's wrapped into a .dmg.
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { Arch } = require("electron-builder");

function sign(targetPath) {
  execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", targetPath], { stdio: "inherit" });
}

function isMachO(filePath) {
  try {
    return execFileSync("/usr/bin/file", ["--brief", filePath]).toString().includes("Mach-O");
  } catch {
    return false;
  }
}

/**
 * Recursively signs every Mach-O file under `dir` (electron-builder's extraResources don't get
 * the deep-signing pass Contents/Frameworks would from a real Developer ID build). Needed for both
 * halves of the bundled Python environment, and for the same reason: Apple Silicon refuses to exec
 * an unsigned Mach-O at all.
 *
 *   Contents/Resources/python/         the interpreter binary, libpython*.dylib, lib-dynload/*.so
 *   Contents/Resources/site-packages/  the C extensions in the vendored dependency closure —
 *                                      pydantic_core, aiohttp, uvloop, yaml, httptools, …
 *
 * Signing the dependencies here, at build time, is what lets every OS run the backend straight out
 * of the bundled interpreter. The alternative the app used to have — pip installing them at first
 * launch — could never work on macOS, because writing into Contents/Resources invalidates the seal
 * this signature creates and the app then refuses to launch.
 *
 * Symlinks (python-build-standalone ships e.g. bin/python3 -> python3.12) are skipped: the real
 * file they point to is signed anyway when readdir reaches it as its own entry.
 */
function signMachOTree(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) signMachOTree(full);
    else if (entry.isFile() && isMachO(full)) sign(full);
  }
}

exports.default = async function (context) {
  if (context.electronPlatformName !== "darwin" || context.arch !== Arch.arm64) return;

  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const frameworksDir = path.join(appPath, "Contents", "Frameworks");
  const pythonDir = path.join(appPath, "Contents", "Resources", "python");
  const sitePackagesDir = path.join(appPath, "Contents", "Resources", "site-packages");
  // Nested code first — frameworks, the bundled Python interpreter and its vendored dependencies,
  // and helper .app bundles under Contents/Frameworks — then the outer bundle last, so its
  // signature is computed over already-signed contents (avoids --deep, which Apple's own docs
  // discourage: it can silently miss or mis-sign nested code).
  if (fs.existsSync(frameworksDir)) {
    for (const entry of fs.readdirSync(frameworksDir)) sign(path.join(frameworksDir, entry));
  }
  if (fs.existsSync(pythonDir)) signMachOTree(pythonDir);
  if (fs.existsSync(sitePackagesDir)) signMachOTree(sitePackagesDir);
  sign(appPath);
};
