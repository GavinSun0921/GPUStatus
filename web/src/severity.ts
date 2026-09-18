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

/**
 * Colour for how well a user's ALLOCATED GPUs are being used.
 *
 * The severity ramp is the wrong shape here, and its direction is backwards: it
 * paints 97% red and 25% green, i.e. it treats a busy GPU as the problem. On a
 * shared cluster the problem is the opposite one -- holding cards and not using
 * them keeps somebody else from running.
 *
 * So this ramp runs the other way, and only the wasteful end is coloured at all.
 * High utilisation gets NO colour: "in use" is the normal, desired state, and
 * colouring it would make the table shout on every healthy row.
 *
 * It is a separate helper rather than a reversed threshold inside `severity`,
 * because the two answer different questions. `severity` asks "is this resource
 * about to break?" (disk filling, memory exhausting) and must keep pointing the
 * way it does.
 *
 * The bands are deliberately generous at the top: a memory-bound job can sit at
 * 30-50% SM legitimately, so only clearly-idle allocations are flagged.
 */
export function efficiencyColor(
  value: number | null | undefined,
  colors: Record<Severity, string>,
): string | undefined {
  if (value === null || value === undefined || !Number.isFinite(value)) return undefined;
  if (value < 10) return colors.danger;
  if (value < 30) return colors.warn;
  return undefined;
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
