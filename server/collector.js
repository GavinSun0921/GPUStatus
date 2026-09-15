/**
 * Host collector: runs the remote probe over SSH and normalises the result.
 *
 * Design notes
 * ------------
 *  * ONE ssh invocation per host per cycle. The probe script is piped in on
 *    stdin (`ssh <host> sh -s`) so there is no shell-quoting layer to get wrong
 *    and no file is ever written on the target.
 *  * SSH connection multiplexing (ControlMaster/ControlPersist) means only the
 *    first cycle pays for the TCP+auth handshake; later cycles reuse the socket.
 *    That is what makes a 5s interval on N hosts practical.
 *  * The remote probe reports `gpus` keyed by UUID, `procs` keyed by GPU UUID,
 *    `pmon` keyed by GPU index and `pid_users` keyed by PID. Joining those is
 *    done here, in one place, instead of in shell.
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PROBE_PATH = resolve(HERE, 'remote-probe.sh');

// A monitoring poll should never balloon memory; a wedged host that streams
// garbage gets cut off rather than accumulating.
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const KILL_GRACE_MS = 1500;

/**
 * CPU percentages come from /proc/stat jiffy counters.
 *
 * The probe deliberately does not `sleep` between two reads: the delta between
 * consecutive polls is measured here instead, which costs nothing and yields a
 * true average over the poll interval rather than over a 200ms window.
 */
export function computeCpuPct(prev, cur) {
  if (!prev || !Array.isArray(prev.ticks) || !Array.isArray(cur) || cur.length < 5) {
    return { cpuPct: null, iowaitPct: null };
  }
  const sum = (a) => a[0] + a[1] + a[2] + a[3] + a[4] + a[5] + a[6] + a[7];
  const totalDelta = sum(cur) - sum(prev.ticks);
  // A non-positive total means the counters reset (the host rebooted) or the
  // clock moved; report null rather than a fabricated percentage.
  if (!Number.isFinite(totalDelta) || totalDelta <= 0) return { cpuPct: null, iowaitPct: null };

  const idle = (a) => a[3] + a[4];
  const idleDelta = idle(cur) - idle(prev.ticks);
  const iowaitDelta = cur[4] - prev.ticks[4];

  const clamp = (v) => (Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : null);
  return {
    cpuPct: clamp(((totalDelta - idleDelta) / totalDelta) * 100),
    iowaitPct: clamp((iowaitDelta / totalDelta) * 100),
  };
}

function num(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

/**
 * Quote a value so the remote shell passes it through as ONE argv entry.
 *
 * Disk paths are user-supplied and travel inside the remote command string, so
 * an unquoted path containing a space would be split into several arguments and
 * silently reported as a set of missing directories.
 */
export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * Normalise a raw probe payload into the shape the state layer and database use.
 *
 * `prevCpu` is this host's previous /proc/stat reading, or null on first sight.
 */
export function deriveSample(host, raw, prevCpu, receivedAt = Date.now()) {
  const warnings = [];

  // --- clock skew -----------------------------------------------------------
  // The remote clock is never trusted for storage (a skewed host would corrupt
  // the shared timeline) but the difference is surfaced, because a host with a
  // wrong clock silently breaks TLS and log correlation elsewhere.
  const remoteTsMs = Number(raw.ts) > 0 ? Number(raw.ts) * 1000 : null;
  const clockSkewMs = remoteTsMs === null ? null : receivedAt - remoteTsMs;
  if (clockSkewMs !== null && Math.abs(clockSkewMs) > 60_000) {
    warnings.push(`clock_skew:${Math.round(clockSkewMs / 1000)}s`);
  }

  const probeErrors = Array.isArray(raw.errors) ? raw.errors.filter(Boolean) : [];
  for (const e of probeErrors) warnings.push(`probe:${e}`);
  if (raw.nvidia_error) warnings.push(`nvidia:${raw.nvidia_error}`);

  // --- lookups --------------------------------------------------------------
  const uuidToIndex = new Map();
  for (const g of raw.gpus ?? []) {
    if (g && g.uuid) uuidToIndex.set(g.uuid, num(g.index));
  }

  const pidToUser = new Map();
  for (const u of raw.pid_users ?? []) {
    if (u && u.pid !== null && u.pid !== undefined && u.user) pidToUser.set(u.pid, u.user);
  }

  // pmon is keyed by (gpu index, pid): it is the only per-process utilisation
  // source nvidia-smi exposes.
  const pmonByGpuPid = new Map();
  for (const p of raw.pmon ?? []) {
    if (p && p.gpu_index !== null && p.gpu_index !== undefined && p.pid !== null) {
      pmonByGpuPid.set(`${p.gpu_index}:${p.pid}`, p);
    }
  }

  // --- processes ------------------------------------------------------------
  const procs = [];
  let unresolvedUsers = 0;
  for (const p of raw.procs ?? []) {
    if (!p || p.pid === null || p.pid === undefined) continue;
    const gpuIndex = p.gpu_uuid ? (uuidToIndex.get(p.gpu_uuid) ?? null) : null;
    const pm = gpuIndex === null ? null : pmonByGpuPid.get(`${gpuIndex}:${p.pid}`);

    const username = pidToUser.get(p.pid) ?? null;
    if (!username) unresolvedUsers += 1;

    procs.push({
      gpuIndex,
      gpuUuid: p.gpu_uuid ?? null,
      pid: p.pid,
      username,
      name: p.name ?? null,
      usedMemMib: num(p.used_mem_mib),
      smPct: pm ? num(pm.sm_pct) : null,
      kind: pm?.type ?? null,
    });
  }

  // A process that exits between the two nvidia-smi queries cannot be resolved
  // to an owner; warn instead of silently dropping it from accounting.
  if (unresolvedUsers > 0) warnings.push(`unresolved_process_users:${unresolvedUsers}`);

  // --- GPUs -----------------------------------------------------------------
  const procsPerGpu = new Map();
  for (const p of procs) {
    if (p.gpuIndex === null) continue;
    procsPerGpu.set(p.gpuIndex, (procsPerGpu.get(p.gpuIndex) ?? 0) + 1);
  }

  const gpus = (raw.gpus ?? [])
    .filter((g) => g && g.index !== null && g.index !== undefined)
    .map((g) => ({
      index: num(g.index),
      uuid: g.uuid ?? null,
      name: g.name ?? null,
      util: num(g.util),
      memUsedMib: num(g.mem_used_mib),
      memTotalMib: num(g.mem_total_mib),
      memUtil: num(g.mem_util),
      tempC: num(g.temp_c),
      powerW: num(g.power_w),
      fanPct: num(g.fan_pct),
      nProcs: procsPerGpu.get(num(g.index)) ?? 0,
      // Health telemetry. Kept as raw values here; interpreting the throttle
      // bitmask belongs to State, which is also where the operator-facing
      // wording lives.
      throttleMask: num(g.throttle),
      smClockMhz: num(g.sm_clock_mhz),
      smClockMaxMhz: num(g.sm_clock_max_mhz),
      powerLimitW: num(g.power_limit_w),
      pstate: g.pstate && g.pstate !== 'null' ? String(g.pstate) : null,
    }))
    .sort((a, b) => a.index - b.index);

  if (host.expectGpus !== null && gpus.length !== host.expectGpus) {
    warnings.push(`gpu_count_mismatch:expected_${host.expectGpus}_saw_${gpus.length}`);
  }

  // --- memory ---------------------------------------------------------------
  // `used` is derived from MemAvailable, not MemFree: page cache is reclaimable,
  // so MemFree alone reports a healthy 250GB machine as 99% full.
  const memTotalMib = num(raw.mem?.total_kib) === null ? null : raw.mem.total_kib / 1024;
  const memAvailMib = num(raw.mem?.available_kib) === null ? null : raw.mem.available_kib / 1024;
  const memUsedMib = memTotalMib !== null && memAvailMib !== null ? memTotalMib - memAvailMib : null;
  const swapTotalMib = num(raw.mem?.swap_total_kib) === null ? null : raw.mem.swap_total_kib / 1024;
  const swapFreeMib = num(raw.mem?.swap_free_kib) === null ? null : raw.mem.swap_free_kib / 1024;

  // --- cpu ------------------------------------------------------------------
  const ticks = Array.isArray(raw.cpu?.ticks) ? raw.cpu.ticks.map(Number) : null;
  const { cpuPct, iowaitPct } = computeCpuPct(prevCpu, ticks);

  return {
    ts: receivedAt,
    hostname: raw.hostname ?? null,
    kernel: raw.kernel ?? null,
    arch: raw.arch ?? null,
    uptimeS: num(raw.uptime_s),
    driverVersion: raw.driver_version || null,
    nvidiaError: raw.nvidia_error || null,
    clockSkewMs,
    warnings,
    ticks, // retained so the next cycle can diff against it
    host: {
      cpuPct,
      iowaitPct,
      ncpu: num(raw.cpu?.cores),
      load1: num(raw.cpu?.load1),
      load5: num(raw.cpu?.load5),
      load15: num(raw.cpu?.load15),
      runningProcs: num(raw.cpu?.running),
      totalProcs: num(raw.cpu?.procs),
      memTotalMib,
      memUsedMib,
      memAvailMib,
      memPct: memTotalMib && memUsedMib !== null && memTotalMib > 0
        ? (memUsedMib / memTotalMib) * 100
        : null,
      swapTotalMib,
      swapUsedMib: swapTotalMib !== null && swapFreeMib !== null ? swapTotalMib - swapFreeMib : null,
    },
    gpus,
    procs,
    // Network mounts carry health, never usage.
    netMounts: (raw.net_mounts ?? []).map((m) => ({
      path: m.path ?? null,
      fstype: m.fstype && m.fstype !== '-' ? m.fstype : null,
      status: m.status ?? 'missing',
    })),
    disks: (raw.disks ?? []).map((d) => ({
      // `path` is what the operator configured; `mount` is the filesystem it
      // resolved to. They differ whenever a path sits inside a mount (e.g. a
      // configured /data on the / volume), and they are identical for
      // auto-discovered entries.
      path: d.path ?? d.mount ?? null,
      mount: d.mount ?? null,
      missing: d.missing === true,
      totalMib: num(d.total_kib) === null ? null : d.total_kib / 1024,
      usedMib: num(d.used_kib) === null ? null : d.used_kib / 1024,
      availMib: num(d.avail_kib) === null ? null : d.avail_kib / 1024,
      usePct: num(d.use_pct),
    })),
  };
}

export class Collector {
  constructor(config) {
    this.config = config;
    this.probeScript = readFileSync(PROBE_PATH, 'utf8');
    this.prevCpu = new Map(); // hostId -> { ticks }
    this.stats = { polls: 0, failures: 0, lastDurationMs: 0 };
  }

  /** Read through to the live config so a reload takes effect immediately. */
  get timeoutMs() {
    return this.config.poll.timeoutMs;
  }

  /**
   * Build the ssh argv for a host.
   *
   * ControlPath is derived from a hash of the target rather than using ssh's
   * `%C` token, so the socket path stays short (unix socket paths are limited to
   * ~108 bytes) and does not depend on the ssh version's token support.
   */
  buildSshArgs(host) {
    const { user, controlPersistS, connectTimeoutS, extraOptions } = this.config.ssh;
    const target = user ? `${user}@${host.ssh}` : host.ssh;

    // Configured disk paths become positional arguments to the remote probe.
    // They must be quoted: the remote shell re-splits this string, so a path
    // containing a space would otherwise arrive as several arguments.
    // Each argument is tagged so both lists fit in one command line: `d:` for a
    // directory whose usage to measure, `n:` for a network mount whose health to
    // check. Paths are absolute, so a tag can never be confused with a path.
    const tagged = [
      ...(Array.isArray(host.disks) ? host.disks : []).map((d) => `d:${d}`),
      ...(Array.isArray(host.netMounts) ? host.netMounts : []).map((n) => `n:${n}`),
      // x: mount points the probe should never report (see config.diskExclude).
      ...(this.config.diskExclude ?? []).map((x) => `x:${x}`),
    ];
    const remoteCommand = tagged.length
      ? `sh -s -- ${tagged.map(shellQuote).join(' ')}`
      : 'sh -s';

    const args = [
      '-o', 'BatchMode=yes',            // never prompt: a prompt would hang the poll
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', `ConnectTimeout=${connectTimeoutS}`,
      '-o', 'ServerAliveInterval=5',
      '-o', 'ServerAliveCountMax=2',
    ];

    if (controlPersistS > 0) {
      const digest = createHash('sha1').update(target).digest('hex').slice(0, 16);
      args.push(
        '-o', 'ControlMaster=auto',
        '-o', `ControlPath=/tmp/gpustatus-ssh-${digest}`,
        '-o', `ControlPersist=${controlPersistS}`,
      );
    }

    if (extraOptions.length) args.push(...extraOptions);
    args.push(target, remoteCommand);
    return args;
  }

  /**
   * Run the probe against one host. Never throws: a failure is a result, because
   * an unreachable host is a normal, expected state that the UI must display.
   */
  probeHost(host) {
    const startedAt = Date.now();
    const args = this.buildSshArgs(host);

    return new Promise((resolvePromise) => {
      let child;
      try {
        child = spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (err) {
        resolvePromise({
          ok: false,
          error: `cannot start ssh: ${err.message}`,
          durationMs: 0,
          startedAt,
        });
        return;
      }

      let stdout = '';
      let stderr = '';
      let settled = false;
      let timedOut = false;
      let oversized = false;
      let killTimer = null;

      const cleanup = () => {
        clearTimeout(timeoutTimer);
        if (killTimer) clearTimeout(killTimer);
      };

      const finish = (result) => {
        if (settled) return;
        settled = true;
        cleanup();
        this.stats.polls += 1;
        if (!result.ok) this.stats.failures += 1;
        this.stats.lastDurationMs = Date.now() - startedAt;
        resolvePromise({ ...result, durationMs: Date.now() - startedAt, startedAt });
      };

      const terminate = () => {
        child.kill('SIGTERM');
        // SIGTERM may not interrupt a hung tcp read, so escalate.
        killTimer = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            /* already gone */
          }
        }, KILL_GRACE_MS);
      };

      const timeoutTimer = setTimeout(() => {
        timedOut = true;
        terminate();
      }, this.timeoutMs);

      child.stdout.on('data', (chunk) => {
        if (settled) return;
        stdout += chunk;
        if (stdout.length > MAX_OUTPUT_BYTES) {
          oversized = true;
          terminate();
        }
      });
      child.stderr.on('data', (chunk) => {
        if (settled) return;
        // Keep the tail: ssh prints the useful diagnostic last.
        stderr = (stderr + chunk).slice(-2000);
      });

      // The probe is written to ssh's stdin. If ssh dies first (auth failure)
      // this raises EPIPE, which is expected and must not crash the process.
      child.stdin.on('error', () => {});
      try {
        child.stdin.end(this.probeScript);
      } catch {
        /* handled by the exit path */
      }

      child.on('error', (err) => {
        finish({ ok: false, error: `ssh failed to start: ${err.message}` });
      });

      child.on('close', (code, signal) => {
        if (timedOut) {
          finish({ ok: false, error: `probe timed out after ${this.timeoutMs}ms`, timedOut: true });
          return;
        }
        if (oversized) {
          finish({ ok: false, error: 'probe output exceeded size limit' });
          return;
        }
        if (code !== 0) {
          // Surface ssh's own message: "Permission denied (publickey)",
          // "No route to host", "Connection refused", ...
          const detail = stderr.trim().split('\n').filter(Boolean).slice(-2).join(' | ');
          finish({
            ok: false,
            error: detail
              ? `ssh exit ${code}: ${detail}`
              : `ssh exit ${code}${signal ? ` (signal ${signal})` : ''}`,
          });
          return;
        }

        const text = stdout.trim();
        if (!text) {
          finish({ ok: false, error: 'probe produced no output' });
          return;
        }

        let raw;
        try {
          raw = JSON.parse(text);
        } catch (err) {
          // A malformed payload is a failed poll, never partial data: half-parsed
          // telemetry is worse than none.
          finish({
            ok: false,
            error: `probe returned invalid JSON: ${err.message}`,
            rawHead: text.slice(0, 300),
          });
          return;
        }

        finish({ ok: true, raw });
      });
    });
  }

  /** Probe a host and derive the normalised sample in one step. */
  async collect(host) {
    const result = await this.probeHost(host);
    if (!result.ok) return { ...result, sample: null };

    const prevCpu = this.prevCpu.get(host.id) ?? null;
    let sample;
    try {
      sample = deriveSample(host, result.raw, prevCpu, Date.now());
    } catch (err) {
      return { ok: false, error: `failed to interpret probe data: ${err.message}`, sample: null };
    }

    if (sample.ticks) this.prevCpu.set(host.id, { ticks: sample.ticks });
    return { ...result, sample };
  }
}
