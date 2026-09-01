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

exports.default = async function (context) {
  if (context.electronPlatformName !== "darwin" || context.arch !== Arch.arm64) return;

  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const frameworksDir = path.join(appPath, "Contents", "Frameworks");
  // Nested code first — frameworks and helper .app bundles under Contents/Frameworks — then the
  // outer bundle last, so its signature is computed over already-signed contents (avoids --deep,
  // which Apple's own docs discourage: it can silently miss or mis-sign nested code).
  if (fs.existsSync(frameworksDir)) {
    for (const entry of fs.readdirSync(frameworksDir)) sign(path.join(frameworksDir, entry));
  }
  sign(appPath);
};
