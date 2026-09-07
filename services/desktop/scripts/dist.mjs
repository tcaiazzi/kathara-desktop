// Runs electron-builder for the `dist:*` npm scripts, forwarding whatever target flags the caller
// passed (`npm run dist -- --win`, `-- --linux AppImage`, …) and always pinning the config file.
//
// Its reason to exist is the environment it sets up: ELECTRON_BUILDER_7Z_FILTER has to be BCJ2 for
// every Windows build, and there is no way to express that in electron-builder.yml. It used to be
// declared by each caller instead — the two GitHub workflows and the Makefile's `dist-win` — which
// left `npm run dist:win` (the command README.md and docs/DESKTOP.md tell a maintainer to run, and
// what a bare `make dist` resolves to on a Windows host) as the one entrance without it, silently
// shipping a broken arm64 installer. Setting it here means every caller inherits it, so there is
// one place to get it right instead of four.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);

// electron-builder's own spellings for "build for Windows". With no platform flag at all it builds
// for the host, so a bare `npm run dist` on Windows needs the same treatment as an explicit --win.
const WINDOWS_FLAGS = new Set(["--win", "--windows", "-w"]);
const PLATFORM_FLAGS = new Set([...WINDOWS_FLAGS, "--mac", "--macos", "-m", "-o", "--linux", "-l"]);

const targetsWindows =
  args.some((arg) => WINDOWS_FLAGS.has(arg)) ||
  (!args.some((arg) => PLATFORM_FLAGS.has(arg)) && process.platform === "win32");

const env = { ...process.env };
if (targetsWindows) {
  // electron-builder 26's 7-Zip applies the ARM64 branch filter to arm64 executables, and the
  // nsis7z extractor bundled in the installer can't decode it: every filtered file (the app exe,
  // every DLL, python.exe) is dropped silently at install time on Windows on ARM, leaving an
  // installed app with no executable. BCJ2 is what electron-builder 25 produced.
  env.ELECTRON_BUILDER_7Z_FILTER = "BCJ2";
}

// The package ships a plain CommonJS shim as its `bin`, so running it with the current interpreter
// works identically on every platform — unlike node_modules/.bin/electron-builder, which is a .cmd
// on Windows and would need a shell to spawn.
const cli = createRequire(import.meta.url).resolve("electron-builder/cli.js");

const child = spawn(process.execPath, [cli, "--config", "electron-builder.yml", ...args], {
  cwd: root,
  stdio: "inherit",
  env,
});

child.on("error", (err) => {
  console.error(`failed to start electron-builder: ${err.message}`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  // Signal deaths have no exit code; report them as a failure rather than as success.
  process.exit(signal ? 1 : (code ?? 1));
});
