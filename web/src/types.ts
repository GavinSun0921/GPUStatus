/**
 * Shapes returned by the GPUStatus API.
 *
 * These mirror `server/state.js` (`buildSnapshot`) and `server/api.js`. Nullable
 * fields are genuinely nullable: a host that has never been polled, or a metric
 * nvidia-smi does not support on that SKU (e.g. fan speed on a datacentre card),
 * must be distinguishable from zero.
 */

export type HostStatus = 'ok' | 'stale' | 'down' | 'unknown';

export interface GpuProc {
  pid: number;
  username: string | null;
  name: string | null;
  used_mem_mib: number | null;
  sm_pct: number | null;
}

export interface Gpu {
  index: number;
  uuid: string | null;
  /** exact string reported by nvidia-smi (key for the gpu_names map) */
  name: string | null;
  /** short display name resolved server-side; never render `name` directly */
  display_name: string | null;
  util: number | null;
  mem_used_mib: number | null;
  mem_total_mib: number | null;
  mem_pct: number | null;
  temp_c: number | null;
  power_w: number | null;
  fan_pct: number | null;
  /** nvidia-smi clocks_throttle_reasons bitmask; null if not reported */
  throttle_mask: number | null;
  /** decoded reason names, e.g. ['热降频'] */
  throttle_reasons: string[];
  /** true only when a performance-costing reason is active on a non-idle card */
  throttled: boolean;
  sm_clock_mhz: number | null;
  sm_clock_max_mhz: number | null;
  power_limit_w: number | null;
  pstate: string | null;
  n_procs: number;
  procs: GpuProc[];
}

export interface HostUser {
  username: string;
  gpu_count: number;
  gpus: number[];
  mem_mib: number;
  proc_count: number;
  sm_pct_avg: number | null;
  sm_pct_sum: number;
  procs: {
    pid: number;
    name: string | null;
    gpu_index: number | null;
    used_mem_mib: number | null;
    sm_pct: number | null;
  }[];
}

export interface HostCpu {
  pct: number | null;
  iowait_pct: number | null;
  ncpu: number | null;
  load1: number | null;
  load5: number | null;
  load15: number | null;
  running_procs: number | null;
  total_procs: number | null;
}

export interface HostMem {
  total_mib: number | null;
  used_mib: number | null;
  avail_mib: number | null;
  pct: number | null;
  swap_total_mib: number | null;
  swap_used_mib: number | null;
}

export interface Disk {
  /** the directory or mount point this entry describes */
  path: string | null;
  /** the filesystem that path resolved to (differs for a subdirectory) */
  mount: string | null;
  /** true when the configured directory does not exist on the host */
  missing: boolean;
  /** ticked in the admin page; only selected entries are displayed */
  selected: boolean;
  total_mib: number | null;
  used_mib: number | null;
  avail_mib: number | null;
  use_pct: number | null;
}

/**
 * Health of a network mount (NFS/CIFS/...).
 *
 * Deliberately carries no size figures: the capacity belongs to the file
 * server, so every machine would report the same numbers.
 */
export interface NetMount {
  path: string | null;
  /** nfs4, cifs, ...; null when the mount is absent so nothing reported a type */
  fstype: string | null;
  /**
   * rw      mounted and writable
   * ro      mounted read-only (a state, not necessarily a fault)
   * autofs  automounter armed but not triggered yet (normal, not a failure)
   * stale   mounted but not answering
   * missing not mounted at all
   */
  status: 'rw' | 'ro' | 'autofs' | 'stale' | 'missing' | string;
  /** true when this path is listed in the host's net_mounts config */
  expected: boolean;
}

export interface Host {
  id: string;
  label: string;
  group: string | null;
  ssh: string;
  expect_gpus: number | null;
  note: string | null;

  status: HostStatus;
  status_since: number;
  age_ms: number | null;
  last_ok: number | null;
  last_attempt: number | null;
  consecutive_failures: number;
  last_error: string | null;
  poll_duration_ms: number | null;
  total_polls: number;
  total_failures: number;
  warnings: string[];
  /** true when `latest` is absent, i.e. the host has never been polled */
  stale: boolean;

  hostname: string | null;
  kernel: string | null;
  driver_version: string | null;
  uptime_s: number | null;
  clock_skew_ms: number | null;
  nvidia_error: string | null;

  cpu: HostCpu | null;
  mem: HostMem | null;
  /** true when a disk selection has been saved (false = show every discovered one) */
  disks_configured: boolean;
  /** every discovered filesystem, each flagged `selected` */
  disks: Disk[];
  /** network mounts, health-checked (never counted as local storage) */
  net_mounts: NetMount[];
  gpus: Gpu[];
  users: HostUser[];
}

export interface GlobalUser {
  username: string;
  gpu_count: number;
  mem_mib: number;
  proc_count: number;
  sm_pct_sum: number;
  sm_pct_avg: number | null;
  hosts: { id: string; label: string; gpu_count: number; gpus: number[] }[];
}

export interface Summary {
  hosts_total: number;
  hosts_ok: number;
  hosts_stale: number;
  hosts_down: number;
  hosts_unknown: number;
  hosts_warning: number;
  gpus_total: number;
  /** cards with at least one process attached; free = total - allocated */
  gpus_allocated: number;
  gpus_mem_used_mib: number;
  gpus_mem_total_mib: number;
  procs_total: number;
  users_active: number;
}

export interface Announcement {
  level: 'info' | 'warning' | 'error';
  title: string;
  body: string;
}

export interface Snapshot {
  /** lab / installation name shown in the header; null when unconfigured */
  site: string | null;
  /** site-wide notice above the dashboard; null when none is configured */
  announcement: Announcement | null;
  server_now: number;
  started_at: number;
  last_poll_completed_at: number | null;
  config: { interval_ms: number; stale_after_ms: number; down_after_failures: number };
  summary: Summary;
  hosts: Host[];
  users: GlobalUser[];
  /** present on SSE payloads only */
  reason?: string;
}

export interface UsageRow {
  bucket: number;
  username: string;
  host_id: string | null;
  gpu_seconds: number;
  sm_gpu_seconds: number;
  mem_mib_seconds: number;
  peak_gpus: number;
  peak_mem_mib: number;
  samples: number;
  gpu_hours: number;
  effective_gpu_hours: number;
  mem_gib_hours: number;
}

export interface UsageTotalsRow {
  username: string;
  gpu_seconds: number;
  sm_gpu_seconds: number;
  mem_mib_seconds: number;
  peak_gpus: number;
  host_count: number;
  first_seen: number;
  last_seen: number;
  gpu_hours: number;
  effective_gpu_hours: number;
  mem_gib_hours: number;
}

export interface EventRow {
  ts: number;
  host_id: string;
  kind: string;
  message: string | null;
}
