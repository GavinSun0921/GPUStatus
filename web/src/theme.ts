import { useCallback, useEffect, useState } from 'react';

/**
 * Theme handling: `auto` follows the operating system, `light` / `dark` pin it.
 *
 * The resolved theme is written to `<html data-theme>` as a plain attribute, so
 * all colours live in CSS variables and no component needs to know the theme.
 *
 * `index.html` applies the same attribute in an inline script before the first
 * paint, which is what prevents a flash of the wrong theme; this module only
 * takes over afterwards. Keep the storage key in sync with that script.
 */

export type ThemeMode = 'auto' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'gpustatus:theme';

const DARK_QUERY = '(prefers-color-scheme: dark)';

function readStoredMode(): ThemeMode {
  try {
    const value = globalThis.localStorage?.getItem(THEME_STORAGE_KEY);
    if (value === 'light' || value === 'dark' || value === 'auto') return value;
  } catch {
    // Private browsing or storage disabled -- fall through to the default.
  }
  return 'auto';
}

function systemTheme(): ResolvedTheme {
  return globalThis.matchMedia?.(DARK_QUERY).matches ? 'dark' : 'light';
}

export function useTheme() {
  const [mode, setMode] = useState<ThemeMode>(readStoredMode);
  const [system, setSystem] = useState<ResolvedTheme>(systemTheme);

  // Track the OS preference live, so "auto" reacts to the system switching at
  // sunset without the user touching anything or reloading.
  useEffect(() => {
    const query = globalThis.matchMedia?.(DARK_QUERY);
    if (!query) return;
    const onChange = (event: MediaQueryListEvent) => setSystem(event.matches ? 'dark' : 'light');
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  const resolved: ResolvedTheme = mode === 'auto' ? system : mode;

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = resolved;
    // Lets the browser theme scrollbars and form controls to match.
    root.style.colorScheme = resolved;
  }, [resolved]);

  const change = useCallback((next: ThemeMode) => {
    setMode(next);
    try {
      globalThis.localStorage?.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Persisting is a nicety; the theme still applies for this session.
    }
  }, []);

  return { mode, resolved, setMode: change };
}
