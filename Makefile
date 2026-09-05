# Build/package the Electron desktop app (services/desktop) and its frontend SPA
# (services/frontend). Mirrors the CI pipeline in .github/workflows/build-desktop.yml so a
# local `make dist` produces the same installers a workflow run would.
#
# Full pipeline for a packaged installer: wheel -> fetch-python -> install -> dist.
# For everyday dev work (no packaging) use `make build`.

DESKTOP_DIR := services/desktop
FRONTEND_DIR := services/frontend

UNAME_S := $(shell uname -s)
ifeq ($(UNAME_S),Linux)
  PLATFORM ?= linux
else ifeq ($(UNAME_S),Darwin)
  PLATFORM ?= mac
else
  PLATFORM ?= win
endif

# electron-builder's own arch names (see fetch-python.mjs's TARGETS), derived from the host CPU.
UNAME_M := $(shell uname -m)
ifeq ($(UNAME_M),x86_64)
  HOST_ARCH := x64
else ifeq ($(UNAME_M),aarch64)
  HOST_ARCH := arm64
else ifeq ($(UNAME_M),arm64)
  HOST_ARCH := arm64
else
  HOST_ARCH := $(UNAME_M)
endif

.PHONY: all build dist dist-linux dist-mac dist-win appimage \
        install install-frontend install-desktop \
        wheel fetch-python fetch-python-host frontend shell \
        clean clean-wheel clean-python distclean

all: build

## ---- dependencies ---------------------------------------------------------

install: install-frontend install-desktop

install-frontend:
	npm ci --prefix $(FRONTEND_DIR)

install-desktop:
	npm ci --prefix $(DESKTOP_DIR)

## ---- packaging inputs (wheel + bundled Python interpreter) ----------------
## Only needed for `dist`; skip these for plain dev builds.

wheel:
	python3 -m pip install --upgrade pip build
	python3 -m build --wheel --outdir $(DESKTOP_DIR)/vendor .

fetch-python:
	cd $(DESKTOP_DIR) && node scripts/fetch-python.mjs $(PLATFORM)

# Only the host's own arch, for host-only targets like `make appimage` (skips the other arch's
# download entirely instead of fetching both, as `fetch-python` does for full multi-arch dist).
fetch-python-host:
	cd $(DESKTOP_DIR) && node scripts/fetch-python.mjs $(PLATFORM) $(HOST_ARCH)

## ---- dev builds (no packaging) --------------------------------------------

frontend: install-frontend
	npm run build --prefix $(FRONTEND_DIR)

shell: install-desktop
	npm run build --prefix $(DESKTOP_DIR)

build: frontend shell

## ---- installer packaging ---------------------------------------------------

dist: install wheel fetch-python
	cd $(DESKTOP_DIR) && npm run dist:$(PLATFORM)

dist-linux:
	$(MAKE) dist PLATFORM=linux

dist-mac:
	$(MAKE) dist PLATFORM=mac

# ELECTRON_BUILDER_7Z_FILTER: see the same override in .github/workflows/build-desktop.yml —
# without it the arm64 payload is compressed with a filter the installer can't extract.
dist-win:
	ELECTRON_BUILDER_7Z_FILTER=BCJ2 $(MAKE) dist PLATFORM=win

# AppImage only, for the host's own arch only (no deb/rpm, no cross-arch). Quick local package,
# not what CI produces (that's `dist-linux`, all Linux targets x both arches).
appimage: install wheel fetch-python-host
	cd $(DESKTOP_DIR) && npm run dist:linux:appimage

## ---- clean -----------------------------------------------------------------

clean:
	rm -rf $(FRONTEND_DIR)/dist
	rm -rf $(DESKTOP_DIR)/build
	rm -rf $(DESKTOP_DIR)/release
	find $(FRONTEND_DIR) $(DESKTOP_DIR) -name '*.tsbuildinfo' -delete

# Setuptools/build leftovers from `make wheel` (root build/ dir, *.egg-info, the wheel itself).
clean-wheel:
	rm -rf build *.egg-info
	rm -f $(DESKTOP_DIR)/vendor/*.whl

# Bundled Python interpreters fetched by `make fetch-python` (large, re-downloaded on demand).
clean-python:
	rm -rf $(DESKTOP_DIR)/vendor/python-*

# Everything clean removes, plus node_modules. Forces the next build to reinstall/refetch.
distclean: clean clean-wheel clean-python
	rm -rf $(FRONTEND_DIR)/node_modules $(DESKTOP_DIR)/node_modules
