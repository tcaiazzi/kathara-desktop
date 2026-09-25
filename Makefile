# Build/package the Electron desktop app (services/desktop) and its frontend SPA
# (services/frontend). The packaging targets mirror .github/workflows/build-desktop.yml, so a
# local `make dist` produces the same installers a workflow run would; `make check` mirrors
# .github/workflows/ci.yml, the workflow that gates pull requests.
#
# Full pipeline for a packaged installer:
#   wheel -> fetch-python -> vendor-deps -> install -> dist.
# For everyday dev work (no packaging) use `make build`, and `make check` before a PR.

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

# Pin local npm/node invocations to the same Node version CI uses (see .github/workflows/*.yml).
# Only applies when nvm is installed; on CI (no nvm, Node already on PATH via actions/setup-node)
# RUN_NODE is empty and recipes behave exactly as before.
NODE_VERSION := 24
NVM_SH := $(HOME)/.nvm/nvm.sh
ifneq (,$(wildcard $(NVM_SH)))
  RUN_NODE := . $(NVM_SH) && nvm install $(NODE_VERSION) >/dev/null && nvm use $(NODE_VERSION) >/dev/null &&
else
  RUN_NODE :=
endif

.PHONY: all build dist dist-linux dist-mac dist-win appimage \
        install install-frontend install-desktop \
        wheel fetch-python fetch-python-host vendor-deps vendor-deps-host frontend shell \
        check lint typecheck test coverage check-frontend check-desktop check-backend \
        mutation mutation-frontend mutation-desktop mutation-backend \
        clean clean-wheel clean-python clean-deps clean-mutation distclean

all: build

## ---- dependencies ---------------------------------------------------------

install: install-frontend install-desktop

install-frontend:
	$(RUN_NODE) npm ci --prefix $(FRONTEND_DIR)

install-desktop:
	$(RUN_NODE) npm ci --prefix $(DESKTOP_DIR)

## ---- checks (what ci.yml gates pull requests on) --------------------------
## One target per CI job. `check` is all three, in the order the workflow runs them, and is the
## thing to run before opening a PR. These assume dependencies are already installed:
## `make install` for the two Node trees, `pip install -e '.[dev]'` for the backend.

check: check-frontend check-desktop check-backend

check-frontend:
	$(RUN_NODE) npm run lint --prefix $(FRONTEND_DIR)
	$(RUN_NODE) npm run typecheck --prefix $(FRONTEND_DIR)
	$(RUN_NODE) npm run test --prefix $(FRONTEND_DIR)
	$(RUN_NODE) npm run build --prefix $(FRONTEND_DIR)

check-desktop:
	$(RUN_NODE) npm run typecheck --prefix $(DESKTOP_DIR)
	$(RUN_NODE) npm run test --prefix $(DESKTOP_DIR)
	$(RUN_NODE) npm run build --prefix $(DESKTOP_DIR)

# Markers, not a plain `pytest`: the docker/network suites need a daemon and the internet, so CI
# skips them and so does this. Run them by hand when a change touches what they cover.
check-backend:
	ruff check src tests
	pytest -m "not docker and not network"

# Narrower entry points, for the loop you are actually in.
lint:
	$(RUN_NODE) npm run lint --prefix $(FRONTEND_DIR)
	ruff check src tests

typecheck:
	$(RUN_NODE) npm run typecheck --prefix $(FRONTEND_DIR)
	$(RUN_NODE) npm run typecheck --prefix $(DESKTOP_DIR)

test:
	$(RUN_NODE) npm run test --prefix $(FRONTEND_DIR)
	$(RUN_NODE) npm run test --prefix $(DESKTOP_DIR)
	pytest -m "not docker and not network"

# Coverage over the same suites CI runs, a per-file summary in the terminal for each of the three.
# HTML reports land in services/frontend/coverage/ and services/desktop/coverage/ (settings in
# each one's vite.config.ts / vitest.config.ts) and htmlcov/ (backend branch coverage, settings in
# pyproject.toml's [tool.coverage]). Report only, nothing here fails on a low number.
coverage:
	$(RUN_NODE) npm run test:coverage --prefix $(FRONTEND_DIR)
	$(RUN_NODE) npm run test:coverage --prefix $(DESKTOP_DIR)
	pytest -m "not docker and not network" --cov --cov-report=term --cov-report=html

## ---- mutation testing (never in CI) ---------------------------------------
## Coverage says which lines the tests run; mutation testing says which of them the tests would
## notice breaking. Each tool plants one small change at a time (a flipped comparison, a dropped
## branch, an emptied string) and reruns the suite: a change no test fails on is a "survivor".
## Kept out of CI because it is noisy rather than slow (all three take about six minutes on a
## 12-core machine, most of it the backend's ~4,400 mutants): many survivors are equivalent
## mutants no test could tell apart from the original, so read them one by one rather than
## chasing the score. Nothing here fails on a low number.
##
## Needs the `mutation` extra for the backend (`pip install -e '.[dev,mutation]'`, Linux/macOS:
## mutmut forks) and `make install` for the Node trees, where Stryker is a devDependency.

mutation: mutation-frontend mutation-desktop mutation-backend

# Stryker, configured in each tree's stryker.config.mjs. Reports in <tree>/reports/mutation/.
mutation-frontend:
	$(RUN_NODE) npm run test:mutation --prefix $(FRONTEND_DIR)

mutation-desktop:
	$(RUN_NODE) npm run test:mutation --prefix $(DESKTOP_DIR)

# mutmut, configured in pyproject.toml's [tool.mutmut]. Always from scratch, so the numbers are
# those of the current tests and never results mutmut kept from an earlier run in mutants/.
# mutants/src is created before the run and put first on PYTHONPATH, or the editable install
# resolves `kathara_api` to the unmutated src/ (Python caches a path entry that does not exist yet
# as empty). Afterwards: `mutmut results` lists the survivors, `mutmut show <name>` shows one.
mutation-backend:
	rm -rf mutants
	mkdir -p mutants/src
	PYTHONPATH=$(CURDIR)/mutants/src mutmut run

## ---- packaging inputs (wheel + bundled Python interpreter + its dependencies) ----
## Only needed for `dist`; skip these for plain dev builds. `vendor-deps` needs `wheel` (it installs
## it) and declares that; it is otherwise independent of `fetch-python`, which it never reads —
## every version and ABI it resolves against is passed to pip explicitly.

# Both removals are load-bearing, and each covered up a different way of shipping stale code:
#   - build/: setuptools' build_py copies changed sources into build/lib but never removes ones
#     deleted from the source tree, so a dropped file (a retired bundled example, say) keeps being
#     packed into every subsequent wheel.
#   - vendor/*.whl: vendor-python-deps.mjs installs *the* wheel it finds here, so a leftover from
#     before a version bump would be the one vendored into the installer.
wheel:
	python3 -m pip install --upgrade pip build
	rm -rf build *.egg-info
	rm -f $(DESKTOP_DIR)/vendor/*.whl
	python3 -m build --wheel --outdir $(DESKTOP_DIR)/vendor .

fetch-python:
	$(RUN_NODE) cd $(DESKTOP_DIR) && node scripts/fetch-python.mjs $(PLATFORM)

# Only the host's own arch, for host-only targets like `make appimage` (skips the other arch's
# download entirely instead of fetching both, as `fetch-python` does for full multi-arch dist).
fetch-python-host:
	$(RUN_NODE) cd $(DESKTOP_DIR) && node scripts/fetch-python.mjs $(PLATFORM) $(HOST_ARCH)

# Installs the backend's whole dependency closure into vendor/site-packages-$(PLATFORM)-<arch>/, so
# the packaged app downloads and installs nothing on first launch. Must run on the OS it targets:
# pip reads `sys_platform` markers from this machine (see the script's header).
vendor-deps: wheel
	$(RUN_NODE) cd $(DESKTOP_DIR) && node scripts/vendor-python-deps.mjs $(PLATFORM)

vendor-deps-host: wheel
	$(RUN_NODE) cd $(DESKTOP_DIR) && node scripts/vendor-python-deps.mjs $(PLATFORM) $(HOST_ARCH)

## ---- dev builds (no packaging) --------------------------------------------

frontend: install-frontend
	$(RUN_NODE) npm run build --prefix $(FRONTEND_DIR)

shell: install-desktop
	$(RUN_NODE) npm run build --prefix $(DESKTOP_DIR)

build: frontend shell

## ---- installer packaging ---------------------------------------------------

# `clean` first: build.mjs already empties $(DESKTOP_DIR)/build and Vite empties the frontend's
# dist, but nothing empties $(DESKTOP_DIR)/release. A tree that has packaged more than once holds
# the installers of every version built in it, side by side, and they are picked up by glob — so
# the version just built is not necessarily the one that gets shipped or tested.
dist: clean install wheel fetch-python vendor-deps
	$(RUN_NODE) cd $(DESKTOP_DIR) && npm run dist:$(PLATFORM)

dist-linux:
	$(MAKE) dist PLATFORM=linux

dist-mac:
	$(MAKE) dist PLATFORM=mac

dist-win:
	$(MAKE) dist PLATFORM=win

# AppImage only, for the host's own arch only (no deb/rpm, no cross-arch). Quick local package,
# not what CI produces (that's `dist-linux`, all Linux targets x both arches).
appimage: clean install wheel fetch-python-host vendor-deps-host
	$(RUN_NODE) cd $(DESKTOP_DIR) && npm run dist:linux:appimage

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

# Vendored dependency trees from `make vendor-deps`. Separate from clean-python on purpose: this is
# the half that changes when a dependency does, and re-vendoring costs a pip run rather than a
# ~100 MB interpreter download per arch.
clean-deps:
	rm -rf $(DESKTOP_DIR)/vendor/site-packages-*

# Mutation testing's working copy and reports (see `mutation`).
clean-mutation:
	rm -rf mutants $(FRONTEND_DIR)/reports $(DESKTOP_DIR)/reports
	rm -rf $(FRONTEND_DIR)/.stryker-tmp $(DESKTOP_DIR)/.stryker-tmp

# Everything clean removes, plus node_modules. Forces the next build to reinstall/refetch.
distclean: clean clean-wheel clean-python clean-deps
	rm -rf $(FRONTEND_DIR)/node_modules $(DESKTOP_DIR)/node_modules
