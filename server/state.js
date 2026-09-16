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

/**
 * nvidia-smi's clocks_throttle_reasons bitmask.
 *
 * `bad` marks the reasons that mean the card is delivering less than it should
 * WHILE IT HAS WORK TO DO. GpuIdle is deliberately not bad: an idle card
 * downclocks by design, and flagging that would light up every quiet machine.
 * The rest of the hardware reasons are grouped under one label because the
 * operator's next step is the same for all of them -- go and look at the card.
 */
export const THROTTLE_REASONS = [
  { bit: 0x001, label: '空闲', bad: false },
  { bit: 0x002, label: '应用时钟限制', bad: false },
  { bit: 0x004, label: '功耗墙', bad: true },
  { bit: 0x008, label: '硬件降频', bad: true },
  { bit: 0x010, label: '同步加速', bad: false },
  { bit: 0x020, label: '热降频', bad: true },
  { bit: 0x040, label: '硬件热降频', bad: true },
  { bit: 0x080, label: '硬件功率制动', bad: true },
  { bit: 0x100, label: '显示时钟限制', bad: false },
];

/**
 * Decode a throttle bitmask into `{ mask, reasons, throttled }`.
 *
 * `throttled` is true only for a reason that actually costs performance, and
 * only when the card is NOT idle -- a card sitting at P8 with the GpuIdle bit
 * set is doing exactly what it should.
 */
export function decodeThrottle(mask, { idle = false } = {}) {
  if (mask === null || mask === undefined || !Number.isFinite(mask)) {
    return { mask: null, reasons: [], throttled: false };
  }
  const reasons = THROTTLE_REASONS.filter((r) => (mask & r.bit) !== 0).map((r) => r.label);
  const bad = THROTTLE_REASONS.filter((r) => r.bad && (mask & r.bit) !== 0);
  return { mask, reasons, throttled: bad.length > 0 && !idle };
}

/**
 * Percentage of the recent window a card spent in thermal slowdown.
 *
 * Null (not 0) when there is no history yet: "no data" and "never throttled"
 * are different answers, and 0 would claim the reassuring one.
 */
export function thermalShare(ring) {
  if (!ring || ring.length < THERMAL_MIN_SAMPLES) return null;
  const hot = ring.reduce((a, b) => a + b, 0);
  return Number(((hot / ring.length) * 100).toFixed(1));
}

/**
 * One warning entry when any card on a host is throttled for a reason that
 * costs performance, e.g. "throttled:5/8_thermal".
 *
 * Reasons are reduced to a short set: an operator needs to know how many cards
 * and roughly why, then goes to look.
 */
export function throttleWarnings(sample, thermal) {
  if (!sample || !Array.isArray(sample.gpus) || sample.gpus.length === 0) return [];

  const hot = [];
  const power = [];
  for (const g of sample.gpus) {
    const idle = g.nProcs === 0 && (g.util === null || g.util < 5);
    const { mask } = decodeThrottle(g.throttleMask, { idle });
    if (mask === null) continue;
    if ((mask & 0x020) !== 0 || (mask & 0x040) !== 0) hot.push(g.index);
    else if ((mask & 0x004) !== 0) power.push(g.index);
  }

  const out = [];
  // Thermal first: it is a cooling problem someone can act on, whereas a power
  // cap at full utilisation is the card behaving as configured.
  if (hot.length > 0) out.push(`throttled:${hot.length}/${sample.gpus.length}_thermal`);
  if (power.length > 0) out.push(`throttled:${power.length}/${sample.gpus.length}_power_cap`);

  // A PCIe link that has trained NARROWER than the card supports runs slower
  // while every other metric looks normal.
  //
  // Width, not generation: a link renegotiates its generation down when the
  // card is idle, so gen < gen_max is routinely normal. Width does not do that,
  // and a card reporting fewer lanes is a real fault (riser, seating, slot).
  // Busy cards only, for the same reason the throttle check ignores idle ones.
  // Cards that were thermally throttled at ANY point in the recent window, even
  // if the newest sample happens to say "power cap". Without this the header
  // reads "功耗墙" for a machine that is genuinely hitting its thermal target.
  const recentThermal = sample.gpus.filter(
    (g) => (thermalShare(thermal?.get(g.index)) ?? 0) > 0,
  );
  if (recentThermal.length > 0 && hot.length === 0) {
    out.push(`throttled:${recentThermal.length}/${sample.gpus.length}_thermal_recent`);
  }

  const narrow = sample.gpus.filter((g) => {
    const busy = (g.nProcs ?? 0) > 0 || (g.util ?? 0) >= 5;
    return (
      busy &&
      typeof g.pcieWidth === 'number' &&
      typeof g.pcieWidthMax === 'number' &&
      g.pcieWidth < g.pcieWidthMax
    );
  });
  if (narrow.length > 0) {
    out.push(`pcie_degraded:${narrow.length}/${sample.gpus.length}`);
  }
  return out;
}

/**
 * How many recent samples the thermal history remembers.
 *
 * The throttle bitmask is INSTANTANEOUS, and a card near its thermal target
 * alternates: on Server19 the same card reports "power cap" in one sample and
 * "thermal slowdown" in the next. Reading only the latest sample therefore says
 * "功耗墙" almost always, and the ~1% of samples that were thermally throttled
 * are never visible -- which is exactly the question an operator asks when a
 * card sits at 87 degrees.
 *
 * 240 samples is about an hour at the default 15s interval.
 */
const THERMAL_WINDOW = 240;
const THERMAL_BITS = 0x020 | 0x040;

/**
 * Samples needed before the share is reported.
 *
 * Just after a restart the window holds one or two samples, and a 0% share from
 * two samples would read as "this card is fine" when it means "we have not
 * looked long enough". Below this the share is null, which the UI shows as "—".
 */
const THERMAL_MIN_SAMPLES = 20;

/**
 * How long a GPU-count drop is held against the machine.
 *
 * The card count on this cluster is NOT a constant: all machines are physically
 * 8-GPU, and cards that cannot run jobs are deliberately masked off after boot,
 * so the visible count legitimately varies and can change when the operator
 * adjusts the masking.
 *
 * That makes a fixed `expect_gpus` the wrong tool -- it is stale the moment the
 * masking changes, and it fires on the boot-time 8 -> 6 transition, which is
 * intended. So the reference is the machine's own recent high-water mark
 * instead: a drop below what this machine has recently had is worth reporting,
 * and a deliberate masking change stops being reported once the old, higher
 * count ages out of the window.
 *
 * The trade-off, stated plainly: after `GPU_COUNT_MEMORY_MS` a card that died
 * is no longer warned about. It stays in the event log, which is where a
 * permanent record belongs -- a red badge that never clears is the thing people
 * learn to ignore.
 */
const GPU_COUNT_MEMORY_MS = 2 * 3600_000;

/**
 * `expect_gpus` from the config still wins when it is set: that is an explicit
 * statement of intent, and it should not be second-guessed.
 */
export function gpuCountWarning(sample, history, expectGpus) {
  if (!sample || !Array.isArray(sample.gpus) || sample.gpus.length === 0) return null;
  const seen = sample.gpus.length;

  if (typeof expectGpus === 'number' && seen !== expectGpus) {
    return `gpu_count_mismatch:expected_${expectGpus}_saw_${seen}`;
  }
  if (!history || history.length === 0) return null;

  const high = Math.max(...history.map((h) => h.count));
  if (seen < high) return `gpu_count_dropped:from_${high}_to_${seen}`;
  return null;
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
  /**
   * Report a one-off event through the same channel as status transitions.
   *
   * Reusing the path means the event log cannot miss it and the UI is pushed
   * the same way -- a second mechanism would be a second thing to keep working.
   */
  #emitEvent(entry, ts, kind, message) {
    const transition = { hostId: entry.host.id, kind, from: null, to: null, message, ts };
    for (const fn of this.transitionHandlers) {
      try {
        fn(transition, entry);
      } catch {
        // A broken handler must not stop the poller.
      }
    }
  }

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
      // Recent GPU counts, for the drop check above.
      entry.gpuCounts = entry.gpuCounts ?? [];
      const seenCount = (result.sample.gpus ?? []).length;
      if (seenCount > 0) {
        entry.gpuCounts.push({ ts: result.sample.ts, count: seenCount });
        const cutoff = result.sample.ts - GPU_COUNT_MEMORY_MS;
        while (entry.gpuCounts.length > 0 && entry.gpuCounts[0].ts < cutoff) entry.gpuCounts.shift();
        // A change in either direction is a fact worth keeping: "this machine
        // used to show 8 cards and now shows 6" is the question an operator
        // asks, and it belongs in the log rather than in a badge.
        if (entry.lastGpuCount !== undefined && entry.lastGpuCount !== seenCount) {
          this.#emitEvent(
            entry,
            result.sample.ts,
            'gpu_count_changed',
            `显卡数量 ${entry.lastGpuCount} -> ${seenCount}`,
          );
        }
        entry.lastGpuCount = seenCount;
      }

      entry.thermal = entry.thermal ?? new Map();
      for (const gpu of result.sample.gpus ?? []) {
        const mask = gpu.throttleMask;
        if (typeof mask !== 'number') continue;
        const ring = entry.thermal.get(gpu.index) ?? [];
        ring.push((mask & THERMAL_BITS) !== 0 ? 1 : 0);
        if (ring.length > THERMAL_WINDOW) ring.shift();
        entry.thermal.set(gpu.index, ring);
      }
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
            elapsed_s: p.elapsedS ?? null,
            used_mem_mib: p.usedMemMib,
            sm_pct: p.smPct,
          })),
        };
      })
      .sort((a, b) => b.gpu_count - a.gpu_count || b.mem_mib - a.mem_mib);
  }

  #hostView(entry, now) {
    // (see throttleWarnings below)
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
      // Probe-reported warnings plus one derived here: a card that is being
      // throttled is healthy by every metric the probe reports -- it can sit at
      // 100% utilisation and a sane temperature while running at a third of its
      // clock. Without this the machine looks "正常" while delivering a fraction
      // of its performance. (Found exactly that on Server19: 5 of 8 cards in
      // thermal slowdown at 930 MHz against a 3105 MHz maximum.)
      warnings: [
        ...entry.lastWarnings,
        ...throttleWarnings(latest, entry.thermal),
        // Fixed `expect_gpus` still wins when configured; otherwise this compares
        // against the machine's own recent high-water mark.
        ...[gpuCountWarning(latest, entry.gpuCounts, h.expectGpus)].filter(Boolean),
      ],
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
        // Memory-BANDWIDTH utilisation, distinct from mem_pct (which is how full
        // the memory is). High compute + low bandwidth = compute-bound; the
        // reverse means the job is waiting on data movement. Collected since the
        // start but never surfaced until now.
        mem_util_pct: g.memUtil ?? null,
        pcie_gen: g.pcieGen ?? null,
        pcie_width: g.pcieWidth ?? null,
        pcie_gen_max: g.pcieGenMax ?? null,
        pcie_width_max: g.pcieWidthMax ?? null,
        // Stable identity: the index is positional and shifts when cards are
        // masked off, so anything that has to survive a masking change must key
        // on this instead.
        bus_id: g.busId ?? null,
        n_procs: g.nProcs,
        // Health telemetry. `throttled` is the bit a duty operator needs to
        // see; `throttle_reasons` explains it on hover.
        throttle_mask: g.throttleMask ?? null,
        throttle_reasons: decodeThrottle(g.throttleMask, {
          idle: g.nProcs === 0 && (g.util === null || g.util < 5),
        }).reasons,
        // Share of the recent window spent in thermal slowdown. The instant
        // bitmask alone hides this: a card can be power-capped in 99 samples and
        // thermally throttled in the next, and only the last one would show.
        thermal_recent_pct: thermalShare(entry.thermal?.get(g.index)),
        throttled: decodeThrottle(g.throttleMask, {
          idle: g.nProcs === 0 && (g.util === null || g.util < 5),
        }).throttled,
        sm_clock_mhz: g.smClockMhz ?? null,
        sm_clock_max_mhz: g.smClockMaxMhz ?? null,
        power_limit_w: g.powerLimitW ?? null,
        pstate: g.pstate ?? null,
        procs: latest.procs
          .filter((p) => p.gpuIndex === g.index)
          .map((p) => ({
            pid: p.pid,
            username: p.username,
            name: p.name,
            elapsed_s: p.elapsedS ?? null,
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
