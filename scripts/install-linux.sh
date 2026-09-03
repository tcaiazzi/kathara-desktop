#!/usr/bin/env bash
# Installs the runtime prerequisites Kathara IDE's desktop app checks for at startup
# (services/desktop/src/prereqs.ts): Docker, Python 3.10+, Kathara, and this project's own
# backend (kathara-api-rest, not published anywhere — installed from this checkout).
#
# Deliberately installs into <repo>/.venv rather than system-wide: PEP 668 blocks a plain
# `pip install` on modern Debian/Ubuntu/Fedora ("externally managed environment"), and the app's
# own preflight already looks for <repo>/.venv/bin/python first
# (services/desktop/src/paths.ts's devVenvPython) — so a checkout that has run this script needs
# no further configuration to launch the desktop app from source.
#
# Supports apt (Debian/Ubuntu), dnf (Fedora/RHEL) and pacman (Arch). Safe to re-run.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV="$REPO_ROOT/.venv"
SUDO=""
[ "$(id -u)" -eq 0 ] || SUDO="sudo"

ok=1
say() { printf '\n== %s ==\n' "$1"; }
warn() { printf '  ! %s\n' "$1"; }
pass() { printf '  \xe2\x9c\x93 %s\n' "$1"; }

# Package names differ per distro, so callers pass a *role* rather than a package list:
# `python3-venv`/`python3-pip` are Debian-only spellings (Fedora ships venv inside `python3`,
# Arch calls the interpreter `python`), and passing them to dnf/pacman just fails.
pkg_install_role() {
  case "$1" in
    python)
      if command -v apt-get >/dev/null 2>&1; then
        $SUDO apt-get update -qq && $SUDO apt-get install -y python3 python3-venv python3-pip
      elif command -v dnf >/dev/null 2>&1; then
        # No python3-venv on Fedora/RHEL: the venv module ships with python3 itself.
        $SUDO dnf install -y python3 python3-pip
      elif command -v pacman >/dev/null 2>&1; then
        # Arch's python IS Python 3, and venv is in the standard library package.
        $SUDO pacman -Sy --noconfirm python python-pip
      else
        warn "No supported package manager (apt/dnf/pacman) found — install Python 3.10+ manually."
        return 1
      fi
      ;;
    *)
      warn "internal error: unknown package role '$1'"
      return 1
      ;;
  esac
}

# ---- Docker ----
say "Docker"
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  pass "Docker already installed and reachable"
elif command -v docker >/dev/null 2>&1; then
  warn "Docker is installed but its daemon isn't reachable."
  if ! groups "$USER" | grep -qw docker; then
    warn "Your user isn't in the 'docker' group yet — adding it."
    $SUDO usermod -aG docker "$USER"
    warn "Log out and back in (or run 'newgrp docker') for that to take effect."
  else
    warn "Start the Docker service, e.g.: sudo systemctl start docker"
  fi
  ok=0
else
  # Docker's own official convenience script — see https://get.docker.com
  curl -fsSL https://get.docker.com | $SUDO sh
  $SUDO usermod -aG docker "$USER"
  if $SUDO docker info >/dev/null 2>&1; then
    pass "Docker installed"
    warn "Log out and back in (or run 'newgrp docker') so your user can run docker without sudo."
  else
    warn "Docker installed but the daemon isn't up yet — check 'sudo systemctl status docker'."
    ok=0
  fi
fi

# ---- Python 3.10+ ----
say "Python"
py_ok() { command -v python3 >/dev/null 2>&1 && python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)'; }
if py_ok; then
  pass "Python $(python3 --version | cut -d' ' -f2) found"
else
  warn "Python 3.10+ not found — installing."
  pkg_install_role python || ok=0
  py_ok && pass "Python $(python3 --version | cut -d' ' -f2) installed" || { warn "Still no usable Python 3.10+."; ok=0; }
fi

# ---- Kathara + this project, into <repo>/.venv ----
say "Kathara IDE backend (into $VENV)"
if py_ok; then
  [ -x "$VENV/bin/python" ] || python3 -m venv "$VENV"
  "$VENV/bin/pip" install --upgrade pip -q
  "$VENV/bin/pip" install -q kathara "uvicorn[standard]"
  "$VENV/bin/pip" install -q -e "$REPO_ROOT"
  pass "kathara, uvicorn and kathara-api-rest installed into $VENV"
else
  warn "Skipped — no usable Python."
  ok=0
fi

say "Summary"
if [ "$ok" -eq 1 ]; then
  echo "All set. Run the desktop app with: cd services/desktop && npm start"
else
  echo "Some steps need your attention — see the warnings above."
fi
exit $((1 - ok))
