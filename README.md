# Kathara Desktop

A desktop app for the [Kathara](https://www.kathara.org) network-emulation framework. Design
lab topologies, edit device configs and files, deploy them as containers, and attach to
interactive shells — from a native app, with no browser tab or server to manage.

## Install

Download the installer for your platform from the
[latest release](https://github.com/KatharaFramework/kathara-desktop/releases/latest):

| Platform | File |
|---|---|
| Linux x86_64 | `Kathara-Desktop-<version>.AppImage`, or `kathara-desktop_<version>_amd64.deb` / `kathara-desktop-<version>.x86_64.rpm` |
| Linux ARM64 | `Kathara-Desktop-<version>-arm64.AppImage`, or the `_arm64.deb` / `.aarch64.rpm` of the same version |
| macOS, Apple Silicon | `Kathara-Desktop-<version>-arm64.dmg` |
| macOS, Intel | `Kathara-Desktop-<version>.dmg` |
| Windows | `Kathara-Desktop-Setup-<version>-x64.exe`, or `-arm64.exe` |

The only prerequisite is **[Docker](https://docs.docker.com/get-docker/)**: the app runs Kathara's
Docker manager, deploying each device as a container through the host Docker socket. On Windows
that means Docker Desktop with the WSL2 backend.

Everything else — Python, Kathara and the app's own backend — is bundled in the installer, so the
first launch downloads and installs nothing and works offline. If something is missing (e.g.
Docker is not running), the app says what is wrong instead of showing a blank window.

Labs are stored per user, outside the app: `~/.config/kathara-desktop/labs` on Linux.

### First launch

Installers are **unsigned**, so the first launch needs a manual override:

| Platform | What you see | What to do |
|---|---|---|
| Windows | SmartScreen warning | *More info* → *Run anyway* |
| macOS | Gatekeeper refuses to open it | Right-click → *Open*, or `xattr -dr com.apple.quarantine "/Applications/Kathara-Desktop.app"` |
| Linux | nothing | — |

There is no auto-update: the app checks GitHub once per launch and points you at a newer release if
there is one, but releases are downloaded and installed manually.

## Features

- A topology view, a file/config editor for `lab.conf` and device files, and terminals attached
  to live devices, which can pop out into their own window.
- **Open Terminal Here** opens your OS terminal in a lab's directory, so `kathara` commands run
  against that lab (override the emulator with `terminalCommand` in `preferences.json`).
- **`kathara://lab/<name>`** links open that lab, in the running instance if there is one.
- Quitting with labs still deployed asks first, and offers to undeploy them — their containers
  would otherwise keep running.

## Not supported yet

- **Docker manager only.** The app works only with Kathara's Docker manager; other managers
  (e.g. Kubernetes/Megalos) are not supported.
- **Single user, local machine.** There is no hosted or multi-user deployment.
- **No layered/hierarchical topology layout** — the graph is force-directed only.

## Security

The app's backend listens on `127.0.0.1` only and is paired with that one launch via a random
token, so another local process or browser tab can't drive it just by finding its port. It is not
a login system: there is one implicit user and no per-user permissions. The backend drives the
host Docker socket, so treat the app as having the same access to your machine as Docker itself.

## Development

To run the app from a checkout, build the installers or run the checks, see
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md). Implementation notes live in
[docs/DESKTOP.md](docs/DESKTOP.md) (Electron shell) and [docs/BACKEND.md](docs/BACKEND.md)
(REST API). Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

GPL-3.0
