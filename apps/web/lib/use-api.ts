'use client';

// A tiny data-loading hook for client components.
//
// `key` identifies the request (for example the URL plus filters). When it changes, the hook
// fetches again; pass null to skip fetching. `reload()` refetches the same key while keeping
// the current data on screen (no skeleton flash), which is what polling and "refresh after a
// live alert" want. A library such as SWR or TanStack Query does this and more; this project
// keeps it small so every line can be explained.

import { useCallback, useEffect, useEffectEvent, useState } from 'react';
import { describeError } from './api';

interface Loaded<T> {
  /** Which key the data belongs to. */
  key: string;
  /** Which key + version finished last; differs from the current one while reloading. */
  token: string;
  data: T | undefined;
  error: string | null;
}

export function useApi<T>(key: string | null, fetcher: () => Promise<T>) {
  const [version, setVersion] = useState(0);
  const [state, setState] = useState<Loaded<T> | null>(null);

  // useEffectEvent: always calls the latest `fetcher` without making it an effect dependency,
  // so an inline arrow function does not cause a fetch on every render.
  const run = useEffectEvent(fetcher);

  useEffect(() => {
    if (key === null) return;
    const token = `${key}#${version}`;
    let cancelled = false;
    run().then(
      (data) => {
        if (!cancelled) setState({ key, token, data, error: null });
      },
      (err: unknown) => {
        // Keep the previous data for this key if a background reload fails.
        if (!cancelled)
          setState((prev) => ({
            key,
            token,
            data: prev?.key === key ? prev.data : undefined,
            error: describeError(err),
          }));
      },
    );
    // If the key changes before the response arrives, ignore the stale response.
    return () => {
      cancelled = true;
    };
  }, [key, version]);

  const current = state && state.key === key ? state : null;
  const reload = useCallback(() => setVersion((v) => v + 1), []);
  /** Replace the data locally, for example after a successful edit. */
  const setData = useCallback(
    (update: (prev: T) => T) =>
      setState((prev) => (prev && prev.data !== undefined ? { ...prev, data: update(prev.data) } : prev)),
    [],
  );

  return {
    data: current?.data,
    error: current?.error ?? null,
    /** True until the first response for this key arrives. */
    loading: key !== null && current === null,
    /** True while a reload of the same key is in flight. */
    refreshing: current !== null && current.token !== `${key}#${version}`,
    reload,
    setData,
  };
}
