// The CPython version the app bundles, in one place because two scripts must agree on it exactly:
// fetch-python.mjs downloads that interpreter, and vendor-python-deps.mjs derives the wheel ABI tag
// (cp312) it vendors dependencies for. A mismatch would produce an app whose every C extension
// fails to import.
//
// Its own module rather than an export from fetch-python.mjs: that file is a script with top-level
// work, so importing it would need a "was I run directly" guard — and a guard that silently
// mis-fires on one platform turns `fetch-python.mjs win` into a no-op that still exits 0, shipping
// an installer with no interpreter in it.
export const PYTHON_VERSION = "3.12.14";
