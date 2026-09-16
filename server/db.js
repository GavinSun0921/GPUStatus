/**
 * Persistence layer.
 *
 * Uses `better-sqlite3`, whose synchronous `prepare` / `run` / `get` / `all` API
 * is what Node's built-in `node:sqlite` was modelled on; the two are
 * interchangeable, and this one is stable rather than a release candidate.
 * All state lives in one portable .db file.
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

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const HOUR_MS = 3600 * 1000;
const SCHEMA_VERSION = 1;

/** SQLite cannot bind NaN/Infinity/undefined; normalise them to NULL. */
function n(v) {
  if (v === null || v === undefined) return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
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
const THROTTLE_BAD_BITS = 0x008 | 0x020 | 0x040 | 0x080;

function s(v) {
  if (v === null || v === undefined) return null;
  return String(v);
}

/**
 * better-sqlite3 rather than the built-in `node:sqlite`.
 *
 * Both were tried. `node:sqlite` needs no installation, which was the original
 * reason for choosing it, but Node's own documentation still lists it as
 * "Stability: 1.2 - Release candidate" rather than stable, and it forced a
 * Node >= 22.5 floor on the deployment machine. better-sqlite3 is the library
 * node:sqlite's API was modelled on -- `prepare` / `run` / `get` / `all` /
 * `exec` are identical, so the swap touched one import -- and it installs from
 * a prebuilt binary in well under a second, with no compiler.
 */
import Database from 'better-sqlite3';

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
      u = { gpus: new Set(), smByGpu: new Map(), memSum: 0, procCount: 0 };
      byUser.set(username, u);
    }
    if (Number.isInteger(p.gpuIndex)) u.gpus.add(p.gpuIndex);

    const sm = Number.isFinite(p.smPct) ? Math.max(0, p.smPct) : 0;
    const key = Number.isInteger(p.gpuIndex) ? p.gpuIndex : -1;
    u.smByGpu.set(key, (u.smByGpu.get(key) ?? 0) + sm);

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
      memSum: u.memSum,
      procCount: u.procCount,
    });
  }
  return out;
}

export class Db {
  constructor(filePath, { intervalMs = 5000 } = {}) {
    if (filePath !== ':memory:') mkdirSync(dirname(filePath), { recursive: true });
    this.db = new Database(filePath);
    this.filePath = filePath;
    this.intervalMs = intervalMs;

    // WAL keeps the poller writing while the API reads. NORMAL synchronous mode
    // is the right durability/speed trade-off for monitoring data.
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec('PRAGMA foreign_keys = ON');

    this.#migrate();
    this.#addColumns();
    this.#migrateIndexes();
    this.repairedUsernames = this.#repairTruncatedUsernames();
    this.#backfillHostHourly();
    this.#prepare();
    this.prevTs = this.#loadPrevTimestamps();
  }

  /**
   * Add columns that were introduced after a database was first created.
   *
   * `CREATE TABLE IF NOT EXISTS` in #migrate() only helps a brand new file;
   * an existing deployment already has the table, so new columns have to be
   * added explicitly. SQLite has no "ADD COLUMN IF NOT EXISTS", hence the
   * pragma check. Existing rows get NULL for the new columns, which is the
   * honest value: those samples were taken before the metric was collected.
   */
  #addColumns() {
    const additions = [
      // Second wave of hourly metrics; the column list is duplicated from the
      // CREATE TABLE so an existing database gains them too.
      ['host_hourly', 'cpu_sum', 'REAL NOT NULL DEFAULT 0'],
      ['host_hourly', 'cpu_n', 'INTEGER NOT NULL DEFAULT 0'],
      ['host_hourly', 'sysmem_sum', 'REAL NOT NULL DEFAULT 0'],
      ['host_hourly', 'sysmem_n', 'INTEGER NOT NULL DEFAULT 0'],
      ['host_hourly', 'memutil_sum', 'REAL NOT NULL DEFAULT 0'],
      ['host_hourly', 'memutil_n', 'INTEGER NOT NULL DEFAULT 0'],
      ['host_hourly', 'throttle_sum', 'REAL NOT NULL DEFAULT 0'],
      ['host_hourly', 'throttle_n', 'INTEGER NOT NULL DEFAULT 0'],
      ['gpu_sample', 'throttle_mask', 'INTEGER'],
      ['gpu_sample', 'sm_clock_mhz', 'REAL'],
      ['gpu_sample', 'sm_clock_max_mhz', 'REAL'],
      ['gpu_sample', 'power_limit_w', 'REAL'],
      ['gpu_sample', 'pstate', 'TEXT'],
      ['gpu_sample', 'bus_id', 'TEXT'],
    ];
    for (const [table, column, type] of additions) {
      const existing = this.db.prepare(`PRAGMA table_info(${table})`).all();
      if (existing.some((c) => c.name === column)) continue;
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
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
   */
  #backfillHostHourly() {
    const { c } = this.db.prepare('SELECT COUNT(*) AS c FROM host_hourly').get();
    if (c > 0) {
      // The table already exists, but it may predate the second wave of
      // metrics. Fill only those, so switching metric on old data is not blank.
      this.#backfillHourlyExtras();
      return;
    }

    const available = this.db
      .prepare('SELECT COUNT(*) AS c FROM gpu_sample WHERE util_pct IS NOT NULL')
      .get().c;
    if (available === 0) return;

    // Temp tables in memory. The GROUP BY over every raw sample needs a sort,
    // and SQLite's default is a temp FILE whose location comes from the
    // environment -- on a machine where that directory is not writable the whole
    // statement fails with a bare "unable to open database file". It is also
    // simply faster here; the data is small enough to sort in RAM.
    this.db.exec('PRAGMA temp_store = MEMORY');

    // `COUNT(*) / COUNT(DISTINCT ts)` = average GPU rows per poll in the hour,
    // i.e. the card count. Cheaper and clearer than a correlated subquery per
    // row, which is what the first version used.
    this.db.exec(`
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

    const { c: rows } = this.db.prepare('SELECT COUNT(*) AS c FROM host_hourly').get();
    this.backfilledHours = rows;
  }

  /**
   * Fill the second-wave hourly metrics on rows that predate them.
   *
   * `cpu` and `sysmem` come from host_sample, `memutil` and `throttle` from
   * gpu_sample -- the same two sources the live writer reads. Guarded on
   * cpu_n = 0 rather than a schema version, so it is idempotent and re-runs if
   * the columns are ever cleared.
   */
  #backfillHourlyExtras() {
    const { c } = this.db
      .prepare('SELECT COUNT(*) AS c FROM host_hourly WHERE cpu_n = 0')
      .get();
    if (c === 0) return;

    this.db.exec('PRAGMA temp_store = MEMORY');

    // Host metrics: one row per host per tick.
    this.db.exec(`
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
    this.db.exec(`
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
   * Index changes that an existing database needs.
   *
   * `CREATE INDEX IF NOT EXISTS` cannot alter an index that already exists, so
   * the superseded ones are dropped by name here.
   */
  #migrateIndexes() {
    // Superseded by idx_gpu_sample_prune; unused since the per-GPU history
    // query was removed.
    this.db.exec('DROP INDEX IF EXISTS idx_gpu_sample_ts');
    this.db.exec('DROP INDEX IF EXISTS idx_gpu_sample_uuid');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_gpu_sample_prune ON gpu_sample(ts)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_host_sample_prune ON host_sample(ts)');
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
   * @returns {Array<[string, string]>} pairs actually merged
   */
  #repairTruncatedUsernames() {
    const names = this.db
      .prepare(
        `SELECT DISTINCT username FROM (
           SELECT username FROM proc_sample
           UNION SELECT username FROM usage_rollup
         ) WHERE username IS NOT NULL`,
      )
      .all()
      .map((r) => r.username);

    const suspects = names.filter((u) => /\+$/.test(u));
    if (suspects.length === 0) return [];

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

    this.db.exec('BEGIN');
    try {
      for (const [bad, full] of merged) {
        this.db.prepare('UPDATE proc_sample SET username = ? WHERE username = ?').run(full, bad);
        // Merge the rollup rows rather than renaming: the full name usually
        // already has a row for the same (hour, host), and simply renaming would
        // violate the primary key or silently drop one side's GPU-hours.
        this.db
          .prepare(
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
          )
          .run(full, bad);
        this.db.prepare('DELETE FROM usage_rollup WHERE username = ?').run(bad);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }

    if (ambiguous.length > 0) {
      this.truncatedNameAmbiguities = ambiguous;
    }
    return merged;
  }

  #migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS hosts (
        id          TEXT PRIMARY KEY,
        label       TEXT NOT NULL,
        ssh_target  TEXT NOT NULL,
        grp         TEXT,
        expect_gpus INTEGER,
        first_seen  INTEGER NOT NULL,
        last_ok     INTEGER,
        last_attempt INTEGER,
        last_error  TEXT,
        last_hostname TEXT,
        driver_version TEXT
      );

      CREATE TABLE IF NOT EXISTS host_sample (
        ts             INTEGER NOT NULL,
        host_id        TEXT    NOT NULL,
        cpu_pct        REAL,
        iowait_pct     REAL,
        ncpu           INTEGER,
        load1          REAL,
        load5          REAL,
        load15         REAL,
        running_procs  INTEGER,
        mem_total_mib  REAL,
        mem_used_mib   REAL,
        mem_avail_mib  REAL,
        mem_pct        REAL,
        swap_total_mib REAL,
        swap_used_mib  REAL,
        uptime_s       INTEGER,
        n_gpus         INTEGER,
        driver_version TEXT
      );
      -- (host_id, ts) is a covering index for the "latest timestamp per host"
      -- lookup on startup, so it stays.
      CREATE INDEX IF NOT EXISTS idx_host_sample_ts ON host_sample(host_id, ts);
      -- ...but its leading column is host_id, which cannot serve the prune's
      -- a ts-range condition. Hence a second index on ts alone.
      CREATE INDEX IF NOT EXISTS idx_host_sample_prune ON host_sample(ts);

      CREATE TABLE IF NOT EXISTS gpu_sample (
        ts           INTEGER NOT NULL,
        host_id      TEXT    NOT NULL,
        gpu_index    INTEGER NOT NULL,
        gpu_uuid     TEXT,
        gpu_name     TEXT,
        util_pct     REAL,
        mem_used_mib REAL,
        mem_total_mib REAL,
        mem_util_pct REAL,
        temp_c       REAL,
        power_w      REAL,
        fan_pct      REAL,
        n_procs      INTEGER,
        -- Health telemetry. throttle_mask is nvidia-smi's
        -- clocks_throttle_reasons bitmask (see THROTTLE_REASONS in state.js).
        -- NULL means the card did not report a value -- deliberately not 0,
        -- which would read as "not throttled" for a reading we never got.
        -- (No backticks in this comment: the whole schema is a JS template
        --  literal, and a backtick here would terminate it.)
        throttle_mask    INTEGER,
        sm_clock_mhz     REAL,
        sm_clock_max_mhz REAL,
        power_limit_w    REAL,
        pstate           TEXT,
        -- Physical PCI slot, e.g. "37:00.0". The GPU INDEX is positional and
        -- shifts whenever cards are masked off, so it cannot identify a card
        -- across time; the slot can, and it is what you would use to find the
        -- card in the chassis.
        bus_id           TEXT
      );
      -- Indexed on ts, because the only statement that reads this table in bulk
      -- is the retention prune (WHERE ts < cutoff). It used to carry
      -- (host_id, ts) and (gpu_uuid, ts) for the per-GPU history query; that
      -- query is gone with the 历史 page, and with a leading host_id/gpu_uuid
      -- neither index could serve a ts-range scan anyway. They were pure cost:
      -- two index updates for every one of the ~48 rows written per poll.
      CREATE INDEX IF NOT EXISTS idx_gpu_sample_prune ON gpu_sample(ts);

      CREATE TABLE IF NOT EXISTS proc_sample (
        ts           INTEGER NOT NULL,
        host_id      TEXT    NOT NULL,
        gpu_index    INTEGER,
        gpu_uuid     TEXT,
        pid          INTEGER,
        username     TEXT,
        proc_name    TEXT,
        used_mem_mib REAL,
        sm_pct       REAL
      );
      CREATE INDEX IF NOT EXISTS idx_proc_sample_ts ON proc_sample(ts);
      CREATE INDEX IF NOT EXISTS idx_proc_sample_user ON proc_sample(username, ts);
      CREATE INDEX IF NOT EXISTS idx_proc_sample_host ON proc_sample(host_id, ts);

      -- Machine-level rollup, one row per hour, NEVER pruned.
      --
      -- The raw tables are deleted after raw_retention_hours (default 7 days),
      -- which is not long enough for a "how busy was this machine over the last
      -- month" chart. Keeping the raw rows that long is not an option either:
      -- ~273k rows/day (~32 MB/day) means a month would approach a gigabyte.
      --
      -- This is what that chart actually needs, at ~144 rows/day in total.
      -- Sums and counts are accumulated rather than an average, so the running
      -- average stays exact regardless of how many samples land in the hour.
      -- Averages rather than integrals because the question is "how utilised
      -- was this machine", not "how much did anyone use" -- that is usage_rollup.
      CREATE TABLE IF NOT EXISTS host_hourly (
        bucket_ts  INTEGER NOT NULL,
        host_id    TEXT    NOT NULL,
        util_sum   REAL    NOT NULL DEFAULT 0,
        util_n     INTEGER NOT NULL DEFAULT 0,
        mem_sum    REAL    NOT NULL DEFAULT 0,
        mem_n      INTEGER NOT NULL DEFAULT 0,
        temp_max_c REAL,
        power_sum  REAL    NOT NULL DEFAULT 0,
        power_n    INTEGER NOT NULL DEFAULT 0,
        n_gpus     INTEGER,
        -- Second wave of metrics, all computed from data already in hand at
        -- write time: the host sample carries cpu/memory, the GPU samples carry
        -- bandwidth and throttle state.
        cpu_sum      REAL    NOT NULL DEFAULT 0,
        cpu_n        INTEGER NOT NULL DEFAULT 0,
        sysmem_sum   REAL    NOT NULL DEFAULT 0,
        sysmem_n     INTEGER NOT NULL DEFAULT 0,
        -- memory-BANDWIDTH utilisation, which is not the same as mem_sum above
        -- (how full the memory is)
        memutil_sum  REAL    NOT NULL DEFAULT 0,
        memutil_n    INTEGER NOT NULL DEFAULT 0,
        -- average number of cards throttled for a reason that costs
        -- performance. Power capping is excluded: at full load it is the card
        -- behaving as configured, and plotting it would make every busy hour
        -- look like an incident.
        throttle_sum REAL    NOT NULL DEFAULT 0,
        throttle_n   INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (bucket_ts, host_id)
      );

      CREATE TABLE IF NOT EXISTS usage_rollup (
        bucket_ts       INTEGER NOT NULL,
        host_id         TEXT    NOT NULL,
        username        TEXT    NOT NULL,
        gpu_seconds     REAL    NOT NULL DEFAULT 0,
        sm_gpu_seconds  REAL    NOT NULL DEFAULT 0,
        mem_mib_seconds REAL    NOT NULL DEFAULT 0,
        peak_gpus       INTEGER NOT NULL DEFAULT 0,
        peak_mem_mib    REAL    NOT NULL DEFAULT 0,
        samples         INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (bucket_ts, host_id, username)
      );
      CREATE INDEX IF NOT EXISTS idx_rollup_user ON usage_rollup(username, bucket_ts);
      CREATE INDEX IF NOT EXISTS idx_rollup_bucket ON usage_rollup(bucket_ts);

      CREATE TABLE IF NOT EXISTS events (
        ts      INTEGER NOT NULL,
        host_id TEXT    NOT NULL,
        kind    TEXT    NOT NULL,
        message TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
    `);
    this.db
      .prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
      .run('schema_version', String(SCHEMA_VERSION));
  }

  #prepare() {
    this.stmt = {
      upsertHost: this.db.prepare(`
        INSERT INTO hosts (id, label, ssh_target, grp, expect_gpus, first_seen)
        VALUES (?, COALESCE(?, ?), ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          -- Only a label pinned in the config overwrites the stored name, so a
          -- restart cannot blank the name learned from the hostname.
          label = COALESCE(?, hosts.label),
          ssh_target = excluded.ssh_target,
          grp = excluded.grp, expect_gpus = excluded.expect_gpus`),

      markAttempt: this.db.prepare('UPDATE hosts SET last_attempt = ? WHERE id = ?'),
      markOk: this.db.prepare(`
        UPDATE hosts SET last_ok = ?, last_error = NULL, last_hostname = ?,
          driver_version = ?, label = COALESCE(?, label)
        WHERE id = ?`),
      markError: this.db.prepare('UPDATE hosts SET last_error = ? WHERE id = ?'),

      insHostSample: this.db.prepare(`
        INSERT INTO host_sample (ts, host_id, cpu_pct, iowait_pct, ncpu, load1, load5, load15,
          running_procs, mem_total_mib, mem_used_mib, mem_avail_mib, mem_pct,
          swap_total_mib, swap_used_mib, uptime_s, n_gpus, driver_version)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),

      insGpuSample: this.db.prepare(`
        INSERT INTO gpu_sample (ts, host_id, gpu_index, gpu_uuid, gpu_name, util_pct,
          mem_used_mib, mem_total_mib, mem_util_pct, temp_c, power_w, fan_pct, n_procs,
          throttle_mask, sm_clock_mhz, sm_clock_max_mhz, power_limit_w, pstate, bus_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),

      insProcSample: this.db.prepare(`
        INSERT INTO proc_sample (ts, host_id, gpu_index, gpu_uuid, pid, username,
          proc_name, used_mem_mib, sm_pct)
        VALUES (?,?,?,?,?,?,?,?,?)`),

      upsertHostHourly: this.db.prepare(`
        INSERT INTO host_hourly (bucket_ts, host_id, util_sum, util_n, mem_sum, mem_n,
          temp_max_c, power_sum, power_n, n_gpus,
          cpu_sum, cpu_n, sysmem_sum, sysmem_n, memutil_sum, memutil_n,
          throttle_sum, throttle_n)
        -- Every count is a PARAMETER, not a literal 1, because a metric can be
        -- genuinely absent: the first poll after a restart has no previous
        -- /proc/stat to diff, so cpuPct is null. Binding null to the NOT NULL
        -- *_sum column threw "NOT NULL constraint failed: host_hourly.cpu_sum"
        -- and lost the whole sample -- once per machine per restart. Adding a
        -- literal 1 to the count would have been wrong too: it would record a
        -- sample that never happened.
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(bucket_ts, host_id) DO UPDATE SET
          util_sum     = util_sum + excluded.util_sum,
          util_n       = util_n + excluded.util_n,
          mem_sum      = mem_sum + excluded.mem_sum,
          mem_n        = mem_n + excluded.mem_n,
          temp_max_c   = MAX(COALESCE(temp_max_c, excluded.temp_max_c), excluded.temp_max_c),
          power_sum    = power_sum + excluded.power_sum,
          power_n      = power_n + excluded.power_n,
          n_gpus       = MAX(COALESCE(n_gpus, 0), excluded.n_gpus),
          cpu_sum      = cpu_sum + excluded.cpu_sum,
          cpu_n        = cpu_n + excluded.cpu_n,
          sysmem_sum   = sysmem_sum + excluded.sysmem_sum,
          sysmem_n     = sysmem_n + excluded.sysmem_n,
          memutil_sum  = memutil_sum + excluded.memutil_sum,
          memutil_n    = memutil_n + excluded.memutil_n,
          throttle_sum = throttle_sum + excluded.throttle_sum,
          throttle_n   = throttle_n + excluded.throttle_n`),

      upsertRollup: this.db.prepare(`
        INSERT INTO usage_rollup (bucket_ts, host_id, username, gpu_seconds,
          sm_gpu_seconds, mem_mib_seconds, peak_gpus, peak_mem_mib, samples)
        VALUES (?,?,?,?,?,?,?,?,1)
        ON CONFLICT(bucket_ts, host_id, username) DO UPDATE SET
          gpu_seconds     = gpu_seconds     + excluded.gpu_seconds,
          sm_gpu_seconds  = sm_gpu_seconds  + excluded.sm_gpu_seconds,
          mem_mib_seconds = mem_mib_seconds + excluded.mem_mib_seconds,
          peak_gpus       = MAX(peak_gpus,       excluded.peak_gpus),
          peak_mem_mib    = MAX(peak_mem_mib,    excluded.peak_mem_mib),
          samples         = samples + 1`),

      insEvent: this.db.prepare('INSERT INTO events (ts, host_id, kind, message) VALUES (?,?,?,?)'),
      pruneHost: this.db.prepare('DELETE FROM host_sample WHERE ts < ?'),
      pruneGpu: this.db.prepare('DELETE FROM gpu_sample WHERE ts < ?'),
      pruneProc: this.db.prepare('DELETE FROM proc_sample WHERE ts < ?'),
    };
  }

  /**
   * Last sample timestamp per host, so a restart does not lose the baseline and
   * credit a huge dt to the first sample after boot.
   */
  #loadPrevTimestamps() {
    const map = new Map();
    for (const row of this.db.prepare('SELECT host_id, MAX(ts) AS ts FROM host_sample GROUP BY host_id').all()) {
      map.set(row.host_id, Number(row.ts));
    }
    return map;
  }

  registerHosts(hosts, now = Date.now()) {
    for (const h of hosts) {
      // label may be null (meaning "derive it from the hostname"); the column is
      // NOT NULL, so fall back to the id as a placeholder until the first poll.
      this.stmt.upsertHost.run(
        h.id, s(h.label), h.id, h.ssh, s(h.group), n(h.expectGpus), now, s(h.label),
      );
    }
  }

  markAttempt(hostId, ts) {
    this.stmt.markAttempt.run(ts, hostId);
  }

  recordEvent(ts, hostId, kind, message) {
    this.stmt.insEvent.run(ts, hostId, kind, s(message));
  }

  recordFailure(hostId, ts, error) {
    this.stmt.markAttempt.run(ts, hostId);
    this.stmt.markError.run(s(String(error).slice(0, 500)), hostId);
  }

  /**
   * Persist one successful poll: raw samples for the detail view plus the
   * permanent per-user rollup for accounting.
   *
   * All writes happen in a single transaction so a crash can never leave the
   * rollup disagreeing with the raw samples.
   */
  recordSuccess(hostId, sample) {
    const { ts, host, gpus, procs, uptimeS, driverVersion, hostname, label } = sample;

    // Credit at most two nominal intervals per sample. A gap (poller restart,
    // host rebooting) must not be back-filled as if the GPUs had been busy the
    // whole time -- under-counting an outage is far safer than inventing usage.
    const prev = this.prevTs.get(hostId);
    let dtMs = prev === undefined ? 0 : ts - prev;
    if (!Number.isFinite(dtMs) || dtMs < 0) dtMs = 0; // counter went backwards (host reboot)
    if (dtMs > this.intervalMs * 2) dtMs = this.intervalMs;
    const dtS = dtMs / 1000;

    this.db.exec('BEGIN');
    try {
      this.stmt.insHostSample.run(
        ts, hostId,
        n(host.cpuPct), n(host.iowaitPct), n(host.ncpu), n(host.load1), n(host.load5), n(host.load15),
        n(host.runningProcs), n(host.memTotalMib), n(host.memUsedMib), n(host.memAvailMib),
        n(host.memPct), n(host.swapTotalMib), n(host.swapUsedMib),
        n(uptimeS), n(gpus.length), s(driverVersion),
      );

      for (const g of gpus) {
        this.stmt.insGpuSample.run(
          ts, hostId, n(g.index), s(g.uuid), s(g.name), n(g.util),
          n(g.memUsedMib), n(g.memTotalMib), n(g.memUtil), n(g.tempC), n(g.powerW),
          n(g.fanPct), n(g.nProcs),
          n(g.throttleMask), n(g.smClockMhz), n(g.smClockMaxMhz), n(g.powerLimitW),
          s(g.pstate), s(g.busId),
        );
      }

      for (const p of procs) {
        this.stmt.insProcSample.run(
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

          this.stmt.upsertHostHourly.run(
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
          this.stmt.upsertRollup.run(
            bucketTs, hostId, u.username,
            u.gpus * dtS,
            (u.smSum / 100) * dtS,
            u.memSum * dtS,
            u.gpus,
            u.memSum,
          );
        }
      }

      this.stmt.markOk.run(ts, s(hostname), s(driverVersion), s(label), hostId);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }

    this.prevTs.set(hostId, ts);
  }

  /** Drop raw samples past the retention window. Rollups are never pruned. */
  pruneRaw(retentionHours, now = Date.now()) {
    if (!retentionHours || retentionHours <= 0) return 0;
    const cutoff = now - retentionHours * HOUR_MS;
    let removed = 0;
    this.db.exec('BEGIN');
    try {
      removed += this.stmt.pruneHost.run(cutoff).changes;
      removed += this.stmt.pruneGpu.run(cutoff).changes;
      removed += this.stmt.pruneProc.run(cutoff).changes;
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return removed;
  }

  // ---------------------------------------------------------------- queries --

  /**
   * Aggregated usage for a time range, grouped by user (optionally by host).
   *
   * `bucketSeconds` re-buckets the hourly rollups (86400 = daily, 604800 =
   * weekly) so a year-end report is a single indexed scan.
   */
  queryUsage({ fromTs, toTs, hostId = null, username = null, bucketSeconds = 0 }) {
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

    return this.db
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

  /** Totals per user over a range -- the classic year-end table. */
  queryUsageTotals({ fromTs, toTs, hostId = null }) {
    const where = ['bucket_ts >= ?', 'bucket_ts < ?'];
    const params = [fromTs, toTs];
    if (hostId) {
      where.push('host_id = ?');
      params.push(hostId);
    }
    return this.db
      .prepare(`
        SELECT username,
               SUM(gpu_seconds)     AS gpu_seconds,
               SUM(sm_gpu_seconds)  AS sm_gpu_seconds,
               SUM(mem_mib_seconds) AS mem_mib_seconds,
               MAX(peak_gpus)       AS peak_gpus,
               COUNT(DISTINCT host_id)  AS host_count,
               MIN(bucket_ts)       AS first_seen,
               MAX(bucket_ts)       AS last_seen
        FROM usage_rollup
        WHERE ${where.join(' AND ')}
        GROUP BY username
        ORDER BY gpu_seconds DESC`)
      .all(...params);
  }


  /**
   * Hourly history for one machine, from the never-pruned rollup.
   *
   * Every range the UI offers (24h / 3d / 7d / 30d) is served from the same
   * table, so the chart does not change character at the raw-retention
   * boundary, and an idle hour is a 0 rather than a hole.
   */
  queryHostHourly(hostId, fromTs, toTs) {
    return this.db
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


  queryEvents({ limit = 100, hostId = null } = {}) {
    if (hostId) {
      return this.db
        .prepare('SELECT * FROM events WHERE host_id = ? ORDER BY ts DESC LIMIT ?')
        .all(hostId, limit);
    }
    return this.db.prepare('SELECT * FROM events ORDER BY ts DESC LIMIT ?').all(limit);
  }

  /** Distinct users seen recently, for filter dropdowns. */
  queryRecentUsers(sinceTs) {
    return this.db
      .prepare('SELECT DISTINCT username FROM proc_sample WHERE ts >= ? ORDER BY username')
      .all(sinceTs)
      .map((r) => r.username);
  }

  // ------------------------------------------------------------------ meta --

  getMeta(key) {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
    return row ? row.value : null;
  }

  setMeta(key, value) {
    this.db
      .prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
      .run(key, String(value));
  }

  close() {
    this.db.close();
  }
}
