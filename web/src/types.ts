/**
 * API types, inferred from the shared runtime schema.
 *
 * The 245 lines of interfaces that used to live here were one of three
 * hand-maintained copies of the same shape and had drifted from the others.
 * `shared/schema.ts` is now the single definition: it produces the types below
 * AND validates the response at runtime, so a field the server renames or
 * mis-cases fails loudly at the boundary instead of rendering as a blank cell.
 *
 * `types.ts` stays as the import path so components keep writing
 * `import type { Host } from '../types'`.
 */

export type {
  EditableHost,
  HistoryPoint,
  MachineHistory,
  AdminConfig,
  GpuProc,
  Gpu,
  HostUser,
  HostUserProc,
  HostCpu,
  HostMem,
  Disk,
  NetMount,
  HostStatus,
  Host,
  GlobalUser,
  Summary,
  Announcement,
  Snapshot,
  UsageRow,
  UsageTotalsRow,
  EventRow,
} from '../../shared/schema';
