/**
 * Pure helpers shared by the persistence layer (and by state.js, which
 * aggregates the same per-user usage for the live snapshot).
 */

export const HOUR_MS = 3600 * 1000;
export const SCHEMA_VERSION = 1;

/** SQLite cannot bind NaN/Infinity/undefined; normalise them to NULL. */
export function n(v) {
  if (v === null || v === undefined) return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

export function s(v) {
  if (v === null || v === undefined) return null;
  return String(v);
}

/**
 * Throttle-reason bits that actually cost performance.
 *
 * 0x008 HwSlowdown | 0x020 SwThermalSlowdown | 0x040 HwThermalSlowdown |
 * 0x080 HwPowerBrakeSlowdown.
 *
 * Power cap (0x004) is deliberately NOT included: at full load it is the card
 * behaving as configured, and counting it would make every busy hour look like
 * an incident. Must match the rule in `throttleWarnings` (server/state.js).
 *
 * Written as the OR of the named bits rather than as a decimal literal: the
 * first version of this hard-coded 236 where the bits sum to 232, and 236 has
 * the power-cap bit set -- which put "8 of 8 cards throttled" on a machine that
 * was merely power-capped.
 */
export const THROTTLE_BAD_BITS = 0x008 | 0x020 | 0x040 | 0x080;

/**
 * Group per-process rows into per-user usage for one sample.
 *
 * Two deliberate choices:
 *  - GPUs are counted as DISTINCT gpu indices, so four processes on one card is
 *    one GPU-hour, not four.
 *  - SM percentages of several processes sharing one card are summed but capped
 *    at 100, so a shared card cannot report more than one GPU's worth of
 *    effective compute.
 */
export function aggregateUserUsage(procs) {
  const byUser = new Map();

  for (const p of procs) {
    const username = p.username ? String(p.username) : null;
    if (!username) continue;

    let u = byUser.get(username);
    if (!u) {
      u = { gpus: new Set(), smByGpu: new Map(), smGpus: new Set(), memSum: 0, procCount: 0 };
      byUser.set(username, u);
    }
    if (Number.isInteger(p.gpuIndex)) u.gpus.add(p.gpuIndex);

    const key = Number.isInteger(p.gpuIndex) ? p.gpuIndex : -1;
    if (Number.isFinite(p.smPct)) {
      u.smByGpu.set(key, (u.smByGpu.get(key) ?? 0) + Math.max(0, p.smPct));
      // Track which cards actually REPORTED a utilisation, so the average is
      // divided by those and not by every card the user holds.
      u.smGpus.add(key);
    }

    u.memSum += Number.isFinite(p.usedMemMib) ? Math.max(0, p.usedMemMib) : 0;
    u.procCount += 1;
  }

  const out = [];
  for (const [username, u] of byUser) {
    let smSum = 0;
    for (const v of u.smByGpu.values()) smSum += Math.min(v, 100);
    out.push({
      username,
      gpus: u.gpus.size,
      smSum,
      /**
       * How many cards the sum above is actually an average over.
       *
       * NOT `gpus.size`. A card whose per-process utilisation could not be read
       * contributes 0 to the sum, so dividing by every held card silently drags
       * the average toward zero -- a user with 7 cards reported as 41.7% when
       * four of them were running at 75-80%. `sm_pct_avg` is null when nothing
       * reported, because "we could not measure it" is not 0%.
       */
      smGpus: u.smGpus.size,
      memSum: u.memSum,
      procCount: u.procCount,
    });
  }
  return out;
}
