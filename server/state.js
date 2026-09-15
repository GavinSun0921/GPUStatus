/**
 * Live state: the current picture of every host, plus status transitions.
 *
 * The status light has four states:
 *
 *   unknown  never successfully polled
 *   ok       GREEN  -- last poll succeeded and the data is inside the freshness window
 *   stale    YELLOW -- data is older than poll.stale_after_ms, or a poll failed
 *                      but not yet often enough to call the host down
 *   down     RED    -- poll.down_after_failures consecutive failures
 *
 * Status is derived from timestamps on every read rather than being latched at
 * poll time. That matters: if the poller itself wedges, no poll ever completes,
 * and a latched status would leave every host showing green forever.
 */

import { aggregateUserUsage } from './db.js';
import { resolveHostLabel } from './config.js';

/**
 * Short, human-facing GPU name.
 *
 * Looks the exact nvidia-smi string up in the configured map first, because
 * nvidia-smi names are long and inconsistent ("NVIDIA GeForce RTX 4090" vs
 * "NVIDIA RTX 5880 Ada Generation") and do not fit a table.
 *
 * The fallback deliberately keeps the distinguishing part: the vendor prefix and
 * the marketing suffix are dropped, but the model number -- the only bit anyone
 * reads -- is preserved.
 */
export function displayGpuName(rawName, gpuNames) {
  if (!rawName) return null;
  const mapped = gpuNames?.[rawName];
  if (mapped) return mapped;

  return String(rawName)
    .replace(/^NVIDIA\s+/i, '')
    .replace(/\s+Generation$/i, '')
    .replace(/\s+(PCIe|SXM\d?)$/i, '')
    .trim();
}

export const STATUS = {
  UNKNOWN: 'unknown',
  OK: 'ok',
  STALE: 'stale',
  DOWN: 'down',
};

export class State {
  constructor(config) {
    this.config = config;
    this.hosts = new Map();
    this.startedAt = Date.now();
    this.lastPollCompletedAt = null;

    for (const h of config.hosts) {
      this.hosts.set(h.id, {
        host: h,
        latest: null,          // most recent derived sample
        status: STATUS.UNKNOWN,
        statusSince: Date.now(),
        lastOk: null,
        lastAttempt: null,
        lastError: null,
        consecutiveFailures: 0,
        durationMs: null,
        lastWarnings: [],
        totalPolls: 0,
        totalFailures: 0,
      });
    }

    this.listeners = new Set();
    this.transitionHandlers = new Set();
  }

  /**
   * Adopt a new configuration in place.
   *
   * Hosts that remain keep their accumulated counters and last known data, so a
   * config save does not blank the dashboard. New hosts start as `unknown` and
   * removed ones are dropped.
   */
  applyConfig(next) {
    this.config = next;

    const wanted = new Set(next.hosts.map((h) => h.id));
    for (const id of [...this.hosts.keys()]) {
      if (!wanted.has(id)) this.hosts.delete(id);
    }

    for (const host of next.hosts) {
      const existing = this.hosts.get(host.id);
      if (existing) {
        existing.host = host;
        continue;
      }
      this.hosts.set(host.id, {
        host,
        latest: null,
        status: STATUS.UNKNOWN,
        statusSince: Date.now(),
        lastOk: null,
        lastAttempt: null,
        lastError: null,
        consecutiveFailures: 0,
        durationMs: null,
        lastWarnings: [],
        totalPolls: 0,
        totalFailures: 0,
      });
    }
  }

  /** Subscribe to snapshot updates (SSE clients). */
  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * Subscribe to status transitions (up -> down -> up). This is the single place
   * transitions are reported, so the event log cannot miss one regardless of
   * whether the change was caused by a poll result or by the passage of time.
   */
  onTransition(fn) {
    this.transitionHandlers.add(fn);
    return () => this.transitionHandlers.delete(fn);
  }

  #emit(reason) {
    const snapshot = this.buildSnapshot();
    for (const fn of this.listeners) {
      try {
        fn(snapshot, reason);
      } catch {
        // A broken listener must not stop the poller.
      }
    }
  }

  /**
   * Fold a poll result into the state.
   *
   * Returns the transition it caused (if any) for convenience; the same
   * transition is also delivered to `onTransition` subscribers.
   */
  applyResult(hostId, result) {
    const entry = this.hosts.get(hostId);
    if (!entry) return [];

    const now = Date.now();

    entry.lastAttempt = now;
    entry.totalPolls += 1;

    if (result.ok && result.sample) {
      entry.latest = result.sample;
      entry.lastOk = result.sample.ts;
      entry.lastError = null;
      entry.consecutiveFailures = 0;
      entry.durationMs = result.durationMs ?? null;
      entry.lastWarnings = result.sample.warnings ?? [];
    } else {
      entry.totalFailures += 1;
      entry.consecutiveFailures += 1;
      entry.lastError = result.error ?? 'unknown error';
      entry.durationMs = result.durationMs ?? null;
      // Keep `latest` so the last known values stay visible (greyed out in the
      // UI) instead of the machine's cards vanishing from the dashboard.
    }

    const transition = this.#syncStatus(entry, now);
    return transition ? [transition] : [];
  }

  /**
   * Recompute a host's LATCHED status and, when it changes, notify transition
   * handlers (which is how host up/down history reaches the database).
   *
   * The status is latched rather than recomputed at render time so that a
   * transition can be detected exactly once -- recomputing in the view would
   * make "did it just change?" unanswerable and either duplicate or drop events.
   *
   * `prevSince` is captured before the update so the recovery message can report
   * how long the host spent in the previous state.
   */
  #syncStatus(entry, now) {
    const from = entry.status;
    const to = this.#computeStatus(entry, now);
    if (to === from) return null;

    const prevSince = entry.statusSince;
    entry.status = to;
    entry.statusSince = now;

    // The very first successful poll of a host is not a "recovery"; logging it
    // would emit one bogus event per host on every restart.
    if (from === STATUS.UNKNOWN && to === STATUS.OK) return null;

    let message;
    if (to === STATUS.DOWN) {
      message =
        `host down after ${entry.consecutiveFailures} failed polls: ${entry.lastError ?? ''}`.trim();
    } else if (to === STATUS.STALE) {
      message = entry.lastError
        ? `poll failed: ${entry.lastError}`
        : 'data is older than the freshness window';
    } else if (to === STATUS.OK) {
      message = `recovered after ${Math.round((now - prevSince) / 1000)}s in "${from}"`;
    } else {
      message = `status changed to ${to}`;
    }

    const transition = {
      hostId: entry.host.id,
      kind: to === STATUS.OK ? 'recovered' : to,
      from,
      to,
      message,
      ts: now,
    };

    for (const fn of this.transitionHandlers) {
      try {
        fn(transition, entry);
      } catch {
        // A broken handler must not stop the poller.
      }
    }
    return transition;
  }

  #computeStatus(entry, now) {
    if (entry.lastOk === null) {
      // Grey only until the first attempt. A host that has been tried and failed
      // is a problem worth showing immediately, not after the down threshold --
      // this is how a misconfigured ssh target becomes visible on cycle one.
      if (entry.consecutiveFailures >= this.config.poll.downAfterFailures) return STATUS.DOWN;
      if (entry.consecutiveFailures > 0) return STATUS.STALE;
      return STATUS.UNKNOWN;
    }
    if (entry.consecutiveFailures >= this.config.poll.downAfterFailures) return STATUS.DOWN;
    const age = now - entry.lastOk;
    if (age > this.config.poll.staleAfterMs) return STATUS.STALE;
    if (entry.consecutiveFailures > 0) return STATUS.STALE;
    return STATUS.OK;
  }

  /**
   * Recompute every status against the current clock. Called on a timer so that
   * a stalled poller still turns hosts yellow/red even though no poll result
   * ever arrives.
   *
   * Returns the transitions that occurred so the caller can log them.
   */
  refreshStatuses() {
    const now = Date.now();
    const transitions = [];
    for (const entry of this.hosts.values()) {
      const transition = this.#syncStatus(entry, now);
      if (transition) transitions.push(transition);
    }
    return transitions;
  }

  /** Mark that a full poll cycle finished, and notify subscribers. */
  cycleComplete() {
    this.lastPollCompletedAt = Date.now();
    this.#emit('poll');
  }

  notify(reason = 'update') {
    this.#emit(reason);
  }

  /**
   * Display name for a host, derived from the hostname it reports unless the
   * config overrides it. Recomputed rather than cached so it self-corrects the
   * moment a machine's hostname is first learned (or changes).
   */
  labelFor(hostId) {
    const entry = this.hosts.get(hostId);
    if (!entry) return hostId;
    return resolveHostLabel(entry.host, entry.latest?.hostname, this.config.naming);
  }

  /** Per-host user view, derived from the processes currently on its GPUs. */
  #hostUsers(entry) {
    const latest = entry.latest;
    if (!latest) return [];
    return aggregateUserUsage(latest.procs)
      .map((u) => {
        const procs = latest.procs.filter((p) => p.username === u.username);
        const gpuSet = [...new Set(procs.map((p) => p.gpuIndex).filter((i) => i !== null))].sort(
          (a, b) => a - b,
        );
        return {
          username: u.username,
          gpu_count: u.gpus,
          gpus: gpuSet,
          mem_mib: Math.round(u.memSum),
          proc_count: u.procCount,
          // Utilisation averaged over the cards this user occupies, which is the
          // number that answers "is this person actually using their allocation".
          sm_pct_avg: u.gpus > 0 ? Number((u.smSum / u.gpus).toFixed(1)) : null,
          sm_pct_sum: Number(u.smSum.toFixed(1)),
          procs: procs.map((p) => ({
            pid: p.pid,
            name: p.name,
            gpu_index: p.gpuIndex,
            used_mem_mib: p.usedMemMib,
            sm_pct: p.smPct,
          })),
        };
      })
      .sort((a, b) => b.gpu_count - a.gpu_count || b.mem_mib - a.mem_mib);
  }

  #hostView(entry, now) {
    const h = entry.host;
    const latest = entry.latest;
    const ageMs = entry.lastOk === null ? null : now - entry.lastOk;

    return {
      id: h.id,
      label: resolveHostLabel(h, latest?.hostname, this.config.naming),
      group: h.group,
      ssh: h.ssh,
      expect_gpus: h.expectGpus,
      note: h.note,

      status: entry.status,
      status_since: entry.statusSince,
      age_ms: ageMs,
      last_ok: entry.lastOk,
      last_attempt: entry.lastAttempt,
      consecutive_failures: entry.consecutiveFailures,
      last_error: entry.lastError,
      poll_duration_ms: entry.durationMs,
      total_polls: entry.totalPolls,
      total_failures: entry.totalFailures,
      warnings: entry.lastWarnings,
      stale: latest === null,

      hostname: latest?.hostname ?? null,
      kernel: latest?.kernel ?? null,
      driver_version: latest?.driverVersion ?? null,
      uptime_s: latest?.uptimeS ?? null,
      clock_skew_ms: latest?.clockSkewMs ?? null,
      nvidia_error: latest?.nvidiaError ?? null,

      cpu: latest
        ? {
            pct: latest.host.cpuPct,
            iowait_pct: latest.host.iowaitPct,
            ncpu: latest.host.ncpu,
            load1: latest.host.load1,
            load5: latest.host.load5,
            load15: latest.host.load15,
            running_procs: latest.host.runningProcs,
            total_procs: latest.host.totalProcs,
          }
        : null,
      mem: latest
        ? {
            total_mib: latest.host.memTotalMib,
            used_mib: latest.host.memUsedMib,
            avail_mib: latest.host.memAvailMib,
            pct: latest.host.memPct,
            swap_total_mib: latest.host.swapTotalMib,
            swap_used_mib: latest.host.swapUsedMib,
          }
        : null,
      // Every discovered filesystem is reported, each flagged with whether it is
      // ticked in the configuration. The overview renders only the ticked ones;
      // the admin page renders all of them as checkboxes, which is why the full
      // list must survive even when a selection exists.
      //
      // `disks_configured` distinguishes "never configured" (show everything)
      // from "ticked nothing" (show nothing). Those are different states and a
      // single empty array could not express both.
      //
      // Converted to the API's snake_case like every other nested object. These
      // were once passed straight through, so the UI silently read undefined for
      // every disk figure.
      // Network mounts: health only, no usage. `expected` marks entries that
      // were configured, so the UI can distinguish "ticked but absent" (a real
      // problem) from "merely discovered".
      net_mounts: (latest?.netMounts ?? []).map((m) => ({
        path: m.path,
        fstype: m.fstype,
        status: m.status,
        expected: (h.netMounts ?? []).includes(m.path),
      })),
      disks_configured: h.disks !== null,
      disks: (latest?.disks ?? []).map((d) => ({
        path: d.path,
        mount: d.mount,
        missing: d.missing,
        selected: h.disks === null || h.disks.includes(d.path),
        total_mib: d.totalMib,
        used_mib: d.usedMib,
        avail_mib: d.availMib,
        use_pct: d.usePct,
      })),

      // Each GPU carries the processes (and therefore users) sitting on it, so
      // the card view and the user view are the same data.
      gpus: (latest?.gpus ?? []).map((g) => ({
        index: g.index,
        uuid: g.uuid,
        name: g.name,
        // Friendly name resolved on the server so the UI, the API and any export
        // all agree. Unmapped models fall back to a shortened raw name.
        display_name: displayGpuName(g.name, this.config.gpuNames),
        util: g.util,
        mem_used_mib: g.memUsedMib,
        mem_total_mib: g.memTotalMib,
        mem_pct: g.memTotalMib ? (g.memUsedMib / g.memTotalMib) * 100 : null,
        temp_c: g.tempC,
        power_w: g.powerW,
        fan_pct: g.fanPct,
        n_procs: g.nProcs,
        procs: latest.procs
          .filter((p) => p.gpuIndex === g.index)
          .map((p) => ({
            pid: p.pid,
            username: p.username,
            name: p.name,
            used_mem_mib: p.usedMemMib,
            sm_pct: p.smPct,
          })),
      })),
      users: this.#hostUsers(entry),
    };
  }

  /** Full snapshot handed to the API and pushed over SSE. */
  buildSnapshot(now = Date.now()) {
    // Latch statuses first so the snapshot is always truthful about the present
    // moment. Without this a host whose data aged out would keep rendering green
    // until some unrelated code path happened to recompute it -- exactly the
    // failure this dashboard exists to catch.
    for (const entry of this.hosts.values()) this.#syncStatus(entry, now);

    const hosts = [...this.hosts.values()].map((e) => this.#hostView(e, now));

    // Cross-host per-user totals: the "who is using the cluster right now" view.
    const byUser = new Map();
    for (const host of hosts) {
      for (const u of host.users) {
        let agg = byUser.get(u.username);
        if (!agg) {
          agg = {
            username: u.username,
            gpu_count: 0,
            mem_mib: 0,
            proc_count: 0,
            sm_pct_sum: 0,
            hosts: [],
          };
          byUser.set(u.username, agg);
        }
        agg.gpu_count += u.gpu_count;
        agg.mem_mib += u.mem_mib;
        agg.proc_count += u.proc_count;
        agg.sm_pct_sum += u.sm_pct_sum;
        agg.hosts.push({ id: host.id, label: host.label, gpu_count: u.gpu_count, gpus: u.gpus });
      }
    }
    const users = [...byUser.values()]
      .map((u) => ({
        ...u,
        mem_mib: Math.round(u.mem_mib),
        sm_pct_sum: Number(u.sm_pct_sum.toFixed(1)),
        sm_pct_avg: u.gpu_count > 0 ? Number((u.sm_pct_sum / u.gpu_count).toFixed(1)) : null,
      }))
      .sort((a, b) => b.gpu_count - a.gpu_count || b.mem_mib - a.mem_mib);

    const gpus = hosts.flatMap((h) => h.gpus);
    // Only "a process holds it" is reported. Deriving a second "actually
    // computing" figure from utilisation was tried and removed: nvidia-smi
    // reports an INSTANTANEOUS sample, and one sample every poll interval cannot
    // distinguish an idle card from one that is between compute bursts. Claiming
    // a card is idle on that basis would be an over-claim. Sustained
    // utilisation is still meaningful, but only as an average over time, which
    // is what the usage rollups provide.
    const allocated = gpus.filter((g) => g.n_procs > 0).length;

    return {
      site: this.config.site,
      announcement: this.config.announcement,
      server_now: now,
      started_at: this.startedAt,
      last_poll_completed_at: this.lastPollCompletedAt,
      config: {
        interval_ms: this.config.poll.intervalMs,
        stale_after_ms: this.config.poll.staleAfterMs,
        down_after_failures: this.config.poll.downAfterFailures,
      },
      summary: {
        hosts_total: hosts.length,
        hosts_ok: hosts.filter((h) => h.status === STATUS.OK).length,
        hosts_stale: hosts.filter((h) => h.status === STATUS.STALE).length,
        hosts_down: hosts.filter((h) => h.status === STATUS.DOWN).length,
        hosts_unknown: hosts.filter((h) => h.status === STATUS.UNKNOWN).length,
        hosts_warning: hosts.filter((h) => h.warnings.length > 0).length,
        gpus_total: gpus.length,
        gpus_allocated: allocated,
        gpus_mem_used_mib: Math.round(gpus.reduce((a, g) => a + (g.mem_used_mib ?? 0), 0)),
        gpus_mem_total_mib: Math.round(gpus.reduce((a, g) => a + (g.mem_total_mib ?? 0), 0)),
        procs_total: gpus.reduce((a, g) => a + g.n_procs, 0),
        users_active: users.length,
      },
      hosts,
      users,
    };
  }
}
