/**
 * The API contract, as a runtime schema.
 *
 * This file is the SINGLE source of truth for the shapes the backend returns.
 * Before it existed there were three hand-maintained copies of the same
 * information, and they drifted:
 *
 *   1. `web/src/types.ts`        -- 245 lines of interfaces
 *   2. `render-check.tsx`        -- a CONTRACT table listing every field name
 *                                   (it had `note` twice in `host`)
 *   3. `server/state.js`         -- whatever `buildSnapshot` actually emitted
 *
 * Nothing validated the response at runtime, so a renamed or mis-cased field
 * made components read `undefined` silently -- which is exactly how the disk
 * figures once rendered as "— / —" (the server sent `totalMib` while the type
 * declared `total_mib`). With this schema the frontend parses what it receives
 * and the types are inferred from the same definition, so a mismatch is a
 * loud failure at the boundary instead of a blank cell.
 *
 * Node 24 can import TypeScript directly (type stripping), so the backend and
 * the frontend share this one file with no build step.
 *
 * Nullable means genuinely nullable: a host that has never been polled, or a
 * metric nvidia-smi does not support on that SKU (fan speed on a datacentre
 * card), must stay distinguishable from zero.
 */

import { z } from 'zod';

// --- primitives -------------------------------------------------------------

/** Meters that may legitimately be unavailable. */
const num = z.number().nullable();
const str = z.string().nullable();

// --- GPU --------------------------------------------------------------------

export const GpuProcSchema = z.object({
  pid: z.number(),
  username: str,
  name: str,
  /** seconds this process has been running, from `ps -o etime` */
  elapsed_s: num,
  used_mem_mib: num,
  sm_pct: num,
});

export const GpuSchema = z.object({
  index: z.number(),
  uuid: str,
  /** the exact string nvidia-smi reports; the key for the gpu_names map */
  name: str,
  /** short display name resolved server-side; never render `name` directly */
  display_name: str,
  util: num,
  mem_used_mib: num,
  mem_total_mib: num,
  mem_pct: num,
  temp_c: num,
  power_w: num,
  fan_pct: num,
  /**
   * Memory-BANDWIDTH utilisation, which is not the same as `mem_pct` (how full
   * the memory is). High compute with low bandwidth means the job is
   * compute-bound; the reverse means it is waiting on data movement.
   */
  mem_util_pct: num,
  /**
   * PCIe link the card has currently trained to, and what it supports.
   *
   * `width < width_max` on a BUSY card is a real fault (riser, seating, slot).
   * `gen < gen_max` is not a reliable signal on its own: a link renegotiates its
   * generation down when the card is idle.
   */
  pcie_gen: num,
  pcie_width: num,
  pcie_gen_max: num,
  pcie_width_max: num,
  /**
   * Physical PCI slot, e.g. "37:00.0" -- the STABLE identifier for a card.
   *
   * `index` is positional: masking a card off renumbers the rest, so "#3" can
   * be a different physical card before and after. The slot never moves, and it
   * is what you would use to find the card in the chassis.
   */
  bus_id: str,
  /** nvidia-smi clocks_throttle_reasons bitmask; null when not reported */
  throttle_mask: num,
  /** decoded reason names, e.g. ['热降频'] */
  throttle_reasons: z.array(z.string()),
  /** true only for a performance-costing reason on a card that is not idle */
  throttled: z.boolean(),
  /**
   * Share of the recent ~1h window this card spent in thermal slowdown.
   *
   * The bitmask above is instantaneous; a card near its thermal target
   * alternates between "power cap" and "thermal slowdown" sample to sample, so
   * the newest sample alone hides the thermal events. Null when there is no
   * history yet -- "no data" is not "never throttled".
   */
  thermal_recent_pct: z.number().nullable(),
  sm_clock_mhz: num,
  sm_clock_max_mhz: num,
  power_limit_w: num,
  pstate: str,
  n_procs: z.number(),
  procs: z.array(GpuProcSchema),
});

// --- per-host detail --------------------------------------------------------

export const HostUserProcSchema = z.object({
  pid: z.number(),
  name: str,
  gpu_index: z.number().nullable(),
  elapsed_s: num,
  used_mem_mib: num,
  sm_pct: num,
});

export const HostUserSchema = z.object({
  username: z.string(),
  gpu_count: z.number(),
  gpus: z.array(z.number()),
  mem_mib: z.number(),
  proc_count: z.number(),
  sm_pct_avg: num,
  sm_pct_sum: z.number(),
  procs: z.array(HostUserProcSchema),
});

export const HostCpuSchema = z.object({
  pct: num,
  iowait_pct: num,
  ncpu: num,
  load1: num,
  load5: num,
  load15: num,
  running_procs: num,
  total_procs: num,
});

export const HostMemSchema = z.object({
  total_mib: num,
  used_mib: num,
  avail_mib: num,
  pct: num,
  swap_total_mib: num,
  swap_used_mib: num,
});

export const DiskSchema = z.object({
  /** the directory or mount point this entry describes */
  path: str,
  /** the filesystem that path resolved to (differs for a subdirectory) */
  mount: str,
  /** true when the configured directory does not exist on the host */
  missing: z.boolean(),
  /** ticked in the admin page; only selected entries are displayed */
  selected: z.boolean(),
  total_mib: num,
  used_mib: num,
  avail_mib: num,
  use_pct: num,
});

/**
 * Network mount health. Deliberately carries no size figures: the capacity
 * belongs to the file server, so every machine would report the same numbers.
 */
export const NetMountSchema = z.object({
  path: str,
  /** nfs4, cifs, ...; null when the mount is absent so nothing reported a type */
  fstype: str,
  /**
   * rw      mounted and writable
   * ro      mounted read-only (a state, not necessarily a fault)
   * autofs  automounter armed but not triggered yet
   * stale   mounted but not answering
   * missing not mounted at all
   *
   * Left open rather than an enum: a probe reporting a status this build does
   * not know should still render, not fail validation.
   */
  status: z.string(),
  /** true when this path is listed in the host's net_mounts config */
  expected: z.boolean(),
});

export const HostStatusSchema = z.enum(['ok', 'stale', 'down', 'unknown']);

export const HostSchema = z.object({
  id: z.string(),
  label: z.string(),
  group: str,
  ssh: z.string(),
  expect_gpus: z.number().nullable(),
  note: str,

  status: HostStatusSchema,
  status_since: z.number(),
  age_ms: num,
  last_ok: num,
  last_attempt: num,
  consecutive_failures: z.number(),
  last_error: str,
  poll_duration_ms: num,
  total_polls: z.number(),
  total_failures: z.number(),
  warnings: z.array(z.string()),
  /** true when no sample is held at all, i.e. the host was never polled */
  stale: z.boolean(),

  hostname: str,
  kernel: str,
  driver_version: str,
  uptime_s: num,
  clock_skew_ms: num,
  nvidia_error: str,

  cpu: HostCpuSchema.nullable(),
  mem: HostMemSchema.nullable(),
  /** true when a disk selection has been saved (false = show all discovered) */
  disks_configured: z.boolean(),
  /** every discovered filesystem, each flagged `selected` */
  disks: z.array(DiskSchema),
  /** network mounts, health-checked (never counted as local storage) */
  net_mounts: z.array(NetMountSchema),
  gpus: z.array(GpuSchema),
  users: z.array(HostUserSchema),
});

// --- cluster-wide -----------------------------------------------------------

export const GlobalUserSchema = z.object({
  username: z.string(),
  gpu_count: z.number(),
  mem_mib: z.number(),
  proc_count: z.number(),
  sm_pct_sum: z.number(),
  sm_pct_avg: num,
  hosts: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      gpu_count: z.number(),
      gpus: z.array(z.number()),
    }),
  ),
});

export const SummarySchema = z.object({
  hosts_total: z.number(),
  hosts_ok: z.number(),
  hosts_stale: z.number(),
  hosts_down: z.number(),
  hosts_unknown: z.number(),
  hosts_warning: z.number(),
  gpus_total: z.number(),
  /** cards with at least one process attached; free = total - allocated */
  gpus_allocated: z.number(),
  gpus_mem_used_mib: z.number(),
  gpus_mem_total_mib: z.number(),
  procs_total: z.number(),
  users_active: z.number(),
});

export const AnnouncementSchema = z.object({
  level: z.enum(['info', 'warning', 'error']),
  title: z.string(),
  body: z.string(),
});

export const SnapshotSchema = z.object({
  /** lab / installation name shown in the header; null when unconfigured */
  site: str,
  /** site-wide notice above the dashboard; null when none is configured */
  announcement: AnnouncementSchema.nullable(),
  server_now: z.number(),
  started_at: z.number(),
  last_poll_completed_at: z.number().nullable(),
  config: z.object({
    interval_ms: z.number(),
    stale_after_ms: z.number(),
    down_after_failures: z.number(),
  }),
  summary: SummarySchema,
  hosts: z.array(HostSchema),
  users: z.array(GlobalUserSchema),
  /** present on SSE payloads only */
  reason: z.string().optional(),
});

// --- reports ----------------------------------------------------------------

export const UsageRowSchema = z.object({
  bucket: z.number(),
  username: z.string(),
  host_id: str,
  gpu_seconds: z.number(),
  sm_gpu_seconds: z.number(),
  mem_mib_seconds: z.number(),
  peak_gpus: z.number(),
  peak_mem_mib: z.number(),
  samples: z.number(),
  gpu_hours: z.number(),
  effective_gpu_hours: z.number(),
  mem_gib_hours: z.number(),
});

export const UsageTotalsRowSchema = z.object({
  username: z.string(),
  gpu_seconds: z.number(),
  sm_gpu_seconds: z.number(),
  mem_mib_seconds: z.number(),
  /**
   * The most GPUs this user held AT THE SAME TIME, across every machine.
   *
   * Not the per-machine maximum: a user running 6 GPUs on each of three
   * machines at once peaks at 18, and the per-host rollup can only ever say 6.
   */
  peak_gpus: z.number(),
  first_seen: z.number(),
  last_seen: z.number(),
  gpu_hours: z.number(),
  effective_gpu_hours: z.number(),
  mem_gib_hours: z.number(),
});

export const EventRowSchema = z.object({
  ts: z.number(),
  host_id: z.string(),
  kind: z.string(),
  message: str,
});

// --- admin configuration ----------------------------------------------------

/**
 * What the admin page receives and may edit.
 *
 * `net_mounts` was once added to the config, the collector, the save path and
 * the UI, but not to this payload. The page dereferences the field directly, so
 * the missing key threw "Cannot read properties of undefined (reading
 * 'length')" and blanked the whole view -- after a successful login, which is
 * why nothing caught it earlier. A schema makes an omission here impossible to
 * ship silently: it either validates or it does not.
 *
 * The password is deliberately absent. `has_password` is what the UI needs.
 */
export const EditableHostSchema = z.object({
  id: z.string(),
  label: z.string(),
  ssh: z.string(),
  group: z.string(),
  expect_gpus: z.number().nullable(),
  /** null = never configured (show every discovered disk); [] = show none */
  disks: z.array(z.string()).nullable(),
  net_mounts: z.array(z.string()),
  note: z.string(),
});

export const AdminConfigSchema = z.object({
  /**
   * Fingerprint of the config file when it was loaded.
   *
   * Sent back on save so the server can refuse to overwrite a file that changed
   * in the meantime. Without it a page left open silently reverts whatever
   * another writer did -- a 15-machine config was once replaced by the stale
   * 6-machine copy an open page still held.
   */
  revision: z.string(),
  site: z.string(),
  announcement: AnnouncementSchema,
  poll: z.object({
    interval_ms: z.number(),
    timeout_ms: z.number(),
    stale_after_ms: z.number(),
    down_after_failures: z.number(),
  }),
  naming: z.object({
    strip_domain: z.boolean(),
    capitalize: z.boolean(),
  }),
  admin: z.object({
    has_password: z.boolean(),
    using_sha256: z.boolean(),
    session_hours: z.number(),
  }),
  hosts: z.array(EditableHostSchema),
});

/**
 * One point of a machine's hourly trend.
 *
 * Every field is nullable: a metric the probe could not read, or an hour that
 * predates the column being added, is genuinely absent -- and absent must draw
 * as a gap rather than as zero.
 */
export const HistoryPointSchema = z.object({
  bucket: z.number(),
  gpu_util: num,
  gpu_mem_pct: num,
  temp_c: num,
  power_w: num,
  cpu_pct: num,
  sysmem_pct: num,
  /** memory-BANDWIDTH utilisation, not to be confused with gpu_mem_pct */
  gpu_bw_pct: num,
  /**
   * Share of CARD-TIME spent throttled for a performance-costing reason.
   *
   * Percentage, not a card count: the underlying figure is an average over the
   * hour, and "0.137 cards throttled" is not a quantity anyone can picture.
   * Power capping is excluded -- at full load it is the card behaving as
   * configured.
   */
  throttle_pct: num,
  n_gpus: num,
});

export const MachineHistorySchema = z.object({
  host: z.string(),
  from: z.number(),
  to: z.number(),
  points: z.array(HistoryPointSchema),
});

// --- inferred types ---------------------------------------------------------
// The frontend uses these instead of re-declaring the shapes by hand.

export type GpuProc = z.infer<typeof GpuProcSchema>;
export type Gpu = z.infer<typeof GpuSchema>;
export type HostUser = z.infer<typeof HostUserSchema>;
export type HostCpu = z.infer<typeof HostCpuSchema>;
export type HostMem = z.infer<typeof HostMemSchema>;
export type Disk = z.infer<typeof DiskSchema>;
export type NetMount = z.infer<typeof NetMountSchema>;
export type HostStatus = z.infer<typeof HostStatusSchema>;
export type Host = z.infer<typeof HostSchema>;
export type GlobalUser = z.infer<typeof GlobalUserSchema>;
export type Summary = z.infer<typeof SummarySchema>;
export type Announcement = z.infer<typeof AnnouncementSchema>;
export type Snapshot = z.infer<typeof SnapshotSchema>;
export type UsageRow = z.infer<typeof UsageRowSchema>;
export type UsageTotalsRow = z.infer<typeof UsageTotalsRowSchema>;
export type EventRow = z.infer<typeof EventRowSchema>;
export type HistoryPoint = z.infer<typeof HistoryPointSchema>;
export type MachineHistory = z.infer<typeof MachineHistorySchema>;
export type EditableHost = z.infer<typeof EditableHostSchema>;
export type AdminConfig = z.infer<typeof AdminConfigSchema>;
