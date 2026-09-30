---
name: kathara-desktop-coding-style
description: "How to write code and comments in kathara-desktop — which shared helper to reuse instead of writing a new one, when to factor duplication out, and how to write a comment that still makes sense to a stranger. Use when writing or editing any .py/.ts/.tsx file in this repo, when reviewing a change before commit, or when tempted to add a helper that may already exist."
user-invocable: true
---

# kathara-desktop coding style

Prescriptive rules: *how* to write. For *where* things are and why the architecture is shaped the
way it is, use `kathara-desktop-architecture` and `docs/BACKEND.md` — this skill points at them
rather than restating them. For cross-cutting runtime invariants, see `docs/DESIGN-NOTES.md`.

## Reuse before you add

Before writing a helper, look for the one that exists. These are the places the repo has already
decided; a second implementation is a bug, not a style preference.

**Backend**

- `lab_conf_options.py` owns every `lab.conf` option name. Never spell one locally.
- `KatharaService.get_lab_or_reconstruct()` is the only way to resolve a lab by id. A lab's id is
  `lab_store.lab_id_for(directory)` — never build one from a name, and never take a name where a
  per-lab method takes `lab_id`.
- All disk access goes through `LabStore`. Bytes arriving from someone else's archive or repo go
  through `_read_bounded` / `_copy_with_cap` and the `ApiSettings` caps.
- Model → schema conversion goes through `services/serializers.py`. Never assemble a `LabDetail`
  field by field in a router.
- `get_settings()` is called at point of use — never captured at import time or in a closure,
  because `PUT /settings` mutates the singleton in place.
- Already written, don't re-derive: `downloads.attachment_headers`,
  `schemas/common.reject_lab_conf_quotes`, `config.format_mb`, `dependencies.is_origin_allowed`.

**Frontend**

- `services/api.ts` is the only module that calls `fetch`. A `WebSocket` or `EventSource` still
  takes its URL from `api.ttyWsUrl` / `api.statsStreamUrl` / `api.labEventsUrl`.
- `useBusyAction` is the busy/try/catch/toast/finally shell. Never hand-roll it, and never leave a
  request in a component un-abortable.
- `useDeployGate` gates every path that can put a container on the host, and takes the lab id:
  with the desktop shell the password it asks for is what grants the deploy, which the backend
  refuses otherwise. Handle both outcomes; `cancelled` means don't deploy.
- `useReportError` is how an error reaches the user: the toast, plus the offer to reclaim files a
  device left owned by root when the error is a `LabFilePermissionError`. `useBusyAction` already
  goes through it; a hand-written catch should too, not call `toast.reportError` directly.
- `useLabFilesSync` keeps every tree over the open lab's folder in step: a new tree over it wraps
  its source in `useAnnouncingSource` and re-reads through `useOnLabFilesChanged`.
- `useFsTree`, `useCatalogInstall`, `usePromiseModal`, `useConfirmDiscard`, `useTheme`,
  `useHasFocusWithin`, `useDismissOnOutside`: if you are about to write the second copy of one of
  these behaviours, the first already exists.
- Colours come from `--kt-*` / `--bs-*` tokens in `styles/theme.css`. No hex literals in `.tsx`.

**Factor out at the third copy.** Two similar call sites are tolerable; three is a helper. When
you extract one, push the differences between callers into *data* — an object like `useFsTree`'s
`FsTreeSource` / `FsTreeLabels` — not boolean flags on the shared API, which is how a shared
helper drifts back into several behaviours wearing one name.

**Corollary:** when you fix a bug on one path, check whether a twin path exists. The fs panels and
the two catalogues each run on one hook precisely so a fix lands once.

## Comments

The repo comments densely and that is a feature — roughly one line in six in the shared modules.
Keep it. What follows is about *what* those lines say.

1. **A comment stands on its own.** No pointers to anything outside the repo, and no finding codes
   (`I2`, `E9`, `Q8`, `F1`-`F4`) or working-note headings. When the reason lives elsewhere, point
   at a file or symbol a reader can open: `services/docker_tty.py`, `KatharaService.add_machine`,
   `docs/DESIGN-NOTES.md`.
2. **Explain why, not what.** The code says what it does.
3. **Write in the present.** No `used to`, `before this fix`, `previously`, `had drifted`, `this is
   the X fix itself`, `written before the Y refactor`. No relative dating either — `now`, `new`,
   `recently` are all relative to a moment the reader doesn't know.
4. **History survives only as an invariant.** Turn "X used to do Y and that was a bug" into "X must
   do Z, otherwise Y". Keep the consequence, drop the chronology; `git log` holds the rest. If it
   won't convert into a rule that helps whoever edits this next, it goes.
5. **A shared helper's header** says what it is the single source of truth for, what the documented
   exceptions are, and what callers must not re-derive. It does not narrate what it replaced.
   `useDeployGate` earns its header by saying every container-creating path goes through it and
   that re-deriving the check downstream defeats the gate — not by counting its old copies.
6. **English.** The code is monolingual; keep working notes in whatever language you like, out of
   the source.
7. **A test docstring states the contract it asserts**, not the bug that prompted it.

## Tests

- `tests/unit/` touches neither Docker nor the network. Fake the facade instead.
  `tests/helpers.py` is mandatory reuse: `make_service`, `FakeFacadeBase`, `zip_bytes`, `make_lab`.
  Anything needing a real daemon is `tests/integration/` behind `@pytest.mark.docker`.
- Test names are sentences describing the invariant, not `test_<method_name>`.
- Frontend: vitest runs in `node` and collects only `src/**/*.test.ts` — `.tsx` is not even
  matched. Logic worth testing gets extracted into a pure helper first, the way `labConfRules.ts`
  and `fsTree.ts` were.
- **Drift guards.** Five tests fail on their own when something is added without being covered:
  404 coverage for every per-lab lookup, auth on every `/api` route, the `lab.conf` vocabulary on
  both sides of the stack, `SCALAR_OPTIONS`' order, and the TTY wrappers running off the caller's
  thread. When one of them fails, it is right until you prove otherwise — and a new method or
  route usually needs adding to its table.

## Structure rules already in force

Short list; the reasoning lives in `docs/BACKEND.md` and `kathara-desktop-architecture`.

- Routers are thin: parse, call one `KatharaService` method, serialize. No `try/except`, no Docker
  or Kathara imports.
- Never raise `HTTPException` outside `spa.py`. Raise a typed error; `errors.py` maps it. A new
  `ApiError` subclass carries its own `status_code`.
- `_check_not_transitioning` comes *before* `_mutate_lock`, and the lab lookup happens *inside* it.
  Lab creation uses `_claiming`, not the global lock.
- Route handlers are plain `def` by default. `async def` needs a comment saying why, and every
  blocking call inside one gets offloaded.
- TypeScript: `any` does not appear in this codebase, nor do `@ts-ignore` / `@ts-expect-error`.
  Untrusted input is typed `unknown` and narrowed. Named exports only; props are a local
  `interface XProps` above the component. The one accepted exception is a context provider's
  `{ children }: { children: ReactNode }`.
- Every `ipcMain.handle` argument is untrusted — the type annotation is erased at runtime.

## Checking yourself

The first grep must match nothing outside `node_modules`, bar `npm ci --no-audit`, the `F2` key,
and `integrity` hashes in lockfiles:

```bash
grep -rnE "audit|\b(I[1-6]|E[7-9]|E1[0-5]|Q[0-9]+|F[1-4])\b" \
  --include="*.py" --include="*.ts" --include="*.tsx" . | grep -v node_modules
```

The next two catch rules 3 and 4. Run both over more than the source: `setup.html` carries real
comments, and the build scripts (`*.mjs`, `*.js`), `electron-builder.yml`, the workflows, the
Makefile and `pyproject.toml` are commented as densely as the code:

```bash
grep -rnE "used to |before this fix|had drifted|previously |this is the .* fix" \
  --include="*.py" --include="*.ts" --include="*.tsx" --include="*.html" \
  --include="*.js" --include="*.mjs" --include="*.yml" --include="*.toml" --include=Makefile . \
  | grep -v node_modules
grep -rnE "same as before|matches the old|the old wording|until now|anymore|an earlier design" \
  --include="*.py" --include="*.ts" --include="*.tsx" --include="*.html" \
  --include="*.js" --include="*.mjs" --include="*.yml" --include="*.toml" --include=Makefile . \
  | grep -v node_modules
```

These two are a **reading trigger, not a gate**: the patterns are ordinary English and match a
steady ~17 lines that are all correct. Read each hit and keep it if it is one of these shapes:

- `used to` meaning *serves to* — "the exit code used to signal a directory", "used to draw a
  node's icon". `refused to` matches the same pattern by accident.
- `no longer` / `anymore` as a *runtime condition*: "a directory that no longer exists", "a node
  the user isn't looking at anymore". These describe what is true at that line, not project
  history.
- `now` at an execution point — "the slot must be free now", "the image now being pulled".

Anything else is a comment describing a change rather than a rule, and rule 4 says how to convert
it: keep the consequence, drop the chronology.

On the backend, `ruff check src tests` must pass — CI gates on it. It is configured narrowly in
`pyproject.toml` (`select = ["F", "I"]`): dead imports and names, plus import order. Two things
follow from that:

- **Do not widen the rule set to satisfy a finding.** The rest of ruff's defaults disagree with
  this codebase on purpose — `UP045`/`UP007` would rewrite ~170 `Optional[X]` annotations into
  `X | None`,
  and `B008` flags every FastAPI `Depends(...)`. `pyproject.toml` carries that reasoning; read it
  before touching `[tool.ruff]`.
- **Do not reformat.** `ruff format` is deliberately not run here and would reflow half the
  backend. Match the surrounding file by hand; lines run to ~110 characters.

`ruff check --fix` resolves the import-order half on its own and touches nothing else. There is no
equivalent gate on the frontend beyond `npm run lint`, which is itself narrow by design.

Then verify the change itself per `kathara-desktop-dev-workflow`.
