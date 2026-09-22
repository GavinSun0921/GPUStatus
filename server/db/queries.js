/**
 * Read-side queries. Each takes the better-sqlite3 handle; the Db class
 * forwards so callers keep a single entry point.
 */

import { HOUR_MS } from './helpers.js';

/**
 * Last sample timestamp per host, so a restart does not lose the baseline and
 * credit a huge dt to the first sample after boot.
 */
export function loadPrevTimestamps(db) {
  const map = new Map();
  for (const row of db.prepare('SELECT host_id, MAX(ts) AS ts FROM host_sample GROUP BY host_id').all()) {
    map.set(row.host_id, Number(row.ts));
  }
  return map;
}

/**
 * Permanent host -> nvidia-smi model map for pricing.
 *
 * Read from `hosts`, not `gpu_sample`, because raw samples are pruned and
 * year-end cost still has to know what cards a machine has.
 */
export function loadHostGpuNames(db) {
  const map = new Map();
  for (const row of db.prepare('SELECT id, gpu_name FROM hosts').all()) {
    if (row.gpu_name) map.set(row.id, row.gpu_name);
  }
  return map;
}

/**
 * Occupancy cost for a stretch of GPU-seconds on one host.
 *
 * `priceOfName` returns yuan per card-hour for a raw nvidia-smi name, or null
 * when the model has no configured rate. An unpriced model is never charged at
 * 0 -- its hours are reported as `unpriced_gpu_hours` so the gap is visible.
 */
export function occupancyCost(gpuSeconds, smGpuSeconds, rawName, priceOfName) {
  // Measurement invariant: a missing integral is NOT zero occupancy. Only a
  // real 0 means "held no card-time"; null means we do not know, so cost stays
  // null rather than silently charging 0 yuan.
  if (gpuSeconds == null) {
    return {
      cost_yuan: null,
      effective_cost_yuan: null,
      unpriced_gpu_hours: 0,
      gpu_model: rawName ?? null,
      gpu_price: rawName ? priceOfName(rawName) : null,
    };
  }
  const gpuHours = gpuSeconds / 3600;
  const effectiveHours = smGpuSeconds == null ? null : smGpuSeconds / 3600;
  const price = rawName ? priceOfName(rawName) : null;
  if (price == null) {
    return {
      cost_yuan: null,
      effective_cost_yuan: null,
      unpriced_gpu_hours: gpuHours,
      gpu_model: rawName ?? null,
      gpu_price: null,
    };
  }
  // Full precision here; callers that sum across hosts must not inherit a
  // premature 2-decimal rounding before the final total.
  return {
    cost_yuan: gpuHours * price,
    effective_cost_yuan: effectiveHours == null ? null : effectiveHours * price,
    unpriced_gpu_hours: 0,
    gpu_model: rawName,
    gpu_price: price,
  };
}

/**
 * Aggregated usage for a time range, grouped by user (optionally by host).
 *
 * `bucketSeconds` re-buckets the hourly rollups (86400 = daily, 604800 =
 * weekly) so a year-end report is a single indexed scan.
 */
export function queryUsage(db, { fromTs, toTs, hostId = null, username = null, bucketSeconds = 0 }) {
  const where = ['bucket_ts >= ?', 'bucket_ts < ?'];
  const params = [fromTs, toTs];
  if (hostId) {
    where.push('host_id = ?');
    params.push(hostId);
  }
  if (username) {
    where.push('username = ?');
    params.push(username);
  }

  const groupBucket = bucketSeconds > 0
    ? `CAST(bucket_ts / ${Number(bucketSeconds) * 1000} AS INTEGER) * ${Number(bucketSeconds) * 1000} AS bucket`
    : 'bucket_ts AS bucket';

  return db
    .prepare(`
        SELECT ${groupBucket},
               username,
               ${hostId ? 'NULL' : 'host_id'} AS host_id,
               SUM(gpu_seconds)     AS gpu_seconds,
               SUM(sm_gpu_seconds)  AS sm_gpu_seconds,
               SUM(mem_mib_seconds) AS mem_mib_seconds,
               MAX(peak_gpus)       AS peak_gpus,
               MAX(peak_mem_mib)    AS peak_mem_mib,
               SUM(samples)         AS samples
        FROM usage_rollup
        WHERE ${where.join(' AND ')}
        GROUP BY bucket, username${hostId ? '' : ', host_id'}
        ORDER BY bucket ASC`)
    .all(...params);
}

/** Per (user, host) occupied/effective seconds -- the input to priced cost. */
export function queryUsageByUserHost(db, { fromTs, toTs, hostId = null }) {
  const where = ['bucket_ts >= ?', 'bucket_ts < ?'];
  const params = [fromTs, toTs];
  if (hostId) {
    where.push('host_id = ?');
    params.push(hostId);
  }
  return db
    .prepare(
      `SELECT username, host_id,
              SUM(gpu_seconds)     AS gpu_seconds,
              SUM(sm_gpu_seconds)  AS sm_gpu_seconds
         FROM usage_rollup
        WHERE ${where.join(' AND ')}
        GROUP BY username, host_id`,
    )
    .all(...params);
}

/** Totals per user over a range -- the classic year-end table. */
export function queryUsageTotals(db, { fromTs, toTs, hostId = null }) {
  const where = ['bucket_ts >= ?', 'bucket_ts < ?'];
  const params = [fromTs, toTs];
  if (hostId) {
    where.push('host_id = ?');
    params.push(hostId);
  }
  const peakParams = [fromTs, toTs];
  return db
    .prepare(`
        SELECT r.username,
               SUM(r.gpu_seconds)     AS gpu_seconds,
               SUM(r.sm_gpu_seconds)  AS sm_gpu_seconds,
               SUM(r.mem_mib_seconds) AS mem_mib_seconds,
               -- Peak read from usage_peak, NOT MAX(usage_rollup.peak_gpus).
               -- The rollup is per (hour, host, user), so its maximum answers
               -- "the most on any ONE machine" and silently halves the figure
               -- for anyone spreading work across machines.
               (SELECT MAX(p.peak_gpus) FROM usage_peak p
                 WHERE p.username = r.username
                   AND p.bucket_ts >= ? AND p.bucket_ts < ?) AS peak_gpus,
               MIN(r.bucket_ts)       AS first_seen,
               MAX(r.bucket_ts)       AS last_seen
        FROM usage_rollup r
        WHERE ${where.map((w) => w.replace('bucket_ts', 'r.bucket_ts').replace('host_id', 'r.host_id')).join(' AND ')}
        GROUP BY r.username
        ORDER BY gpu_seconds DESC`)
    .all(...peakParams, ...params);
}

/**
 * Hourly history for one machine, from the never-pruned rollup.
 *
 * Every range the UI offers (24h / 3d / 7d / 30d) is served from the same
 * table, so the chart does not change character at the raw-retention
 * boundary, and an idle hour is a 0 rather than a hole.
 */
export function queryHostHourly(db, hostId, fromTs, toTs) {
  return db
    .prepare(`
        SELECT bucket_ts AS bucket,
               CASE WHEN util_n     > 0 THEN util_sum     / util_n     END AS gpu_util,
               CASE WHEN mem_n      > 0 THEN mem_sum      / mem_n      END AS gpu_mem_pct,
               temp_max_c AS temp_c,
               CASE WHEN power_n    > 0 THEN power_sum    / power_n    END AS power_w,
               CASE WHEN cpu_n      > 0 THEN cpu_sum      / cpu_n      END AS cpu_pct,
               CASE WHEN sysmem_n   > 0 THEN sysmem_sum   / sysmem_n   END AS sysmem_pct,
               CASE WHEN memutil_n  > 0 THEN memutil_sum  / memutil_n  END AS gpu_bw_pct,
               -- Fraction of CARD-TIME spent throttled, not "average cards
               -- throttled": that reads as "0.137 张", and a third of a card is
               -- not a thing anyone can picture. Over the hour there are
               -- throttle_n samples of n_gpus cards each, so the share is
               -- throttled card-instants over total card-instants. Same data,
               -- expressed in a unit that means something.
               CASE WHEN throttle_n > 0 AND n_gpus > 0
                    THEN throttle_sum * 100.0 / (throttle_n * n_gpus) END AS throttle_pct,
               n_gpus
        FROM host_hourly
        WHERE host_id = ? AND bucket_ts >= ? AND bucket_ts < ?
        ORDER BY bucket_ts ASC`)
    .all(hostId, fromTs, toTs);
}

export function queryEvents(db, { limit = 100, hostId = null } = {}) {
  if (hostId) {
    return db
      .prepare('SELECT * FROM events WHERE host_id = ? ORDER BY ts DESC LIMIT ?')
      .all(hostId, limit);
  }
  return db.prepare('SELECT * FROM events ORDER BY ts DESC LIMIT ?').all(limit);
}

/** Distinct users seen recently, for filter dropdowns. */
export function queryRecentUsers(db, sinceTs) {
  return db
    .prepare('SELECT DISTINCT username FROM proc_sample WHERE ts >= ? ORDER BY username')
    .all(sinceTs)
    .map((r) => r.username);
}

export function getMeta(db, key) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : null;
}

export function setMeta(db, key, value) {
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, String(value));
}
