import { useState } from 'react';
import { Card, Segmented, Table, Tag, Tooltip, Typography, theme } from 'antd';
import type { ColumnsType } from 'antd/es/table';

import { useJson } from '../api';
import type { EventRow, HostUserProc, Snapshot, UsageTotalsRow } from '../types';
import { clock, duration, gib } from '../format';
import { activityColor, efficiencyColor, useSeverityColors } from '../severity';

const RANGES = [
  { label: '24 小时', value: '-24h' },
  { label: '7 天', value: '-7d' },
  { label: '30 天', value: '-30d' },
  { label: '90 天', value: '-90d' },
  { label: '一年', value: '-365d' },
];

/**
 * Usage accounting.
 *
 * The three figures sit side by side because they disagree in a useful way: a
 * user holding eight cards for a day at 10% shows a high "occupied" figure and
 * a low "effective" one, which is exactly the conversation a lab needs to have
 * at year end.
 *
 * Refresh is deliberately slow (hourly): these tables are hour-granular
 * accounting, not live ops, and the year-end ranges will only get heavier.
 * Changing the range still loads immediately.
 */
const USAGE_REFRESH_MS = 60 * 60 * 1000;

export function UsageView() {
  const colors = useSeverityColors();
  const { token } = theme.useToken();
  const [range, setRange] = useState(RANGES[2].value);
  const { data, loading, error, reload } = useJson<{ from: number; to: number; rows: UsageTotalsRow[] }>(
    `/api/usage/totals?from=${encodeURIComponent(range)}`,
    { refreshMs: USAGE_REFRESH_MS },
  );

  const rows = data?.rows ?? [];

  const columns: ColumnsType<UsageTotalsRow> = [
    { title: '用户', dataIndex: 'username', render: (u: string) => <Typography.Text strong>{u}</Typography.Text> },
    {
      title: '占用 GPU 时',
      dataIndex: 'gpu_hours',
      align: 'right',
      sorter: (a, b) => a.gpu_hours - b.gpu_hours,
      defaultSortOrder: 'descend',
      render: (v: number) => v.toFixed(2),
    },
    {
      title: '有效 GPU 时',
      dataIndex: 'effective_gpu_hours',
      align: 'right',
      sorter: (a, b) => a.effective_gpu_hours - b.effective_gpu_hours,
      render: (v: number) => v.toFixed(2),
    },
    {
      // The two GPU-hour columns only mean something together, so the ratio is
      // shown directly instead of leaving the reader to divide them.
      title: '有效率',
      key: 'efficiency',
      align: 'right',
      width: 96,
      sorter: (a, b) =>
        (a.gpu_hours > 0 ? a.effective_gpu_hours / a.gpu_hours : 0) -
        (b.gpu_hours > 0 ? b.effective_gpu_hours / b.gpu_hours : 0),
      render: (_v, r) => {
        if (r.gpu_hours <= 0) return '—';
        const ratio = r.effective_gpu_hours / r.gpu_hours;
        return (
          <Typography.Text style={{ color: ratio < 0.5 ? colors.warn : undefined }}>
            {Math.round(ratio * 100)}%
          </Typography.Text>
        );
      },
    },
    {
      title: '显存 GiB·时',
      dataIndex: 'mem_gib_hours',
      align: 'right',
      sorter: (a, b) => a.mem_gib_hours - b.mem_gib_hours,
      render: (v: number) => v.toFixed(1),
    },
    {
      title: '占用成本',
      dataIndex: 'cost_yuan',
      align: 'right',
      width: 120,
      sorter: (a, b) => (a.cost_yuan ?? -1) - (b.cost_yuan ?? -1),
      render: (v: number | null, r) => {
        if (v == null) {
          return (
            <Typography.Text type="warning" style={{ fontSize: 12 }}>
              未定价{r.unpriced_gpu_hours > 0 ? ` ${r.unpriced_gpu_hours.toFixed(1)}h` : ''}
            </Typography.Text>
          );
        }
        return (
          <Typography.Text
            strong
            style={{ fontSize: 15, color: token.colorPrimary, fontVariantNumeric: 'tabular-nums' }}
          >
            ¥{v.toFixed(0)}
            {r.unpriced_gpu_hours > 0 ? (
              <Typography.Text type="warning" style={{ fontSize: 12, fontWeight: 400 }}>
                {' '}
                +{r.unpriced_gpu_hours.toFixed(1)}h 未定价
              </Typography.Text>
            ) : null}
          </Typography.Text>
        );
      },
    },
    {
      title: '首次',
      dataIndex: 'first_seen',
      render: (t: number) => <Typography.Text type="secondary" style={{ fontSize: 12 }}>{clock(t)}</Typography.Text>,
    },
    {
      title: '最近',
      dataIndex: 'last_seen',
      render: (t: number) => <Typography.Text type="secondary" style={{ fontSize: 12 }}>{clock(t)}</Typography.Text>,
    },
  ];

  return (
    <Card
      size="small"
      title="用量统计"
      extra={
        <Segmented
          size="small"
          value={range}
          onChange={(v) => setRange(String(v))}
          options={RANGES}
        />
      }
    >
      {data && (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {clock(data.from)} ~ {clock(data.to)}
          {/* Freshness is data here, not a how-to: without it a quiet table looks broken. */}
          {' · '}
          每小时自动更新
          {loading ? ' (刷新中…)' : ''}
          {' · '}
          <Typography.Link onClick={reload} style={{ fontSize: 12 }}>
            立即刷新
          </Typography.Link>
        </Typography.Text>
      )}
      {error && <Typography.Text type="danger">加载失败:{error}</Typography.Text>}
      {!loading && rows.length === 0 && (
        <Typography.Paragraph type="secondary">
          该区间暂无记录。用量按小时永久汇总;原始采样按 <Typography.Text code>db.raw_retention_hours</Typography.Text> 定期清理。
        </Typography.Paragraph>
      )}
      {rows.length > 0 && (
        <Table<UsageTotalsRow>
          size="small"
          rowKey="username"
          columns={columns}
          dataSource={rows}
          loading={loading}
          pagination={false}
          scroll={{ x: 'max-content' }}
        />
      )}
    </Card>
  );
}

/** Host up/down history. */
export function EventsView() {
  const { data, loading, error } = useJson<{ events: EventRow[] }>('/api/events?limit=200');
  const rows = data?.events ?? [];

  const tone: Record<string, string> = {
    down: 'error',
    storage_error: 'error',
    stale: 'warning',
    recovered: 'success',
  };
  // The stored kinds are English identifiers. Showing them raw made the events
  // table the only untranslated surface in an otherwise Chinese interface.
  const EVENT_LABELS: Record<string, string> = {
    down: '失联',
    stale: '异常',
    recovered: '恢复',
    storage_error: '存储错误',
  };

  const columns: ColumnsType<EventRow> = [
    {
      title: '时间',
      dataIndex: 'ts',
      width: 180,
      render: (t: number) => <Typography.Text type="secondary" style={{ fontSize: 12 }}>{clock(t)}</Typography.Text>,
    },
    {
      title: '机器',
      dataIndex: 'host_id',
      width: 120,
      render: (h: string) => <Typography.Text code>{h}</Typography.Text>,
    },
    {
      title: '类型',
      dataIndex: 'kind',
      width: 120,
      render: (k: string) => <Tag color={tone[k] ?? 'default'}>{EVENT_LABELS[k] ?? k}</Tag>,
    },
    { title: '说明', dataIndex: 'message' },
  ];

  return (
    <Card size="small" title="事件记录">
      {error && <Typography.Text type="danger">加载失败:{error}</Typography.Text>}
      {!loading && rows.length === 0 && !error && (
        <Typography.Text type="secondary">暂无事件。</Typography.Text>
      )}
      <Table<EventRow>
        size="small"
        rowKey={(r) => `${r.ts}-${r.host_id}`}
        columns={columns}
        dataSource={rows}
        loading={loading}
        pagination={{ pageSize: 50, hideOnSinglePage: true }}
      />
    </Card>
  );
}

/** Cross-host view of who is using what, down to individual processes. */
export function UsersView({ snapshot }: { snapshot: Snapshot }) {
  const colors = useSeverityColors();

  const userColumns: ColumnsType<Snapshot['users'][number]> = [
    {
      title: '用户',
      dataIndex: 'username',
      render: (u: string) => <Typography.Text strong>{u}</Typography.Text>,
    },
    { title: '占用 GPU', dataIndex: 'gpu_count', align: 'right', width: 100, sorter: (a, b) => a.gpu_count - b.gpu_count, defaultSortOrder: 'descend' },
    { title: '显存合计', dataIndex: 'mem_mib', align: 'right', width: 110, render: (m: number) => gib(m) },
    {
      title: '平均利用率',
      dataIndex: 'sm_pct_avg',
      align: 'right',
      width: 110,
      sorter: (a, b) => (a.sm_pct_avg ?? 0) - (b.sm_pct_avg ?? 0),
      // Low is the problem here, not high: this column says how well the GPUs
      // this user is HOLDING are being used, and a low figure is wasted shared
      // capacity. It used to go through `severity`, which painted 97% red and
      // 25% green -- exactly backwards.
      render: (v: number | null) =>
        v === null ? (
          '—'
        ) : (
          <Typography.Text style={{ color: efficiencyColor(v, colors) }}>{v}%</Typography.Text>
        ),
    },
    { title: '进程', dataIndex: 'proc_count', align: 'right', width: 80 },
    {
      title: '分布',
      key: 'hosts',
      render: (_v, u) => (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {u.hosts.map((h) => `${h.label}: ${h.gpus.join(',')}`).join('  ·  ')}
        </Typography.Text>
      ),
    },
  ];

  return (
    <Card
      size="small"
      title="当前用户明细"
      extra={
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          已运行 {duration((Date.now() - snapshot.started_at) / 1000)} · 展开行看进程明细
        </Typography.Text>
      }
    >
      {snapshot.users.length === 0 ? (
        <Typography.Text type="secondary">当前没有用户占用 GPU。</Typography.Text>
      ) : (
        <Table
          size="small"
          rowKey="username"
          columns={userColumns}
          dataSource={snapshot.users}
          pagination={false}
          // NO `scroll={{x:'max-content'}}` here. With max-content antd derives
          // column widths from the row content, and an expanded row is a single
          // cell spanning every column -- so expanding one row collapsed all the
          // other columns to zero width and the table lost its header.
          rowClassName="user-row row-clickable"
          expandable={{
            // Same as the GPU table: clicking anywhere on the row toggles the
            // per-process detail, and the icon stays as the affordance that says
            // the row can be opened at all.
            //
            // Not applied to the admin page's host table: its rows contain text
            // inputs, where a click is meant for the field, not the row.
            expandRowByClick: true,
            expandedRowRender: (u) => (
              <UserProcTable
                rows={u.hosts.flatMap((h) => {
                  const host = snapshot.hosts.find((x) => x.id === h.id);
                  const procs = host?.users.find((x) => x.username === u.username)?.procs ?? [];
                  return procs.map((p) => ({ ...p, hostId: h.id, hostLabel: h.label }));
                })}
              />
            ),
          }}
        />
      )}
    </Card>
  );
}

/**
 * One user's processes across every machine they are on.
 *
 * Exported and given a plain `rows` prop rather than being written inline in
 * `expandedRowRender`, so the render check can render it directly: an expanded
 * row does not exist in a collapsed render, and a column added here would
 * otherwise never be covered by a test. Same reason `ProcTable` is exported.
 */
type UserProcRow = HostUserProc & { hostId: string; hostLabel: string };

export function UserProcTable({ rows }: { rows: UserProcRow[] }) {
  const colors = useSeverityColors();

  return (
    <Table
      size="small"
      rowKey={(p) => `${p.hostId}-${p.pid}`}
      pagination={false}
      dataSource={rows}
      columns={[
                  { title: '机器', dataIndex: 'hostLabel', width: 120 },
                  { title: 'GPU', dataIndex: 'gpu_index', width: 80, render: (i: number | null) => (i === null ? '—' : `${i}`) },
                  { title: 'PID', dataIndex: 'pid', width: 110, render: (p: number) => <Typography.Text code style={{ fontSize: 11.5 }}>{p}</Typography.Text> },
                  {
                    // Same reading as the machine table's column of the same
                    // name, and for the same reason: a job that has been holding
                    // a card for days is the usual reason a GPU looks busy while
                    // nobody gets anything out of it. Without it, this table
                    // showed what was running but not for how long, so a stuck
                    // job and a fresh one looked identical.
                    //
                    // Sortable here (unlike on the machine page, where the
                    // handful of rows need no ordering): with one row per
                    // process across every machine, "oldest first" is how you
                    // find the ones worth asking about.
                    title: '已运行',
                    dataIndex: 'elapsed_s',
                    width: 104,
                    align: 'right',
                    sorter: (a, b) => (a.elapsed_s ?? 0) - (b.elapsed_s ?? 0),
                    render: (secs: number | null) =>
                      secs === null ? (
                        <Typography.Text type="secondary">—</Typography.Text>
                      ) : (
                        <Typography.Text style={{ fontSize: 11.5 }}>{duration(secs)}</Typography.Text>
                      ),
                  },
                  {
                    // Cumulative occupancy cost, same reading as the machine
                    // page's process table.
                    title: (
                      <Tooltip title="按进程运行时长估算,不等于账单,同卡多进程不重复计费。正式占用成本见「用量」页。">
                        <span style={{ borderBottom: '1px dotted currentColor', cursor: 'help' }}>
                          累计成本
                        </span>
                      </Tooltip>
                    ),
                    dataIndex: 'cost_yuan',
                    width: 100,
                    align: 'right',
                    sorter: (a: UserProcRow, b: UserProcRow) => (a.cost_yuan ?? -1) - (b.cost_yuan ?? -1),
                    render: (cost: number | null, proc: UserProcRow) =>
                      cost == null ? (
                        proc.elapsed_s == null ? (
                          <Typography.Text type="secondary">—</Typography.Text>
                        ) : (
                          <Typography.Text type="warning" style={{ fontSize: 11.5 }}>
                            未定价
                          </Typography.Text>
                        )
                      ) : (
                        <Typography.Text style={{ fontSize: 11.5 }}>¥{cost.toFixed(2)}</Typography.Text>
                      ),
                  },
                  {
                    title: '进程',
                    dataIndex: 'name',
                    ellipsis: true,
                    render: (n: string | null) => (
                      <Typography.Text type="secondary" style={{ fontSize: 11.5 }}>{n ?? '—'}</Typography.Text>
                    ),
                  },
                  { title: '显存', dataIndex: 'used_mem_mib', align: 'right', width: 100, render: (m: number | null) => gib(m) },
                  {
                    title: 'SM 利用率',
                    dataIndex: 'sm_pct',
                    align: 'right',
                    width: 110,
                    // Neutral, matching the machine page's process table: this
                    // is the same reading, and a process at 95% is doing its job.
                    // The two tables previously disagreed -- the machine page
                    // showed it blue while this one showed the same number red.
                    render: (v: number | null) =>
                      v === null ? (
                        '—'
                      ) : (
                        <Typography.Text style={{ color: activityColor(v, colors) }}>
                          {Math.round(v)}%
                        </Typography.Text>
                      ),
                  },
      ]}
    />
  );
}
