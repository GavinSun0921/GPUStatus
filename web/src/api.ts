import { useCallback, useEffect, useRef, useState } from 'react';
import { SnapshotSchema } from '../../shared/schema';
import type { Snapshot } from './types';

/**
 * Parse a payload against the contract, reporting a mismatch ONCE per field.
 *
 * The previous code was `JSON.parse(...) as Snapshot` -- a cast, which asserts
 * nothing. A field the server renamed (or emitted in the wrong case) simply read
 * as `undefined` and the UI showed a blank cell with no error anywhere. That
 * happened: the disk figures rendered as "— / —" because the server sent
 * `totalMib` while the type declared `total_mib`.
 *
 * Zod turns that class of bug into a visible, specific complaint. It is
 * deliberately loud in the console but non-fatal: a dashboard showing stale data
 * with a warning beats a dashboard showing nothing.
 */
const reportedIssues = new Set<string>();

function parseSnapshot(raw: unknown): Snapshot | null {
  const result = SnapshotSchema.safeParse(raw);
  if (result.success) return result.data;

  for (const issue of result.error.issues) {
    const where = issue.path.join('.') || '(root)';
    const key = `${where}: ${issue.message}`;
    if (reportedIssues.has(key)) continue;
    reportedIssues.add(key);
    console.error(`[gpustatus] API contract violation at ${where}: ${issue.message}`);
  }
  return null;
}

/**
 * Live snapshot stream.
 *
 * Updates arrive over SSE. The server's clock is used for every age/timestamp
 * calculation (hosts are polled by the server, so its clock is the reference);
 * the offset between the two clocks is measured on each message and applied, so
 * "updated 3s ago" stays correct even if the browser's clock is off.
 *
 * A local 1s ticker re-renders ages between pushes without any extra requests.
 *
 * A background tab used to collect every poll push and then fire them all when
 * the tab came back, so the dashboard looked like a high-speed replay of
 * everything that happened while it was hidden. The intermediate states are
 * not something anyone needs -- the server already records history. Two rules
 * keep the view meaning "now" only:
 *   1. SSE frames are coalesced through requestAnimationFrame, so only the
 *      newest pending snapshot is ever applied. A hidden tab does not run
 *      frames, so a backlog simply keeps overwriting one slot and the first
 *      frame after becoming visible shows the latest state once.
 *   2. Becoming visible again fetches GET /api/snapshot directly, which also
 *      covers a tab whose EventSource was dropped while hidden.
 */
export function useSnapshot() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const offsetRef = useRef(0);
  const pendingRef = useRef<Snapshot | null>(null);
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    const apply = (data: Snapshot) => {
      offsetRef.current = data.server_now - Date.now();
      setSnapshot(data);
      setConnected(true);
      setNow(Date.now() + offsetRef.current);
    };

    const scheduleApply = () => {
      if (frameRef.current != null) return;
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = null;
        const data = pendingRef.current;
        pendingRef.current = null;
        if (data) apply(data);
      });
    };

    const onSnapshot = (event: MessageEvent) => {
      try {
        const data = parseSnapshot(JSON.parse(event.data));
        if (!data) return; // reported by parseSnapshot; keep the last good view
        pendingRef.current = data;
        scheduleApply();
      } catch {
        // A frame that is not even JSON is ignored; the next push corrects it.
      }
    };

    const source = new EventSource('/api/stream');
    source.addEventListener('snapshot', onSnapshot as EventListener);
    source.onopen = () => setConnected(true);
    // EventSource reconnects on its own; reflect the gap in the UI meanwhile.
    source.onerror = () => setConnected(false);

    // Coming back to a hidden tab: jump straight to the present instead of
    // playing back whatever queued up. The SSE stream stays open and will keep
    // coalescing through the same pending slot.
    let cancelled = false;
    const refreshNow = () => {
      if (document.visibilityState !== 'visible') return;
      // Drop anything queued while hidden; the fetch below is strictly newer.
      pendingRef.current = null;
      fetch('/api/snapshot')
        .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
        .then((raw: unknown) => {
          if (cancelled) return;
          const data = parseSnapshot(raw);
          if (data) apply(data);
        })
        .catch(() => {
          // A failed refresh keeps the last good view; the SSE stream will
          // correct it on the next poll.
        });
    };
    document.addEventListener('visibilitychange', refreshNow);
    window.addEventListener('focus', refreshNow);

    return () => {
      cancelled = true;
      if (frameRef.current != null) cancelAnimationFrame(frameRef.current);
      document.removeEventListener('visibilitychange', refreshNow);
      window.removeEventListener('focus', refreshNow);
      source.close();
    };
  }, []);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now() + offsetRef.current), 1000);
    return () => clearInterval(timer);
  }, []);

  return { snapshot, connected, now };
}

/** One-shot JSON fetch with loading/error state, for the report pages. */
export function useJson<T>(url: string | null, options: { refreshMs?: number } = {}) {
  const { refreshMs = 0 } = options;
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  // Bumped only when a fetch starts, so the optional refresh timer can decide
  // whether enough time has actually passed since the last request.
  const fetchedAtRef = useRef(0);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!url) return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    fetchedAtRef.current = Date.now();

    fetch(url, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as T;
      })
      .then((json) => {
        setData(json);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });

    return () => controller.abort();
  }, [url, nonce]);

  /**
   * Optional slow refresh for report pages whose underlying rollup barely moves.
   *
   * The usage tables are hour-granular accounting, not live ops -- polling them
   * with the dashboard would only add load for numbers that change at most once
   * an hour. The interval is a floor: a range change still fetches immediately
   * via the url dependency above.
   */
  useEffect(() => {
    if (!url || !refreshMs || refreshMs < 60_000) return;
    const timer = setInterval(() => {
      if (Date.now() - fetchedAtRef.current < refreshMs) return;
      setNonce((n) => n + 1);
    }, Math.min(refreshMs, 60_000));
    return () => clearInterval(timer);
  }, [url, refreshMs]);

  return { data, loading, error, reload };
}
