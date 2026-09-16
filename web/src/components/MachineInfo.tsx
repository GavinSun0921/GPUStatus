import { Descriptions, Space, Tag, Typography, theme } from 'antd';
import type { Host } from '../types';
import { duration, gib } from '../format';

/**
 * Machine information and collection reliability, shown in the expanded detail.
 *
 * Everything here was already being collected and carried in the API but had
 * nowhere to be seen: `kernel`, `poll_duration_ms`, `total_polls`,
 * `total_failures`, `clock_skew_ms` and the card UUIDs. They answer the
 * questions you only ask when something is already wrong -- which driver and
 * kernel is this machine on, has it been flaky, is its clock drifting, and
 * which physical card do I quote when raising an RMA.
 *
 * PCIe gets special treatment because a link that has trained narrower than the
 * card supports is a fault that every other number on the page hides.
 */
export function MachineInfo({ host }: { host: Host }) {
  const { token } = theme.useToken();

  const successRate =
    host.total_polls > 0
      ? ((host.total_polls - host.total_failures) / host.total_polls) * 100
      : null;

  const degraded = host.gpus.filter(
    (g) =>
      g.pcie_width !== null &&
      g.pcie_width_max !== null &&
      g.pcie_width < g.pcie_width_max &&
      (g.n_procs > 0 || (g.util ?? 0) >= 5),
  );

  const pcieSummary = () => {
    const widths = new Set(
      host.gpus.map((g) => g.pcie_width).filter((w): w is number => w !== null),
    );
    const gens = new Set(host.gpus.map((g) => g.pcie_gen).filter((w): w is number => w !== null));
    if (widths.size === 0) return '—';
    const width = [...widths].sort((a, b) => a - b);
    const gen = [...gens].sort((a, b) => a - b);
    const label =
      width.length === 1 && gen.length === 1
        ? `Gen${gen[0]} ×${width[0]}`
        : `Gen${gen[0]}–${gen[gen.length - 1]} ×${width[0]}–${width[width.length - 1]}`;
    return label;
  };

  const uuidList = host.gpus
    .map((g) => g.uuid)
    .filter((u): u is string => Boolean(u));

  const item = (label: string, value: React.ReactNode) => ({
    key: label,
    label: <span style={{ fontSize: 11.5 }}>{label}</span>,
    children: <span style={{ fontSize: 12 }}>{value}</span>,
  });

  return (
    <div style={{ padding: '4px 16px 12px' }}>
      <Typography.Text type="secondary" style={{ fontSize: 11 }}>
        机器信息与采集可靠性
      </Typography.Text>
      <Descriptions
        size="small"
        column={{ xs: 1, sm: 2, lg: 3 }}
        style={{ marginTop: 6 }}
        items={[
          item('主机名', host.hostname ?? '—'),
          item('SSH 目标', <Typography.Text code style={{ fontSize: 11.5 }}>{host.ssh}</Typography.Text>),
          item('内核', host.kernel ?? '—'),
          item('显卡驱动', host.driver_version ?? '—'),
          item('已运行', duration(host.uptime_s)),
          item(
            'PCIe 链路',
            degraded.length > 0 ? (
              <Space size={4}>
                <span>{pcieSummary()}</span>
                <Tag color="error" style={{ margin: 0, fontSize: 10.5 }}>
                  {degraded.length} 张降速
                </Tag>
              </Space>
            ) : (
              pcieSummary()
            ),
          ),
          item(
            '采集成功',
            successRate === null ? (
              '—'
            ) : (
              <Space size={6}>
                <span>{successRate.toFixed(successRate === 100 ? 0 : 1)}%</span>
                <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                  {host.total_polls - host.total_failures}/{host.total_polls} 次
                </Typography.Text>
              </Space>
            ),
          ),
          item(
            '上次采集耗时',
            host.poll_duration_ms === null ? '—' : `${host.poll_duration_ms} ms`,
          ),
          item(
            '时钟偏差',
            host.clock_skew_ms === null ? (
              '—'
            ) : (
              <span style={{ color: Math.abs(host.clock_skew_ms) > 5000 ? token.colorWarning : undefined }}>
                {host.clock_skew_ms > 0 ? '+' : ''}
                {(host.clock_skew_ms / 1000).toFixed(1)} s
              </span>
            ),
          ),
          item(
            '内存',
            host.mem
              ? `${gib(host.mem.used_mib, 1)} / ${gib(host.mem.total_mib, 0)}`
              : '—',
          ),
          item(
            'Swap',
            host.mem
              ? `${gib(host.mem.swap_used_mib, 1)} / ${gib(host.mem.swap_total_mib, 0)}`
              : '—',
          ),
          item(
            '负载 1/5/15',
            host.cpu && host.cpu.load1 !== null
              ? `${host.cpu.load1.toFixed(0)} / ${host.cpu.load5?.toFixed(0) ?? '—'} / ${host.cpu.load15?.toFixed(0) ?? '—'}`
              : '—',
          ),
          item(
            'IO 等待',
            host.cpu?.iowait_pct === null || host.cpu?.iowait_pct === undefined
              ? '—'
              : `${host.cpu.iowait_pct.toFixed(1)}%`,
          ),
          item('进程数', host.cpu ? `${host.cpu.running_procs ?? '—'} 运行 / ${host.cpu.total_procs ?? '—'} 总` : '—'),
        ]}
      />

      {uuidList.length > 0 && (
        <details style={{ marginTop: 8 }}>
          <summary style={{ cursor: 'pointer', fontSize: 11, color: token.colorTextTertiary }}>
            显卡 UUID({uuidList.length} 张,报修时用)
          </summary>
          <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: '2px 14px' }}>
            {host.gpus.map((g) =>
              g.uuid ? (
                <Typography.Text key={g.uuid} code style={{ fontSize: 11 }}>
                  GPU{g.index}: {g.uuid}
                </Typography.Text>
              ) : null,
            )}
          </div>
        </details>
      )}
    </div>
  );
}
