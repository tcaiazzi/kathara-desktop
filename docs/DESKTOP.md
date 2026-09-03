# Kathara IDE — Desktop app internals

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

Which interpreter runs it is decided by `prereqs.ts`'s `pythonCandidates()`, best first: an
interpreter the user picked explicitly (`preferences.json`), a dev checkout's `.venv`, the one
**bundled inside a packaged app** (`paths.ts`'s `bundledPythonPath()` → `resources/python/`,
put there at build time by `scripts/fetch-python.mjs` — so a packaged app needs no system
Python), then `PATH` as a last resort. On a packaged build the backend itself lives in a
private virtualenv under the app's user-data directory, which `install.ts` creates on first run
by `pip install`ing the bundled `kathara-api-rest` wheel (`paths.ts`'s `bundledWheelPath()` →
`resources/vendor/*.whl`) into it.

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

> Running `npm start` from a terminal **inside VS Code** works, but note that VS Code exports
> `ELECTRON_RUN_AS_NODE=1`; `services/desktop/scripts/start.mjs` strips it before launching,
> because with it set Electron runs as plain Node and never opens a window.

## Building installers

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
  way VS Code does — instead of a native title bar with a native menu bar stacked under it. The
  window controls come back as the overlay Chromium paints over that strip on Windows and Linux,
  and as the inset traffic lights on macOS. The strip measures the overlay at runtime
  (`navigator.windowControlsOverlay`, re-measured on `geometrychange`) so its height and its
  right-hand inset always match the real buttons, and it re-colours the overlay when the theme is
  flipped. The whole strip drags the window; interactive parts opt out with `.kt-titlebar-nodrag`.
- **The menu (File / Lab / View / Help) is rendered in HTML** (`desktop/TitleBar.tsx`) and
  dispatches through the same command registry the native menu uses, so both paths run one
  implementation. The native `Menu` stays registered but its bar is hidden, because that `Menu`
  is what binds the keyboard accelerators; on macOS it remains in the system menu bar, where the
  extra *Window* menu also lives. `Ctrl/Cmd+S` is deliberately *not* registered as a native
  accelerator so the keystroke still reaches the editor that has focus — and opening an HTML menu
  does not take focus away from the page, so clicking *Save* saves the panel the user was in.
- Terminal pop-outs keep an ordinary framed window (titled `Terminal: <device>`): they render only
  the terminal, with no strip of their own to drag or close by.
- **Native dialogs** for importing a lab and saving a download, plus *Open Labs Folder* and
  reveal-in-file-manager.
- **Open in system terminal** attaches to a device with `kathara connect` in the OS terminal
  emulator. On Linux the first supported emulator on `PATH` wins; override it with
  `terminalCommand` in `preferences.json` (use `{cmd}` where the command goes).
- **`kathara://lab/<name>`** opens that lab, in the running instance if there is one.
- Quitting with labs still deployed asks first, and offers to undeploy them — their containers
  would otherwise keep running.
- The backend is bound to `127.0.0.1` only and paired with this one launch via the token
  described above; the renderer runs sandboxed and context-isolated with no Node access,
  reaching the shell only through an explicit bridge (`preload.ts`).
