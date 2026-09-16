import { useState } from 'react';
import { Card, Segmented, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';

import { useJson } from '../api';
import type { EventRow, Snapshot, UsageTotalsRow } from '../types';
import { clock, duration, gib } from '../format';
import { useSeverityColors, severity } from '../severity';

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
 */
export function UsageView() {
  const colors = useSeverityColors();
  const [range, setRange] = useState(RANGES[2].value);
  const { data, loading, error } = useJson<{ from: number; to: number; rows: UsageTotalsRow[] }>(
    `/api/usage/totals?from=${encodeURIComponent(range)}`,
  );

  const rows = data?.rows ?? [];
  const totals = rows.reduce(
    (acc, r) => ({
      gpu_hours: acc.gpu_hours + r.gpu_hours,
      effective_gpu_hours: acc.effective_gpu_hours + r.effective_gpu_hours,
      mem_gib_hours: acc.mem_gib_hours + r.mem_gib_hours,
    }),
    { gpu_hours: 0, effective_gpu_hours: 0, mem_gib_hours: 0 },
  );

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
    // "Peak cards" means the most this user held AT THE SAME TIME, across all
    // machines -- read from usage_peak, not from the per-host rollup.
    // A separate machine count was removed: it answered a question nobody
    // asked, and invited reading the peak as if it were per-machine.
    { title: '同时使用峰值', dataIndex: 'peak_gpus', align: 'right', width: 118 },
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
          summary={() => (
            <Table.Summary.Row>
              <Table.Summary.Cell index={0}>
                <Typography.Text strong>合计</Typography.Text>
              </Table.Summary.Cell>
              <Table.Summary.Cell index={1} align="right">
                <Typography.Text strong>{totals.gpu_hours.toFixed(2)}</Typography.Text>
              </Table.Summary.Cell>
              <Table.Summary.Cell index={2} align="right">
                <Typography.Text strong>{totals.effective_gpu_hours.toFixed(2)}</Typography.Text>
              </Table.Summary.Cell>
              <Table.Summary.Cell index={3} align="right">
                <Typography.Text strong>
                  {totals.gpu_hours > 0
                    ? `${Math.round((totals.effective_gpu_hours / totals.gpu_hours) * 100)}%`
                    : '—'}
                </Typography.Text>
              </Table.Summary.Cell>
              <Table.Summary.Cell index={4} align="right">
                <Typography.Text strong>{totals.mem_gib_hours.toFixed(1)}</Typography.Text>
              </Table.Summary.Cell>
              <Table.Summary.Cell index={5} colSpan={4} />
            </Table.Summary.Row>
          )}
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
      render: (v: number | null) =>
        v === null ? '—' : <Typography.Text style={{ color: colors[severity(v)] }}>{v}%</Typography.Text>,
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
              <Table
                size="small"
                rowKey={(p) => `${p.hostId}-${p.pid}`}
                pagination={false}
                dataSource={u.hosts.flatMap((h) => {
                  const host = snapshot.hosts.find((x) => x.id === h.id);
                  const procs = host?.users.find((x) => x.username === u.username)?.procs ?? [];
                  return procs.map((p) => ({ ...p, hostId: h.id, hostLabel: h.label }));
                })}
                columns={[
                  { title: '机器', dataIndex: 'hostLabel', width: 120 },
                  { title: 'GPU', dataIndex: 'gpu_index', width: 80, render: (i: number | null) => (i === null ? '—' : `${i}`) },
                  { title: 'PID', dataIndex: 'pid', width: 110, render: (p: number) => <Typography.Text code style={{ fontSize: 11.5 }}>{p}</Typography.Text> },
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
                    render: (v: number | null) =>
                      v === null ? '—' : <Typography.Text style={{ color: colors[severity(v)] }}>{Math.round(v)}%</Typography.Text>,
                  },
                ]}
              />
            ),
          }}
        />
      )}
    </Card>
  );
}
