// Launches Electron for local development.
//
// Exists because of ELECTRON_RUN_AS_NODE: VS Code's extension host exports it, so any terminal
// opened inside the editor inherits it — and with it set, the `electron` binary runs as a plain
// Node process, never creates a window, and `require("electron").app` is undefined. The app
// cannot recover from that on its own, so strip it here before spawning.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const electron = (await import("electron")).default;

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(String(electron), [root, ...process.argv.slice(2)], { env, stdio: "inherit" });

// Without this, killing the launcher leaves the Electron process (and its backend child)
// running, and the next `npm start` dies on the single-instance lock.
// SIGHUP is omitted on purpose: installing a handler for it cancels nohup's ignore, so a
// detached `npm start` would die as soon as its terminal went away.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
