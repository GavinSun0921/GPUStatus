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
 * Deliberate choices:
 *  - GPUs are counted as DISTINCT gpu indices, so four processes on one card is
 *    one GPU-hour, not four.
 *  - SM percentages of several processes sharing one card are summed but capped
 *    at 100, so a shared card cannot report more than one GPU's worth of
 *    effective compute.
 *  - When `gpus` is provided and a single user holds a card, that card's
 *    utilisation is the CARD's `util` (utilization.gpu), not the sum of pmon
 *    per-process SM. A parallel task often parks companion processes on the
 *    card that never compute (CUDA context, data loaders); pmon then
 *    under-attributes SM and the sum reads well below the card's real load.
 *    Shared cards still use per-process SM so each user only gets their slice.
 *
 * `gpus` is optional and only needs `{ index, util }` entries; without it the
 * function falls back to process SM alone (the historical behaviour).
 */
export function aggregateUserUsage(procs, gpus) {
  const byUser = new Map();
  /** gpu index -> Set of usernames with processes on that card */
  const usersByGpu = new Map();
  /** gpu index -> card-level utilization.gpu, when the caller passed gpus */
  const cardUtil = new Map();
  if (Array.isArray(gpus)) {
    for (const g of gpus) {
      if (!g || !Number.isInteger(g.index)) continue;
      cardUtil.set(g.index, Number.isFinite(g.util) ? g.util : null);
    }
  }

  for (const p of procs) {
    const username = p.username ? String(p.username) : null;
    if (!username) continue;

    let u = byUser.get(username);
    if (!u) {
      u = { gpus: new Set(), smByGpu: new Map(), smGpus: new Set(), memSum: 0, procCount: 0 };
      byUser.set(username, u);
    }
    if (Number.isInteger(p.gpuIndex)) {
      u.gpus.add(p.gpuIndex);
      let owners = usersByGpu.get(p.gpuIndex);
      if (!owners) {
        owners = new Set();
        usersByGpu.set(p.gpuIndex, owners);
      }
      owners.add(username);
    }

    const key = Number.isInteger(p.gpuIndex) ? p.gpuIndex : -1;
    if (Number.isFinite(p.smPct)) {
      u.smByGpu.set(key, (u.smByGpu.get(key) ?? 0) + Math.max(0, p.smPct));
    }

    u.memSum += Number.isFinite(p.usedMemMib) ? Math.max(0, p.usedMemMib) : 0;
    u.procCount += 1;
  }

  const out = [];
  for (const [username, u] of byUser) {
    let smSum = 0;

    // Cards to score: those with a process SM reading, plus sole-occupant
    // cards whose only reading is the card's own util.
    const keys = new Set(u.smByGpu.keys());
    for (const [idx, util] of cardUtil) {
      if (util !== null && (usersByGpu.get(idx)?.size ?? 0) === 1 && usersByGpu.get(idx).has(username)) {
        keys.add(idx);
      }
    }

    for (const key of keys) {
      const hasProcSm = u.smByGpu.has(key);
      const procSm = hasProcSm ? u.smByGpu.get(key) : 0;
      const util = key >= 0 ? (cardUtil.get(key) ?? null) : null;
      const hasUtil = util !== null;
      const sole = key >= 0 && (usersByGpu.get(key)?.size ?? 0) <= 1;

      let cardSm;
      if (sole && hasUtil && hasProcSm) {
        // Companion processes make pmon under-attribute SM; the card's
        // utilisation.gpu is the figure that says how busy the card actually
        // was. Process SM still wins when it is higher (bursty kernels that
        // the util window missed), so the result is never understated.
        cardSm = Math.min(100, Math.max(util, Math.min(procSm, 100)));
      } else if (sole && hasUtil && util > 0) {
        // Process SM unreadable, but the card itself reported busy. Its
        // utilisation IS this user's. A card reporting 0 is deliberately NOT
        // taken as a measurement of idle here: with no process reading, 0 is
        // indistinguishable from a poll that landed between bursts, and
        // inventing a 0% sample is what once dragged bursty jobs to idle.
        cardSm = Math.min(100, util);
      } else if (hasProcSm) {
        // A measured process 0 is a real reading and counts.
        cardSm = Math.min(procSm, 100);
      } else {
        continue;
      }
      smSum += cardSm;
      u.smGpus.add(key);
    }

    out.push({
      username,
      gpus: u.gpus.size,
      smSum,
      /**
       * How many cards the sum above is actually an average over.
       *
       * NOT `gpus.size`. A card whose utilisation could not be read at all
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
