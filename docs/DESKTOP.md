# Kathara Desktop — App internals

Implementation notes for the Electron shell (`services/desktop`). See the [README](../README.md)
for how to run and build it; this document covers the "why" behind its behaviour.

## Startup sequence

`main.ts` picks a free loopback port and calls `backend.ts`'s `buildBackendCommand`, which:

- Generates a random per-launch pairing token (`crypto.randomBytes(32)`), passed to the child
  process as `KATHARA_API_AUTH_TOKEN`. Every later request this process makes to that exact
  backend instance — `waitForHealth`, `shutdownAt`, the `/api/system` admin check — carries it
  as `Authorization: Bearer <token>` (see [BACKEND.md](BACKEND.md)'s "Authentication" for the
  server side). The token is never persisted (unlike the port, in `prefs.ts`): it exists only
  to pair this one backend process with this one Electron instance, so another local
  process/tab that finds the port still can't call it without also reading the token from the
  renderer's own context-isolated preload bridge.
- Sets `KATHARA_API_STATIC_DIR` to the built frontend and `KATHARA_API_LABS_DIR` to the
  per-user lab directory.

Which interpreter runs it is decided by `prereqs.ts`'s `pythonCandidates()`, and a packaged app
has exactly one: the interpreter **bundled inside it** (`paths.ts`'s `bundledPythonPath()` →
`resources/python/`, put there at build time by `scripts/fetch-python.mjs`), with the backend's
dependency closure shipped beside it at `resources/site-packages/` (`bundledSitePackages()`, put
there by `scripts/vendor-python-deps.mjs`) and handed to the interpreter on `PYTHONPATH` —
`backend.ts`'s `pythonEnv()`, which `prereqs.ts` probes under too, since a probe without it would
report every backend import as missing.

There is deliberately no fallback: a system Python on `PATH` would be missing the backend's
packages, and an interpreter nominated by the user is one whose contents the app cannot vouch for.
If the bundled one is gone, the installation is damaged and reinstalling is the honest answer.

A dev checkout is the only place this is still a search — the repo's `.venv` first, then `PATH` —
and there a candidate is only accepted if it actually satisfies the checks: an interpreter that
imports `kathara_api` but not `kathara_api.main` (an environment installed before a dependency was
declared) loses to one that imports both.

`main.ts` then spawns `uvicorn` with that command, waits for `/api/health`, and loads
`http://127.0.0.1:<port>/`. Because the UI is served over HTTP from the same origin as the
API, relative `/api` calls, the terminal WebSocket, the stats `EventSource` and
`BrowserRouter` deep links all work exactly as they do in a browser. The one Electron-specific
step is on the frontend side: `services/frontend/src/services/api.ts` calls
`desktop().getAuthToken()` once per page load (a preload-bridge IPC round-trip to `main.ts`'s
`"auth:get-token"` handler, which reads `backend.ts`'s `backendToken()`) and caches the result,
attaching it to every request afterwards. A native `WebSocket`/`EventSource` can't set a
custom header, so `ttyWsUrl`/`statsStreamUrl` append `?token=` instead — the same fallback
`require_auth_token` accepts on the server.

Elevated (root) backend starts and orphan-backend recovery go through the same
`buildBackendCommand` and carry the same token; see the `runElevatedLinux`/
`runElevatedNative`/`markOrphaned` functions in `backend.ts` for the retry/cleanup paths.

### What is validated on the way into a privileged context

`@vscode/sudo-prompt` takes a single command **string** — it exposes no argv API — and writes it
verbatim into a `/bin/sh` script on macOS and a `.bat` line on Windows, so on those platforms the
elevated command line is shell-interpreted. (Linux never uses it for the backend: `runElevatedLinux`
passes argv to `spawn("sudo", …)`, with no shell.) Two values could otherwise reach that string, or
the env sudo-prompt writes alongside it as `export KEY="value"`, from outside this process:

- **the labs directory**, which the renderer proposes over `labs:set-dir` and which becomes
  `KATHARA_API_LABS_DIR`. `main.ts`'s `setLabsDir` applies it only if it is a plain absolute path
  *and* the user actually chose it in the native folder dialog during this run (`labs:pick-dir`
  records what it offered) or it is the app's own default. `paths.ts`'s `labsDir()` re-checks the
  value it reads back, since `preferences.json` is parsed without schema validation and is the one
  route that bypasses the handler.
- **the interpreter path**, `preferences.json`'s `pythonPath`, which outranks every other candidate
  in `prereqs.ts`'s `pythonCandidates()`. Validated where it is recorded
  (`status:pick-python`), where it is read (`pythonCandidates`), and once more in
  `runElevatedNative` before the string is built.

Both go through `safety.ts`'s `isPlainAbsolutePath`, which rejects shell metacharacters outright
rather than trying to escape them — quoting a `.bat` line correctly is hard enough that "safe by
construction" is the better guarantee. `quoteForShellString` (single quotes on POSIX, doubled `""`
on Windows) is the second line, not the only one.

> Running `npm start` from a terminal **inside VS Code** works, but note that VS Code exports
> `ELECTRON_RUN_AS_NODE=1`; `services/desktop/scripts/start.mjs` strips it before launching,
> because with it set Electron runs as plain Node and never opens a window.

## The bundled Python environment

A packaged build ships the backend's environment already installed — there is no runtime install
step at all, on any OS. Two build-time scripts produce it, both into the gitignored
`services/desktop/vendor/`:

| script | output | shipped as |
|---|---|---|
| `fetch-python.mjs` | `python-<os>-<arch>/` | `resources/python/` |
| `vendor-python-deps.mjs` | `site-packages-<os>-<arch>/` | `resources/site-packages/` |

Both are scoped per `(os, arch)` by `electron-builder.yml`, so an x64 installer never carries the
arm64 payload.

The dependencies are a plain `pip install --target` tree rather than a virtualenv or an install
into the interpreter's own `site-packages`, and that is what makes every OS behave the same: it
needs **nothing writable inside the app at runtime**. That mattered because the alternative never
worked everywhere — installing at first launch is impossible on an AppImage's read-only squashfs,
on a root-owned `/opt` from the `.deb`/`.rpm`, in a Program Files directory chosen in the NSIS
installer, and on macOS, where adding files under `Contents/Resources` invalidates the ad-hoc
signature `afterPack` applies and Apple Silicon then refuses to launch the app at all. (That last
one is also why `scripts/sign-mac-arm64.js` signs the Mach-O files under `site-packages/` as well
as under `python/`.)

Because the environment lives inside the app, an update replaces it wholesale. There is no
surviving previous-release environment to skew against the new frontend, and so nothing here needs
to detect or repair one.

Two consequences worth knowing:

- `vendor-python-deps.mjs` **must run on the OS it targets** — pip evaluates `sys_platform`
  markers from the machine it runs on, which is why CI vendors in the same per-OS job that
  packages. It fails the build if a dependency has no wheel for a target, except for an explicit
  allowlist of optional accelerators (`httptools`, `uvloop`, `watchfiles`): `httptools` publishes
  no `win_arm64` wheel, and uvicorn falls back to `h11` without it.
- `--no-compile`, so `.pyc` files are built at runtime instead. A build-time `.pyc` is invalidated
  the moment electron-builder rewrites the source's mtime, and Python would then try to rewrite it
  in a read-only directory on every import. `PYTHONPYCACHEPREFIX` points at the user-data
  directory instead (`paths.ts`'s `pycacheDir()`); the elevated backend gets a separate subtree, so
  root-owned cache files can't stop later unprivileged launches from refreshing them.

### The AppImage exception

An AppImage FUSE-mounts itself under `/tmp/.mountXXXXXX/` **as the launching user**, and root does
not bypass a FUSE mount's ownership the way it bypasses ordinary file permissions. So an *elevated*
backend started from the shipped paths could neither exec the interpreter nor read a module.
`paths.ts`'s `appImagePythonCache()` copies both trees out to the user-data directory and hands
those paths back instead — lazily, from the elevated start paths only, since elevation is an
explicit user action already behind a password prompt while every ordinary launch would otherwise
pay ~200 MB of disk for a feature most users never touch. Same idiom as `resolveStaticDir()` uses
for the frontend, and keyed on the vendored dependency manifest's content for the same reason.

## Building installers

- `npm run dist:<os>` packages only. It does **not** build the backend wheel, fetch the
  interpreter or vendor the dependencies — run `scripts/fetch-python.mjs <os>` and
  `scripts/vendor-python-deps.mjs <os>` first, or use `make dist-<os>`, which does the whole
  sequence. Skipping either script produces an installer that builds cleanly and ships an app that
  cannot start.
- Each target must be built on its own platform: `.dmg` requires macOS. `.deb` additionally
  requires an **x86_64** host — electron-builder ships `fpm` (which produces the `.deb`) only
  for `linux-x86`, so it cannot be produced on an arm64 machine even though the resulting
  package itself targets both architectures.
- Installers are unsigned (no code-signing certificate for any platform), hence the manual
  overrides documented in the README. On macOS, `scripts/sign-mac-arm64.js` still applies an
  *ad-hoc* signature to the arm64 build in `electron-builder.yml`'s `afterPack` hook — Apple
  Silicon refuses to launch an entirely unsigned app at all, unlike Intel, where Gatekeeper's
  "unidentified developer" bypass is enough.
- No auto-update: `electron-updater` is unreliable on unsigned Windows and macOS builds, so
  `publish: null` and releases are installed manually.

## Desktop-only behaviour

- **Custom title bar.** The window has no native title bar (`titleBarStyle: "hidden"`): the app
  draws a single strip carrying the brand, the menu, the window title and the status badge, the
  way VS Code does — instead of a native title bar with a native menu bar stacked under it. On
  macOS that leaves the native traffic lights inset over the strip, and nothing more to do. On
  Windows and Linux it leaves *no* native window controls at all, and no `titleBarOverlay` is
  requested either: Chromium's overlay buttons take only a background and a symbol colour, not a
  different icon style, which is exactly what looked out of place. `desktop/TitleBar.tsx` draws its
  own minimize/maximize/close buttons there instead (again VS Code's approach), driven by the
  `window:minimize`/`maximize`/`unmaximize`/`close` IPC; the maximize/restore icon follows the real
  window through the `window:state` push, so it stays right however the state changed — including a
  double-click on the strip or a keyboard shortcut. `build/setup.html` and `build/splash.html`, which
  load before the SPA exists, prepend their own minimize/close pair for the same reason. The whole
  strip drags the window; interactive parts opt out with `.kt-titlebar-nodrag`.
- **The menu (File / Lab / View / Help) is rendered in HTML** (`desktop/TitleBar.tsx`) and
  dispatches through the same command registry the native menu uses, so both paths run one
  implementation. The native `Menu` stays registered but its bar is hidden, because that `Menu`
  is what binds the keyboard accelerators; on macOS it remains in the system menu bar, where the
  extra *Window* menu also lives. `Ctrl/Cmd+S` is deliberately *not* registered as a native
  accelerator so the keystroke still reaches the editor that has focus — and opening an HTML menu
  does not take focus away from the page, so clicking *Save* saves the panel the user was in.
- Terminal pop-outs keep an ordinary framed window (titled `Terminal: <device>`): they render only
  the terminal, with no strip of their own to drag or close by.
- **Native dialogs** for importing a lab, saving a download and choosing the host directory of a
  device's `[volume]` bind mount, plus *Open Labs Folder* and reveal-in-file-manager. The volume
  one is desktop-only on purpose (`integrations.ts`'s `pickHostDirectory`): the path names a
  directory on the machine the *backend* runs on, and only this shell — which spawned that backend
  — can know the two are the same machine. It also spares the app from reimplementing per-OS path
  browsing, which on Windows means drive letters (there is no single root), backslash separators
  and UNC shares. The browser build renders that field as a plain text input.
- **Open in system terminal** attaches to a device with `kathara connect` in the OS terminal
  emulator. On Linux the first supported emulator on `PATH` wins; override it with
  `terminalCommand` in `preferences.json` (use `{cmd}` where the command goes).
- **`kathara://lab/<name>`** opens that lab, in the running instance if there is one.
- Quitting with labs still deployed asks first, and offers to undeploy them — their containers
  would otherwise keep running.
- The backend is bound to `127.0.0.1` only and paired with this one launch via the token
  described above; the renderer runs sandboxed and context-isolated with no Node access,
  reaching the shell only through an explicit bridge (`preload.ts`).
