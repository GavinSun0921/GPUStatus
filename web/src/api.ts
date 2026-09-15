import { useCallback, useEffect, useRef, useState } from 'react';
import type { Snapshot } from './types';

/**
 * Live snapshot stream.
 *
 * Updates arrive over SSE. The server's clock is used for every age/timestamp
 * calculation (hosts are polled by the server, so its clock is the reference);
 * the offset between the two clocks is measured on each message and applied, so
 * "updated 3s ago" stays correct even if the browser's clock is off.
 *
 * A local 1s ticker re-renders ages between pushes without any extra requests.
 */
export function useSnapshot() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const offsetRef = useRef(0);

  useEffect(() => {
    const source = new EventSource('/api/stream');

    const onSnapshot = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data) as Snapshot;
        offsetRef.current = data.server_now - Date.now();
        setSnapshot(data);
        setConnected(true);
      } catch {
        // A malformed frame is ignored; the next push will correct the view.
      }
    };

    source.addEventListener('snapshot', onSnapshot as EventListener);
    source.onopen = () => setConnected(true);
    // EventSource reconnects on its own; reflect the gap in the UI meanwhile.
    source.onerror = () => setConnected(false);

    return () => source.close();
  }, []);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now() + offsetRef.current), 1000);
    return () => clearInterval(timer);
  }, []);

  return { snapshot, connected, now };
}

/** One-shot JSON fetch with loading/error state, for the report pages. */
export function useJson<T>(url: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!url) return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);

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

  return { data, loading, error, reload };
}
