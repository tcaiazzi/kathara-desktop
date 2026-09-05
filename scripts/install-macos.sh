#!/usr/bin/env bash
# Installs the runtime prerequisites Kathara Desktop checks for at startup
# (services/desktop/src/prereqs.ts): Docker Desktop, Python 3.10+, Kathara, and this project's
# own backend (kathara-api-rest, not published anywhere — installed from this checkout).
#
# Deliberately installs into <repo>/.venv rather than system-wide: Homebrew's Python is
# "externally managed" (PEP 668) and refuses a plain `pip install`, and the app's own preflight
# already looks for <repo>/.venv/bin/python first (services/desktop/src/paths.ts's
# devVenvPython) — so a checkout that has run this script needs no further configuration to
# launch the desktop app from source.
#
# Needs Homebrew (https://brew.sh). Safe to re-run.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV="$REPO_ROOT/.venv"

say() { printf '\n== %s ==\n' "$1"; }
warn() { printf '  ! %s\n' "$1"; }
pass() { printf '  \xe2\x9c\x93 %s\n' "$1"; }
ok=1

if ! command -v brew >/dev/null 2>&1; then
  echo "Homebrew is required and wasn't found. Install it from https://brew.sh, then re-run this script:"
  echo '  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'
  exit 1
fi

# ---- Docker Desktop ----
say "Docker"
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  pass "Docker already installed and reachable"
else
  if ! command -v docker >/dev/null 2>&1; then
    brew install --cask docker-desktop
  fi
  open -a Docker || true
  warn "Docker Desktop is starting. Finish its first-run setup (license, permissions) if prompted,"
  warn "then re-run this script — Docker can't be verified until it's fully up."
  ok=0
fi

# ---- Python 3.10+ ----
say "Python"
py_ok() { command -v python3 >/dev/null 2>&1 && python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)'; }
if py_ok; then
  pass "Python $(python3 --version | cut -d' ' -f2) found"
else
  warn "Python 3.10+ not found — installing via Homebrew."
  brew install python@3.12
  py_ok && pass "Python $(python3 --version | cut -d' ' -f2) installed" || { warn "Still no usable Python 3.10+."; ok=0; }
fi

# ---- Kathara + this project, into <repo>/.venv ----
say "Kathara Desktop backend (into $VENV)"
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
  echo "Some steps need your attention — see the warnings above, then re-run this script."
fi
exit $((1 - ok))
