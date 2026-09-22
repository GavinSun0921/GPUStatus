/**
 * Write path: host registry, raw samples, permanent rollups, events, prune.
 *
 * Storage strategy
 * ----------------
 *  * Raw per-sample tables keep the full detail (every GPU, every PID) for a
 *    configurable window (default 7 days) and are then pruned.
 *  * `usage_rollup` keeps per-(hour, host, user) integrals FOREVER. Raw data is
 *    therefore disposable while year-end accounting survives.
 *
 *    Three independent integrals are accumulated, because "usage" is ambiguous
 *    and each answers a different question:
 *
 *      gpu_seconds      SUM(#GPUs held) * dt   -> GPU-hours OCCUPIED
 *                         Fair-share / allocation metric. Penalises holding a
 *                         card idle, which is usually what a lab wants to see.
 *
 *      sm_gpu_seconds   SUM(SM%) / 100 * dt    -> EFFECTIVE GPU-hours
 *                         Actual compute delivered. A job at 30% SM for an hour
 *                         counts 0.3. Rewards real throughput.
 *
 *      mem_mib_seconds  SUM(used MiB) * dt     -> memory-GiB-hours
 *                         Capacity pressure; the metric that explains "the card
 *                         is empty but I cannot allocate".
 *
 *    Accumulating at write time (rather than re-aggregating raw rows later) is
 *    what makes pruning safe: no accounting information is ever discarded.
 */

import { HOUR_MS, THROTTLE_BAD_BITS, aggregateUserUsage, n, s } from './helpers.js';

export function registerHosts(stmt, hosts, now = Date.now()) {
  for (const h of hosts) {
    // label may be null (meaning "derive it from the hostname"); the column is
    // NOT NULL, so fall back to the id as a placeholder until the first poll.
    stmt.upsertHost.run(
      h.id, s(h.label), h.id, h.ssh, s(h.group), n(h.expectGpus), now, s(h.label),
    );
  }
}

export function markAttempt(stmt, hostId, ts) {
  stmt.markAttempt.run(ts, hostId);
}

export function recordEvent(stmt, ts, hostId, kind, message) {
  stmt.insEvent.run(ts, hostId, kind, s(message));
}

export function recordFailure(stmt, hostId, ts, error) {
  stmt.markAttempt.run(ts, hostId);
  stmt.markError.run(s(String(error).slice(0, 500)), hostId);
}

/**
 * Record, for each user, how many GPUs they held simultaneously this cycle.
 *
 * Called once per cycle with EVERY host's sample, because simultaneity is
 * only knowable when all machines are in hand at once -- that is exactly what
 * a per-host rollup cannot express.
 *
 * A machine that failed to answer contributes nothing this cycle; its users
 * are simply not counted here. That is safe because only the MAXIMUM over
 * time is kept, so a missing cycle can never lower the recorded peak.
 */
export function recordCyclePeaks(db, stmt, collected) {
  if (!collected || collected.length === 0) return;
  const byUser = new Map();

  for (const { hostId, sample } of collected) {
    for (const proc of sample.procs ?? []) {
      const username = proc.username ? String(proc.username) : null;
      if (!username) continue;
      // One card is identified by (machine, card index) -- the same card
      // appearing in two processes must not be counted twice.
      const card = `${hostId}:${proc.gpuIndex}`;
      let cards = byUser.get(username);
      if (!cards) {
        cards = new Set();
        byUser.set(username, cards);
      }
      cards.add(card);
    }
  }

  const bucket = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
  db.exec('BEGIN');
  try {
    for (const [username, cards] of byUser) {
      stmt.upsertPeak.run(bucket, username, cards.size);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Persist one successful poll: raw samples for the detail view plus the
 * permanent per-user rollup for accounting.
 *
 * All writes happen in a single transaction so a crash can never leave the
 * rollup disagreeing with the raw samples.
 */
export function recordSuccess(db, stmt, prevTs, intervalMs, hostId, sample) {
  const { ts, host, gpus, procs, uptimeS, driverVersion, hostname, label } = sample;

  // Credit at most two nominal intervals per sample. A gap (poller restart,
  // host rebooting) must not be back-filled as if the GPUs had been busy the
  // whole time -- under-counting an outage is far safer than inventing usage.
  const prev = prevTs.get(hostId);
  let dtMs = prev === undefined ? 0 : ts - prev;
  if (!Number.isFinite(dtMs) || dtMs < 0) dtMs = 0; // counter went backwards (host reboot)
  if (dtMs > intervalMs * 2) dtMs = intervalMs;
  const dtS = dtMs / 1000;

  db.exec('BEGIN');
  try {
    stmt.insHostSample.run(
      ts, hostId,
      n(host.cpuPct), n(host.iowaitPct), n(host.ncpu), n(host.load1), n(host.load5), n(host.load15),
      n(host.runningProcs), n(host.memTotalMib), n(host.memUsedMib), n(host.memAvailMib),
      n(host.memPct), n(host.swapTotalMib), n(host.swapUsedMib),
      n(uptimeS), n(gpus.length), s(driverVersion),
    );

    for (const g of gpus) {
      stmt.insGpuSample.run(
        ts, hostId, n(g.index), s(g.uuid), s(g.name), n(g.util),
        n(g.memUsedMib), n(g.memTotalMib), n(g.memUtil), n(g.tempC), n(g.powerW),
        n(g.fanPct), n(g.nProcs),
        n(g.throttleMask), n(g.smClockMhz), n(g.smClockMaxMhz), n(g.powerLimitW),
        s(g.pstate), s(g.busId),
      );
    }

    for (const p of procs) {
      stmt.insProcSample.run(
        ts, hostId, n(p.gpuIndex), s(p.gpuUuid), n(p.pid), s(p.username),
        s(p.name), n(p.usedMemMib), n(p.smPct),
      );
    }

    // Machine-level hourly rollup. Records even when nothing is running, so an
    // idle hour shows as 0% rather than as a gap in the chart -- usage_rollup
    // only has rows for hours somebody used a GPU.
    {
      const util = gpus.map((g) => g.util).filter((v) => typeof v === 'number');
      const mem = gpus
        .filter((g) => typeof g.memUsedMib === 'number' && typeof g.memTotalMib === 'number' && g.memTotalMib > 0)
        .map((g) => (g.memUsedMib / g.memTotalMib) * 100);
      const temps = gpus.map((g) => g.tempC).filter((v) => typeof v === 'number');
      const power = gpus.map((g) => g.powerW).filter((v) => typeof v === 'number');
      // Averaging helpers: a metric the card does not report must contribute
      // neither to the sum nor to the count, so the running average stays
      // exact instead of being dragged toward zero.
      const avg = (values) =>
        values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
      const bandwidth = gpus
        .map((g) => g.memUtil)
        .filter((v) => typeof v === 'number');

      /**
       * A single observation, as the (sum, count) pair the table accumulates.
       *
       * An absent reading contributes 0 to the sum AND 0 to the count --
       * never a null sum (the column is NOT NULL) and never a count of 1
       * (which would record a sample that did not happen).
       */
      const obs = (value) =>
        typeof value === 'number' && Number.isFinite(value)
          ? { sum: value, n: 1 }
          : { sum: 0, n: 0 };
      // Uses the module-level THROTTLE_BAD_BITS, so the live writer and the
      // backfill cannot disagree about what counts as throttled.
      const throttledCards = gpus.filter(
        (g) => typeof g.throttleMask === 'number' && (g.throttleMask & THROTTLE_BAD_BITS) !== 0,
      ).length;

      if (util.length > 0) {
        const utilObs = obs(avg(util));
        const memObs = obs(avg(mem));
        const powerObs = obs(power.length ? power.reduce((a, b) => a + b, 0) : null);
        const cpuObs = obs(host.cpuPct);
        const sysmemObs = obs(host.memPct);
        const bwObs = obs(avg(bandwidth));
        // Throttling is a count, not an average: 0 throttled cards is a real
        // observation and must count as one sample.
        const throttleObs = { sum: throttledCards, n: 1 };

        stmt.upsertHostHourly.run(
          Math.floor(ts / HOUR_MS) * HOUR_MS, hostId,
          utilObs.sum, utilObs.n,
          memObs.sum, memObs.n,
          temps.length ? Math.max(...temps) : null,
          powerObs.sum, powerObs.n,
          gpus.length,
          cpuObs.sum, cpuObs.n,
          sysmemObs.sum, sysmemObs.n,
          bwObs.sum, bwObs.n,
          throttleObs.sum, throttleObs.n,
        );
      }
    }

    if (dtS > 0) {
      const bucketTs = Math.floor(ts / HOUR_MS) * HOUR_MS;
      for (const u of aggregateUserUsage(procs)) {
        stmt.upsertRollup.run(
          bucketTs, hostId, u.username,
          u.gpus * dtS,
          (u.smSum / 100) * dtS,
          u.memSum * dtS,
          u.gpus,
          u.memSum,
        );
      }
    }

    // Homogeneous hosts: the first card's raw name is the price key for all of them.
    stmt.markOk.run(ts, s(hostname), s(driverVersion), s(label), s(gpus[0]?.name), hostId);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  prevTs.set(hostId, ts);
}

/** Drop raw samples past the retention window. Rollups are never pruned. */
export function pruneRaw(db, stmt, retentionHours, now = Date.now()) {
  if (!retentionHours || retentionHours <= 0) return 0;
  const cutoff = now - retentionHours * HOUR_MS;
  let removed = 0;
  db.exec('BEGIN');
  try {
    removed += stmt.pruneHost.run(cutoff).changes;
    removed += stmt.pruneGpu.run(cutoff).changes;
    removed += stmt.pruneProc.run(cutoff).changes;
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return removed;
}
