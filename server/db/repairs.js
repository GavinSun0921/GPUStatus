/**
 * One-shot data repairs and backfills.
 *
 * Each of these fills or corrects rows that a past bug or a later feature left
 * wrong or empty. They are idempotent: running them again on a healthy file is
 * either a no-op or guarded by a meta flag, so the constructor can call them
 * unconditionally on every boot.
 */

import { HOUR_MS, THROTTLE_BAD_BITS, aggregateUserUsage } from './helpers.js';

/**
 * Fill `hosts.gpu_name` from the newest raw GPU sample still on disk.
 *
 * Cost accounting keys off the model name, and `gpu_sample` is pruned with the
 * raw retention window -- so the model has to live on the permanent hosts row.
 * Runs whenever a host has no name yet (first upgrade, or a machine that has
 * not been polled since the column appeared).
 */
export function backfillHostGpuNames(db) {
  return db
    .prepare(
      `UPDATE hosts
          SET gpu_name = (
            SELECT g.gpu_name FROM gpu_sample g
             WHERE g.host_id = hosts.id AND g.gpu_name IS NOT NULL
             ORDER BY g.ts DESC LIMIT 1
          )
        WHERE gpu_name IS NULL`,
    )
    .run().changes;
}

/**
 * Populate `host_hourly` from the raw samples that are still on disk.
 *
 * Without this, shipping the chart would show an empty graph for everyone
 * until a fresh hour had been collected, even though the raw data for the last
 * `raw_retention_hours` is right there. Runs once: it checks whether the table
 * is empty rather than tracking a flag, so it is also self-healing if the
 * table is ever dropped.
 *
 * Averaged per hour and per host, matching what the live writer produces.
 *
 * @returns {number} rows now in host_hourly (0 when nothing to backfill)
 */
export function backfillHostHourly(db) {
  const { c } = db.prepare('SELECT COUNT(*) AS c FROM host_hourly').get();
  if (c > 0) {
    // The table already exists, but it may predate the second wave of
    // metrics. Fill only those, so switching metric on old data is not blank.
    backfillHourlyExtras(db);
    return 0;
  }

  const available = db
    .prepare('SELECT COUNT(*) AS c FROM gpu_sample WHERE util_pct IS NOT NULL')
    .get().c;
  if (available === 0) return 0;

  // Temp tables in memory. The GROUP BY over every raw sample needs a sort,
  // and SQLite's default is a temp FILE whose location comes from the
  // environment -- on a machine where that directory is not writable the whole
  // statement fails with a bare "unable to open database file". It is also
  // simply faster here; the data is small enough to sort in RAM.
  db.exec('PRAGMA temp_store = MEMORY');

  // `COUNT(*) / COUNT(DISTINCT ts)` = average GPU rows per poll in the hour,
  // i.e. the card count. Cheaper and clearer than a correlated subquery per
  // row, which is what the first version used.
  db.exec(`
      INSERT INTO host_hourly (bucket_ts, host_id, util_sum, util_n, mem_sum, mem_n,
        temp_max_c, power_sum, power_n, n_gpus)
      SELECT CAST(ts / ${HOUR_MS} AS INTEGER) * ${HOUR_MS} AS bucket_ts,
             host_id,
             SUM(util_pct),
             COUNT(util_pct),
             SUM(CASE WHEN mem_total_mib > 0 THEN mem_used_mib / mem_total_mib * 100 END),
             COUNT(CASE WHEN mem_total_mib > 0 THEN 1 END),
             MAX(temp_c),
             SUM(COALESCE(power_w, 0)),
             COUNT(power_w),
             CAST(COUNT(*) AS INTEGER) / COUNT(DISTINCT ts)
      FROM gpu_sample
      WHERE util_pct IS NOT NULL
      GROUP BY bucket_ts, host_id
    `);

  return db.prepare('SELECT COUNT(*) AS c FROM host_hourly').get().c;
}

/**
 * Fill the second-wave hourly metrics on rows that predate them.
 *
 * `cpu` and `sysmem` come from host_sample, `memutil` and `throttle` from
 * `gpu_sample` -- the same two sources the live writer reads. Guarded on
 * cpu_n = 0 rather than a schema version, so it is idempotent and re-runs if
 * the columns are ever cleared.
 */
export function backfillHourlyExtras(db) {
  const { c } = db
    .prepare('SELECT COUNT(*) AS c FROM host_hourly WHERE cpu_n = 0')
    .get();
  if (c === 0) return;

  db.exec('PRAGMA temp_store = MEMORY');

  // Host metrics: one row per host per tick.
  db.exec(`
      UPDATE host_hourly
         SET cpu_sum    = COALESCE((SELECT SUM(h.cpu_pct) FROM host_sample h
                                     WHERE h.host_id = host_hourly.host_id
                                       AND CAST(h.ts / ${HOUR_MS} AS INTEGER) * ${HOUR_MS} = host_hourly.bucket_ts
                                       AND h.cpu_pct IS NOT NULL), 0),
             cpu_n      = COALESCE((SELECT COUNT(h.cpu_pct) FROM host_sample h
                                     WHERE h.host_id = host_hourly.host_id
                                       AND CAST(h.ts / ${HOUR_MS} AS INTEGER) * ${HOUR_MS} = host_hourly.bucket_ts
                                       AND h.cpu_pct IS NOT NULL), 0),
             sysmem_sum = COALESCE((SELECT SUM(h.mem_pct) FROM host_sample h
                                     WHERE h.host_id = host_hourly.host_id
                                       AND CAST(h.ts / ${HOUR_MS} AS INTEGER) * ${HOUR_MS} = host_hourly.bucket_ts
                                       AND h.mem_pct IS NOT NULL), 0),
             sysmem_n   = COALESCE((SELECT COUNT(h.mem_pct) FROM host_sample h
                                     WHERE h.host_id = host_hourly.host_id
                                       AND CAST(h.ts / ${HOUR_MS} AS INTEGER) * ${HOUR_MS} = host_hourly.bucket_ts
                                       AND h.mem_pct IS NOT NULL), 0)
       WHERE cpu_n = 0
    `);

  // GPU metrics: several rows per host per tick, so aggregate directly.
  db.exec(`
      UPDATE host_hourly
         SET memutil_sum = COALESCE((SELECT SUM(g.mem_util_pct) FROM gpu_sample g
                                      WHERE g.host_id = host_hourly.host_id
                                        AND CAST(g.ts / ${HOUR_MS} AS INTEGER) * ${HOUR_MS} = host_hourly.bucket_ts
                                        AND g.mem_util_pct IS NOT NULL), 0),
             memutil_n   = COALESCE((SELECT COUNT(g.mem_util_pct) FROM gpu_sample g
                                      WHERE g.host_id = host_hourly.host_id
                                        AND CAST(g.ts / ${HOUR_MS} AS INTEGER) * ${HOUR_MS} = host_hourly.bucket_ts
                                        AND g.mem_util_pct IS NOT NULL), 0),
             throttle_sum = COALESCE((SELECT COUNT(*) FROM gpu_sample g
                                       WHERE g.host_id = host_hourly.host_id
                                         AND CAST(g.ts / ${HOUR_MS} AS INTEGER) * ${HOUR_MS} = host_hourly.bucket_ts
                                         AND g.throttle_mask IS NOT NULL
                                         AND (g.throttle_mask & ${THROTTLE_BAD_BITS}) <> 0), 0),
             throttle_n  = COALESCE((SELECT COUNT(DISTINCT g.ts) FROM gpu_sample g
                                      WHERE g.host_id = host_hourly.host_id
                                        AND CAST(g.ts / ${HOUR_MS} AS INTEGER) * ${HOUR_MS} = host_hourly.bucket_ts
                                        AND g.throttle_mask IS NOT NULL), 0)
       WHERE throttle_n = 0
    `);
}

/**
 * Undo the damage from a username-truncating `ps` invocation.
 *
 * `ps -o pid=,user=,etime=` applies its default 8-character USER width (a
 * single `-o user=` column happens to auto-size, which is why this only
 * appeared once `etime` was added). `luzhicheng` was collected as `luzhich+`,
 * and that short name went into `usage_rollup` -- so one person's GPU-hours
 * were split across two rows under two different names. In an accounting
 * table that is a wrong answer, not a cosmetic bug.
 *
 * A truncated name is repaired only when EXACTLY ONE longer username starts
 * with the same stem. Two people sharing a 7-character prefix cannot be told
 * apart from the data alone, so those are left alone and reported instead of
 * being guessed at.
 *
 * @returns {{ merged: Array<[string, string]>, ambiguous: Array<[string, string[]]> }}
 */
export function repairTruncatedUsernames(db) {
  const names = db
    .prepare(
      `SELECT DISTINCT username FROM (
           SELECT username FROM proc_sample
           UNION SELECT username FROM usage_rollup
         ) WHERE username IS NOT NULL`,
    )
    .all()
    .map((r) => r.username);

  const suspects = names.filter((u) => /\+$/.test(u));
  if (suspects.length === 0) return { merged: [], ambiguous: [] };

  const merged = [];
  const ambiguous = [];
  for (const bad of suspects) {
    const stem = bad.replace(/\++$/, '');
    if (stem.length === 0) continue;
    const candidates = names.filter(
      (u) => u !== bad && !/\+$/.test(u) && u.startsWith(stem) && u.length > stem.length,
    );
    if (candidates.length === 1) merged.push([bad, candidates[0]]);
    else if (candidates.length > 1) ambiguous.push([bad, candidates]);
  }

  db.exec('BEGIN');
  try {
    for (const [bad, full] of merged) {
      db.prepare('UPDATE proc_sample SET username = ? WHERE username = ?').run(full, bad);
      // Merge the rollup rows rather than renaming: the full name usually
      // already has a row for the same (hour, host), and simply renaming would
      // violate the primary key or silently drop one side's GPU-hours.
      db.prepare(
        `INSERT INTO usage_rollup (bucket_ts, host_id, username, gpu_seconds,
               sm_gpu_seconds, mem_mib_seconds, peak_gpus, peak_mem_mib, samples)
             SELECT bucket_ts, host_id, ?, gpu_seconds, sm_gpu_seconds, mem_mib_seconds,
                    peak_gpus, peak_mem_mib, samples
               FROM usage_rollup WHERE username = ?
             ON CONFLICT(bucket_ts, host_id, username) DO UPDATE SET
               gpu_seconds     = gpu_seconds + excluded.gpu_seconds,
               sm_gpu_seconds  = sm_gpu_seconds + excluded.sm_gpu_seconds,
               mem_mib_seconds = mem_mib_seconds + excluded.mem_mib_seconds,
               peak_gpus       = MAX(peak_gpus, excluded.peak_gpus),
               peak_mem_mib    = MAX(peak_mem_mib, excluded.peak_mem_mib),
               samples         = samples + excluded.samples`,
      ).run(full, bad);
      db.prepare('DELETE FROM usage_rollup WHERE username = ?').run(bad);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return { merged, ambiguous };
}

/**
 * Rebuild `usage_peak` for the retained window from proc_sample.
 *
 * Runs when the table is empty, which is the case on upgrade: the per-sample
 * rows already hold everything needed, so the history is recoverable rather
 * than starting from the upgrade moment.
 */
export function backfillUsagePeak(db) {
  const { c } = db.prepare('SELECT COUNT(*) AS c FROM usage_peak').get();
  if (c > 0) return;

  db.exec('PRAGMA temp_store = MEMORY');
  db.exec(`
      INSERT INTO usage_peak (bucket_ts, username, peak_gpus)
      SELECT CAST(ts / ${HOUR_MS} AS INTEGER) * ${HOUR_MS} AS bucket,
             username,
             MAX(n)
        FROM (
          SELECT ts, username, COUNT(*) AS n
            FROM (SELECT DISTINCT ts, host_id, gpu_index, username
                    FROM proc_sample WHERE username IS NOT NULL)
           GROUP BY ts, username
        )
       GROUP BY bucket, username
      ON CONFLICT(bucket_ts, username) DO UPDATE SET
        peak_gpus = MAX(peak_gpus, excluded.peak_gpus)
    `);
}

/**
 * Rebuild `sm_gpu_seconds` for hours where the process-level reading was lost.
 *
 * nvidia-smi pmon lists its columns differently by driver: 535 emits 8
 * ("gpu pid type sm mem enc dec command"), 580 emits 10 (adding jpg and ofa).
 * The probe required at least 9 fields, so EVERY line from the 535 machines
 * was discarded and their per-process utilisation stored as null. That null
 * became a 0 in the rollup, so `sm_gpu_seconds` -- the "effective GPU hours"
 * used for accounting -- read as ~0 for two users across 54 hours:
 *
 *     gpu06  wangsiyuan  130.2 card-hours -> 1.78 effective
 *     gpu09  maoyuxin     53.6 card-hours -> 0
 *
 * The per-process figure cannot be recovered, but it does not have to be: the
 * CARD-level utilisation comes from a different nvidia-smi query and was never
 * affected. On both machines exactly one user held each card during those
 * hours (verified: zero samples with two users on one card), so the card's
 * utilisation IS that user's utilisation.
 *
 * What is written is therefore a measurement at card granularity, not a guess.
 * That is why this is preferred over deleting the rows, which would also
 * discard the correct `gpu_seconds` and `mem_mib_seconds` alongside it.
 *
 * @returns {number} rollup rows rewritten (0 when nothing needed repair)
 */
export function repairLostProcessSm(db, getMeta, setMeta) {
  if (getMeta('repair_pmon_sm_v1')) return 0;

  // Lost HOURS, not lost machines. The parser was fixed while the cluster was
  // running, so a machine can have correct readings for its most recent hours
  // and nothing but nulls before that -- keying on the machine would skip
  // exactly the rows that need repairing.
  //
  // An hour counts as lost when it has process rows (so somebody was on the
  // machine) and NOT ONE of them carries a utilisation. That is the signature
  // of the parser dropping every line, and it cannot be produced by a genuine
  // reading: a real idle process reports 0, which is not null.
  // Set BEFORE the detection query: it groups 250k+ rows, and SQLite spills to
  // a temp file it cannot always create here ("unable to open database file").
  db.exec('PRAGMA temp_store = MEMORY');

  const lostHours = db
    .prepare(
      `SELECT host_id, CAST(ts / ${HOUR_MS} AS INTEGER) * ${HOUR_MS} AS bucket
           FROM proc_sample
          WHERE username IS NOT NULL
          GROUP BY host_id, bucket
         HAVING SUM(CASE WHEN sm_pct IS NOT NULL THEN 1 ELSE 0 END) = 0`,
    )
    .all();

  let repaired = 0;
  if (lostHours.length > 0) {
    const lost = [...new Set(lostHours.map((r) => r.host_id))];
    const placeholders = lost.map(() => '?').join(',');
    // Card-samples the user held, joined to the CARD's utilisation at the same
    // instant. Grouped per hour so the result can be merged into the rollup.
    const rows = db
      .prepare(
        `SELECT bucket, host_id, username,
                  SUM(cards)    AS card_samples,
                  SUM(util_sum) AS util_card_samples
             FROM (
               SELECT CAST(h.ts / ${HOUR_MS} AS INTEGER) * ${HOUR_MS} AS bucket,
                      h.host_id, h.username,
                      COUNT(*) AS cards,
                      SUM(g.util_pct) AS util_sum
                 FROM (SELECT DISTINCT ts, host_id, gpu_index, username
                         FROM proc_sample
                        WHERE username IS NOT NULL
                          AND host_id IN (${placeholders})) h
                 JOIN gpu_sample g
                   ON g.host_id = h.host_id AND g.ts = h.ts AND g.gpu_index = h.gpu_index
                WHERE g.util_pct IS NOT NULL
                GROUP BY h.ts, h.host_id, h.username
             )
            GROUP BY bucket, host_id, username`,
      )
      .all(...lost);

    const apply = db.prepare(
      `UPDATE usage_rollup
            SET sm_gpu_seconds = gpu_seconds * ? / 100.0
          WHERE bucket_ts = ? AND host_id = ? AND username = ?`,
    );

    db.exec('BEGIN');
    try {
      const lostSet = new Set(lostHours.map((r) => `${r.host_id}@${r.bucket}`));
      for (const r of rows) {
        if (!lostSet.has(`${r.host_id}@${r.bucket}`)) continue;
        if (!r.card_samples || r.util_card_samples === null) continue;
        // The ratio is a card-weighted average utilisation, so multiplying the
        // already-correct gpu_seconds by it needs no dt of its own.
        apply.run(r.util_card_samples / r.card_samples, r.bucket, r.host_id, r.username);
        repaired += 1;
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  setMeta('repair_pmon_sm_v1', String(Date.now()));
  return repaired;
}

/**
 * Rewrite `sm_gpu_seconds` for every hour still covered by raw samples, using
 * the current sole-occupant card-util attribution.
 *
 * The older per-process-SM sum understated a user's utilisation whenever a
 * parallel task parked companion processes on a card they never computed on:
 * pmon then attributes almost nothing to the card even though `utilization.gpu`
 * says it was busy (observed on gpu16 GPU0: card 70%, two process SMs summing
 * to 38%). `aggregateUserUsage` now takes the card's util when a single user
 * holds the card; this repair replays the retained samples through that rule so
 * the permanent accounting matches what new writes produce.
 *
 * Only COMPLETE hours whose samples are still on disk are rewritten. Hours
 * before the oldest surviving sample keep whatever the live writer accumulated
 * -- overwriting them with a partial integral would drop the unseen part, and
 * the project rule is that a repair writes measurements, never a guess.
 * `gpu_seconds` and `mem_mib_seconds` are untouched: they never depended on SM.
 *
 * @returns {number} rollup rows rewritten (0 when nothing needed repair)
 */
export function repairUnderstatedSm(db, getMeta, setMeta, intervalMs = 5000) {
  if (getMeta('repair_sole_card_util_v1')) return 0;

  db.exec('PRAGMA temp_store = MEMORY');

  const oldest = db
    .prepare(
      `SELECT MIN(ts) AS t FROM (
         SELECT ts FROM proc_sample
         UNION ALL
         SELECT ts FROM gpu_sample
       )`,
    )
    .get().t;
  if (oldest == null) {
    setMeta('repair_sole_card_util_v1', String(Date.now()));
    return 0;
  }

  // The hour that contains the oldest surviving sample is partial: credits
  // that landed before it are gone. Skip that bucket entirely.
  const firstBucket = Math.floor(oldest / HOUR_MS) * HOUR_MS + HOUR_MS;

  const hosts = db
    .prepare(
      `SELECT DISTINCT host_id FROM (
         SELECT host_id FROM proc_sample WHERE ts >= ?
         UNION
         SELECT host_id FROM gpu_sample WHERE ts >= ?
       )`,
    )
    .all(oldest, oldest)
    .map((r) => r.host_id);

  const qTs = db.prepare(
    `SELECT DISTINCT ts FROM (
       SELECT ts FROM gpu_sample WHERE host_id = ? AND ts >= ?
       UNION
       SELECT ts FROM proc_sample WHERE host_id = ? AND ts >= ?
     ) ORDER BY ts`,
  );
  const qProc = db.prepare(
    `SELECT ts,
            gpu_index      AS gpuIndex,
            username,
            used_mem_mib   AS usedMemMib,
            sm_pct         AS smPct
       FROM proc_sample
      WHERE host_id = ? AND ts >= ?
      ORDER BY ts`,
  );
  const qGpu = db.prepare(
    `SELECT ts, gpu_index AS [index], util_pct AS util
       FROM gpu_sample
      WHERE host_id = ? AND ts >= ?
      ORDER BY ts`,
  );
  const upd = db.prepare(
    `UPDATE usage_rollup
        SET sm_gpu_seconds = ?
      WHERE bucket_ts = ? AND host_id = ? AND username = ?
        AND bucket_ts >= ?`,
  );

  let repaired = 0;
  db.exec('BEGIN');
  try {
    for (const hostId of hosts) {
      const stamps = qTs.all(hostId, oldest, hostId, oldest).map((r) => r.ts);
      if (stamps.length === 0) continue;

      const procsByTs = new Map();
      for (const p of qProc.all(hostId, oldest)) {
        let list = procsByTs.get(p.ts);
        if (!list) {
          list = [];
          procsByTs.set(p.ts, list);
        }
        list.push(p);
      }
      const gpusByTs = new Map();
      for (const g of qGpu.all(hostId, oldest)) {
        let list = gpusByTs.get(g.ts);
        if (!list) {
          list = [];
          gpusByTs.set(g.ts, list);
        }
        list.push(g);
      }

      // Same dt rule as the live writer (writes.js recordSuccess): credit at
      // most two nominal intervals, and a gap is credited as one, never
      // back-filled as if the cards had been busy the whole time.
      const acc = new Map();
      let prev = null;
      for (const ts of stamps) {
        let dtMs = prev == null ? 0 : ts - prev;
        if (!Number.isFinite(dtMs) || dtMs < 0) dtMs = 0;
        if (dtMs > intervalMs * 2) dtMs = intervalMs;
        prev = ts;
        const dtS = dtMs / 1000;
        if (dtS <= 0) continue;

        const bucket = Math.floor(ts / HOUR_MS) * HOUR_MS;
        if (bucket < firstBucket) continue;

        for (const u of aggregateUserUsage(procsByTs.get(ts) ?? [], gpusByTs.get(ts) ?? [])) {
          const key = bucket + '\u0000' + u.username;
          acc.set(key, (acc.get(key) ?? 0) + (u.smSum / 100) * dtS);
        }
      }

      for (const [key, secs] of acc) {
        const sep = key.indexOf('\u0000');
        const bucket = Number(key.slice(0, sep));
        const username = key.slice(sep + 1);
        const r = upd.run(secs, bucket, hostId, username, firstBucket);
        repaired += r.changes;
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  setMeta('repair_sole_card_util_v1', String(Date.now()));
  return repaired;
}
