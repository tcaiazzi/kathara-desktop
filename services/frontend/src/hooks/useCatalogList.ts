import { useCallback, useEffect, useRef, useState } from "react";
import { isAbortError } from "../services/api";

interface CatalogListOptions<T> {
  /** Fetches the list. `refresh` asks the backend to bypass its own cache — a surface with no
   * Refresh control never passes it. */
  fetch: (refresh: boolean, signal: AbortSignal) => Promise<T[]>;
  /** What to show when the fetch fails, or `null` for "no error surface": the section simply stays
   * empty. The two catalogues differ here — the gallery is what its modal is *for*, so a failure
   * needs saying; the welcome screen's examples are a bonus row on a screen whose whole point is to
   * be welcoming, and a backend without that route is not worth an alarm. */
  errorMessage: (e: unknown) => string | null;
  /** Hold off until true — the gallery only loads while its modal is open. Default: load on mount. */
  enabled?: boolean;
}

/** The load half of the two lab catalogues, the way `useCatalogInstall` is the install half.
 *
 * The staleness guard is a request id rather than a per-call `cancelled` flag, because `reload` is
 * also called from outside the effect (the gallery's Refresh and Retry buttons): one shared counter
 * is what lets the effect's cleanup invalidate a fetch a *button* started, not only its own. The
 * in-flight request is aborted as well, so a superseded one stops rather than merely being ignored.
 */
export function useCatalogList<T>({ fetch, errorMessage, enabled = true }: CatalogListOptions<T>) {
  const [items, setItems] = useState<T[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  // Read through a ref so `reload` stays stable: the gallery passes it to buttons, and the effect
  // below must not re-run because a caller rebuilt its `fetch` closure on render.
  const fetchRef = useRef(fetch);
  fetchRef.current = fetch;
  const errorMessageRef = useRef(errorMessage);
  errorMessageRef.current = errorMessage;

  const reload = useCallback(async (refresh = false) => {
    const id = ++loadIdRef.current;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    (refresh ? setRefreshing : setLoading)(true);
    setError(null);
    try {
      const next = await fetchRef.current(refresh, controller.signal);
      if (loadIdRef.current === id) setItems(next);
    } catch (e) {
      if (loadIdRef.current !== id || isAbortError(e)) return;
      const message = errorMessageRef.current(e);
      if (message === null) setItems([]);
      else setError(message);
    } finally {
      if (loadIdRef.current === id) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void reload();
    // Bumping the id invalidates whatever load is still in flight — this effect's or a button's.
    return () => {
      // These are request bookkeeping, not refs to a React-rendered node: reading them *late*,
      // at cleanup, is exactly the point — the value that matters is whichever request is in
      // flight by then, not the one that existed when the effect ran.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      loadIdRef.current++;
      abortRef.current?.abort();
    };
  }, [enabled, reload]);

  return { items, loading, refreshing, error, reload };
}
