# Kathara Desktop — design notes

Constraints that span several files, where no single call site owns the reason. Each entry is a
rule about how the code must behave, followed by the files that depend on it. Code comments point
here instead of repeating the rationale at every site.

For the endpoint reference see `BACKEND.md`; for the Electron startup sequence see `DESKTOP.md`.

## Terminal sessions get their own thread pool

`services/docker_tty.py` owns a `ThreadPoolExecutor` separate from the one `asyncio.to_thread`
uses by default, and every TTY session call goes through its `astart` / `aread` / `awrite` /
`aresize` / `aclose` wrappers.

A live session holds one of those threads for as long as the terminal stays open, because `read()`
blocks in a loop waiting for output that may never come. Asyncio's default executor is shared by
every other blocking Docker call in the process, including the container lookup that opens the
*next* terminal — so a handful of open terminals sharing that pool starve the rest of the backend.
The two pools must not be merged.

The pool is sized from `ApiSettings`, which doubles as the concurrent-session cap enforced in
`routers/exec.py`. It is built when the first session opens rather than at import, so the size
comes from the settings singleton at point of use like every other read of it, and rebuilt the
same way after a shutdown, because `create_app()` runs more than once per process in the test
suite and a one-shot executor would leave every app instance after the first unable to schedule
TTY work.

The one-shot container lookup in `routers/exec.py` deliberately stays on the default executor: it
returns promptly and is not a per-session thread.

Shutdown is explicit, from `main.py`'s lifespan hook, rather than left to `ThreadPoolExecutor`'s
`atexit` handler — that one waits for every worker to return, and a blocked TTY read returns only
when its terminal closes.

Applies to: `services/docker_tty.py`, `routers/exec.py`, `main.py`,
`tests/unit/test_docker_tty_executor.py`.

## The gallery route coordinates on the event loop

`GET /labs/gallery` is `async` for a reason no other route in `routers/labs.py` shares: not to
await a request body, the way `POST /{lab_id}/fs/upload` does, but to reach the upstream
catalogue through `lab_gallery.fetch_catalog_async`.

`_async_lock` guards only the `_inflight` pointer, never the fetch itself. A caller that finds a
fetch already in flight awaits that fetch's Future on the event loop, which costs nothing. Holding
a lock across the fetch instead would park a worker thread from the shared pool for up to
`TREE_TIMEOUT` seconds per concurrent request, and a burst of them would exhaust the pool.

The synchronous `fetch_catalog` remains for `install_gallery_lab` / `get_entry` and the tests,
which are not on the event loop.

Applies to: `services/lab_gallery.py`, `routers/labs.py`.

## One vocabulary for `lab.conf`, mirrored once in the frontend

`lab_conf_options.py` is the only place that spells the `machine[key]=value` options this API
models, the order they are written back out in, and the names a `metas` pass-through may not use.
It imports nothing from `schemas` or `services` so every layer can derive from it.

The parser in `services/lab_import.py` *gates* on it rather than merely agreeing with it: an
option cannot be interpreted without also being reserved. Without that gate, an option the parser
understands but the request schema does not reserve is accepted as a pass-through meta and comes
back as the real option on the next load.

`SCALAR_OPTIONS` is a tuple because its order decides the bytes written to a user's `lab.conf`.
Turning it into a set, or reordering it, silently rewrites every generated file.

The frontend keeps one mirror, `services/frontend/src/services/editorLanguage.ts`, feeding the
highlighter, the autocompletion and the linter. It must change in the same commit as the backend
parser; `tests/unit/test_lab_conf_options.py` reads it and fails when the two disagree.

Applies to: `lab_conf_options.py`, `services/lab_import.py`, `services/lab_store.py`,
`services/lab_conf_edit.py`, `services/serializers.py`, `schemas/machine.py`,
`services/frontend/src/services/editorLanguage.ts`.

## The editor's lint severity is one-way

`editor/labConfRules.ts` may report an `error` only where the backend parser appends to its own
`errors` list. Where the backend merely warns, the editor warns too.

A client-side error on a file the backend would accept blocks a legitimate save, so the asymmetry
matters in one direction only: stricter-in-the-editor is a bug, laxer is not.

The rules are a pure function over lines, with no CodeMirror or DOM import, so they can be unit
tested in the DOM-less vitest run; `editor/labConfLint.ts` is only the CodeMirror binding on top.

Applies to: `services/frontend/src/editor/labConfRules.ts`,
`services/frontend/src/editor/labConfLint.ts`, `services/lab_import.py`.
