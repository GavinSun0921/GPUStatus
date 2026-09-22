/**
 * DDL and schema migrations.
 *
 * Split out of the old monolithic db.js so the SQL that defines the tables
 * lives next to the column/index upgrades an existing file needs -- the two
 * have to agree, and they are the only places a backtick in a SQL comment can
 * break a template literal.
 */

import { SCHEMA_VERSION } from './helpers.js';

/**
 * Add columns that were introduced after a database was first created.
 *
 * `CREATE TABLE IF NOT EXISTS` only helps a brand new file; an existing
 * deployment already has the table, so new columns have to be added explicitly.
 * SQLite has no "ADD COLUMN IF NOT EXISTS", hence the pragma check. Existing
 * rows get NULL for the new columns, which is the honest value: those samples
 * were taken before the metric was collected.
 */
const COLUMN_ADDITIONS = [
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
  ['hosts', 'gpu_name', 'TEXT'],
];

export function createSchema(db) {
  db.exec(`
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
        driver_version TEXT,
        -- Exact nvidia-smi model string of the cards in this machine. Hosts are
        -- homogeneous, so one name prices every card here. Kept permanent (unlike
        -- gpu_sample, which is pruned) because year-end cost needs the model
        -- long after the raw samples are gone.
        gpu_name       TEXT
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
      -- query is gone with the history page, and with a leading host_id/gpu_uuid
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

      -- Peak number of GPUs one user held AT THE SAME TIME, across every
      -- machine, per hour.
      --
      -- This cannot be derived from usage_rollup: that table is keyed by
      -- (hour, host, user), so the best it can answer is "the most this user had
      -- on any ONE machine". A user running 6 GPUs on each of three machines
      -- simultaneously shows 6 instead of 18. On the 16-machine cluster that
      -- undercounted 4 of 16 users, one of them by half.
      CREATE TABLE IF NOT EXISTS usage_peak (
        bucket_ts  INTEGER NOT NULL,
        username   TEXT    NOT NULL,
        peak_gpus  INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (bucket_ts, username)
      );

      CREATE TABLE IF NOT EXISTS events (
        ts      INTEGER NOT NULL,
        host_id TEXT    NOT NULL,
        kind    TEXT    NOT NULL,
        message TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
    `);
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(
    'schema_version',
    String(SCHEMA_VERSION),
  );
}

export function addMissingColumns(db) {
  for (const [table, column, type] of COLUMN_ADDITIONS) {
    const existing = db.prepare(`PRAGMA table_info(${table})`).all();
    if (existing.some((c) => c.name === column)) continue;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

/**
 * Index changes that an existing database needs.
 *
 * `CREATE INDEX IF NOT EXISTS` cannot alter an index that already exists, so
 * the superseded ones are dropped by name here.
 */
export function migrateIndexes(db) {
  // Superseded by idx_gpu_sample_prune; unused since the per-GPU history
  // query was removed.
  db.exec('DROP INDEX IF EXISTS idx_gpu_sample_ts');
  db.exec('DROP INDEX IF EXISTS idx_gpu_sample_uuid');
  db.exec('CREATE INDEX IF NOT EXISTS idx_gpu_sample_prune ON gpu_sample(ts)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_host_sample_prune ON host_sample(ts)');
}
