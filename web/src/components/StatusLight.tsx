import { theme } from 'antd';
import type { HostStatus } from '../types';
import { statusLabel } from '../format';

/**
 * The machine status indicator.
 *
 * A filled dot with a tinted pill and the state spelled out. It replaced a bare
 * antd `<Badge status>` dot, which was ~6px and carried the state in COLOUR
 * ALONE -- too small to notice at a glance, and unreadable for anyone who cannot
 * distinguish the hues. The status of a machine is the single most important
 * thing on this dashboard, so it gets a control sized accordingly.
 *
 * Colour comes from the active antd theme, and the tint is mixed at render time
 * so it tracks whatever palette is in use rather than being hardcoded.
 */
export function StatusLight({
  status,
  everPolled = true,
}: {
  status: HostStatus;
  /** false until the host has produced at least one sample */
  everPolled?: boolean;
}) {
  const { token } = theme.useToken();

  // A host that has never answered is not showing "stale data" -- there is no
  // data. Saying so avoids implying we once had a reading and lost it.
  const label = !everPolled && status === 'stale' ? '连接失败' : statusLabel(status);

  const tone: Record<HostStatus, { color: string; pulse: boolean }> = {
    ok: { color: token.colorSuccess, pulse: false },
    stale: { color: token.colorWarning, pulse: true },
    down: { color: token.colorError, pulse: true },
    unknown: { color: token.colorTextQuaternary, pulse: false },
  };
  const { color, pulse } = tone[status] ?? tone.unknown;

  return (
    <span
      className={pulse ? 'status-pill status-pill-live' : 'status-pill'}
      title={`机器状态:${label}`}
      style={{
        color,
        background: `color-mix(in srgb, ${color} 15%, transparent)`,
      }}
    >
      <span
        className="status-pill-dot"
        style={{
          background: color,
          boxShadow: `0 0 0 3px color-mix(in srgb, ${color} 25%, transparent)`,
        }}
      />
      {label}
    </span>
  );
}
