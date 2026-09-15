import { theme } from 'antd';

/**
 * Severity bands for a 0..100 percentage.
 *
 * Components map these to colours from the ACTIVE antd theme rather than to
 * hard-coded values, so light/dark switching stays correct without any
 * component knowing which theme is on.
 */
export type Severity = 'ok' | 'warn' | 'danger' | 'accent' | 'muted';

export function severity(value: number | null | undefined): Severity {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'muted';
  if (value >= 90) return 'danger';
  if (value >= 70) return 'warn';
  if (value >= 30) return 'accent';
  if (value > 0) return 'ok';
  return 'muted';
}

/**
 * Colour for an ACTIVITY reading (GPU utilisation), as opposed to a capacity one.
 *
 * Deliberately not the severity ramp. A card at 100% is the goal for a compute
 * lab, so painting every busy card red made a healthy, fully-used cluster look
 * like it was on fire -- and red should be reserved for things that need action.
 * It would also over-claim: a single instantaneous sample cannot distinguish
 * "working hard" from "stuck", which is a judgement only the time series can
 * make (see ACTIVE_UTIL_PCT's removal in server/state.js).
 *
 * The bar length already conveys the magnitude; colour stays calm.
 */
export function activityColor(value: number | null | undefined, colors: Record<Severity, string>): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return colors.muted;
  return value >= 5 ? colors.accent : colors.muted;
}

/** Resolve severity bands to the current antd theme's palette. */
export function useSeverityColors(): Record<Severity, string> {
  const { token } = theme.useToken();
  return {
    ok: token.colorSuccess,
    warn: token.colorWarning,
    danger: token.colorError,
    accent: token.colorPrimary,
    muted: token.colorTextTertiary,
  };
}
