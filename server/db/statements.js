/**
 * Prepared statements for the write path.
 *
 * Kept in one factory so the SQL column lists sit next to each other and a
 * column added in schema.js has exactly one place to be wired in.
 */

export function createStatements(db) {
  return {
    upsertHost: db.prepare(`
        INSERT INTO hosts (id, label, ssh_target, grp, expect_gpus, first_seen)
        VALUES (?, COALESCE(?, ?), ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          -- Only a label pinned in the config overwrites the stored name, so a
          -- restart cannot blank the name learned from the hostname.
          label = COALESCE(?, hosts.label),
          ssh_target = excluded.ssh_target,
          grp = excluded.grp, expect_gpus = excluded.expect_gpus`),

    markAttempt: db.prepare('UPDATE hosts SET last_attempt = ? WHERE id = ?'),
    // gpu_name is COALESCEd: a sample with no cards (nvidia-smi down) must not
    // blank the model we already know, or cost would lose its price key.
    markOk: db.prepare(`
        UPDATE hosts SET last_ok = ?, last_error = NULL, last_hostname = ?,
          driver_version = ?, label = COALESCE(?, label), gpu_name = COALESCE(?, gpu_name)
        WHERE id = ?`),
    markError: db.prepare('UPDATE hosts SET last_error = ? WHERE id = ?'),

    insHostSample: db.prepare(`
        INSERT INTO host_sample (ts, host_id, cpu_pct, iowait_pct, ncpu, load1, load5, load15,
          running_procs, mem_total_mib, mem_used_mib, mem_avail_mib, mem_pct,
          swap_total_mib, swap_used_mib, uptime_s, n_gpus, driver_version)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),

    insGpuSample: db.prepare(`
        INSERT INTO gpu_sample (ts, host_id, gpu_index, gpu_uuid, gpu_name, util_pct,
          mem_used_mib, mem_total_mib, mem_util_pct, temp_c, power_w, fan_pct, n_procs,
          throttle_mask, sm_clock_mhz, sm_clock_max_mhz, power_limit_w, pstate, bus_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),

    insProcSample: db.prepare(`
        INSERT INTO proc_sample (ts, host_id, gpu_index, gpu_uuid, pid, username,
          proc_name, used_mem_mib, sm_pct)
        VALUES (?,?,?,?,?,?,?,?,?)`),

    upsertHostHourly: db.prepare(`
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

    upsertRollup: db.prepare(`
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

    upsertPeak: db.prepare(`
        INSERT INTO usage_peak (bucket_ts, username, peak_gpus) VALUES (?,?,?)
        ON CONFLICT(bucket_ts, username) DO UPDATE SET
          peak_gpus = MAX(peak_gpus, excluded.peak_gpus)`),

    insEvent: db.prepare('INSERT INTO events (ts, host_id, kind, message) VALUES (?,?,?,?)'),
    pruneHost: db.prepare('DELETE FROM host_sample WHERE ts < ?'),
    pruneGpu: db.prepare('DELETE FROM gpu_sample WHERE ts < ?'),
    pruneProc: db.prepare('DELETE FROM proc_sample WHERE ts < ?'),
  };
}
