import { useEffect, useMemo, useState } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Card, Col, Empty, Row, Segmented, Select, Space, Spin, Typography, theme } from 'antd';
import type { Host, Snapshot } from '../types';

/**
 * History for one machine.
 *
 * The dashboard shows the last few seconds; this answers "what has this machine
 * been doing", which is what you ask when a job ran slowly or a card looked odd.
 * Everything plotted here was already being recorded for the usage accounting --
 * this view only makes it visible.
 *
 * Charting uses @ant-design/plots, the companion library to antd, so the charts
 * inherit the same design language and dark theme.
 *
 * The window is capped by the raw-sample retention (`db.raw_retention_hours`);
 * past that only the hourly usage rollups survive, and the empty state says so.
 */

interface Point {
  bucket: number;
  cpu_pct?: number | null;
  mem_pct?: number | null;
  gpu_util?: number | null;
  gpu_mem_pct?: number | null;
  temp_c?: number | null;
  power_w?: number | null;
}

/** One plotted series: which field to read, what to call it, and its colour. */
interface SeriesSpec {
  key: keyof Point;
  name: string;
  color: string;
}

const RANGES = [
  { label: '1 小时', value: 1 },
  { label: '6 小时', value: 6 },
  { label: '24 小时', value: 24 },
  { label: '3 天', value: 72 },
];

const clock = (t: number) => {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/**
 * How much time each plotted point covers.
 *
 * Distinct from the poll interval: the API downsamples to a fixed number of
 * buckets, so a 3-day range aggregates many polls into each point. Calling that
 * "one sample every N seconds" would misstate the collection rate.
 */
function bucketLabel(points: { bucket: number }[]): string {
  if (points.length < 2) return '—';
  const seconds = (points[points.length - 1].bucket - points[0].bucket) / (points.length - 1) / 1000;
  if (seconds < 90) return `${Math.round(seconds)} 秒`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} 分钟`;
  return `${(seconds / 3600).toFixed(1)} 小时`;
}

export function HistoryView({ snapshot }: { snapshot: Snapshot | null }) {
  const { token } = theme.useToken();
  const hosts = snapshot?.hosts ?? [];

  const [hostId, setHostId] = useState<string | null>(null);
  const [hours, setHours] = useState(6);
  const [points, setPoints] = useState<Point[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Default to the first machine rather than showing an empty picker.
  useEffect(() => {
    if (hostId === null && hosts.length > 0) setHostId(hosts[0].id);
  }, [hosts, hostId]);

  useEffect(() => {
    if (!hostId) return;
    let cancelled = false;
    setLoading(true);
    const to = Date.now();
    const from = to - hours * 3600_000;
    fetch(`/api/history/machine?host=${encodeURIComponent(hostId)}&from=${from}&to=${to}&buckets=160`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((body) => {
        if (cancelled) return;
        setPoints(body.points ?? []);
        setError(null);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e.message ?? e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // Re-fetch whenever a poll lands, so the right-hand edge of the chart keeps
    // up with the dashboard without a timer of its own.
  }, [hostId, hours, snapshot?.last_poll_completed_at]);

  const host: Host | undefined = hosts.find((h) => h.id === hostId);

  const data = useMemo(() => points.map((p) => ({ ...p, t: clock(p.bucket) })), [points]);

  const axis = {
    stroke: token.colorBorderSecondary,
    tick: { fontSize: 10.5, fill: token.colorTextTertiary },
  };
  const chart = (
    spec: SeriesSpec[],
    opts: { percent?: boolean; digits?: number; unit?: string; yMax?: number } = {},
  ) => {
    const { percent = false, digits = 0, unit = '', yMax } = opts;
    const suffix = percent ? '%' : ` ${unit}`;
    return (
      <ResponsiveContainer width="100%" height={200}>
        <LineChart data={data} margin={{ top: 6, right: 10, bottom: 0, left: -14 }}>
          <CartesianGrid stroke={token.colorBorderSecondary} vertical={false} />
          <XAxis dataKey="t" {...axis} minTickGap={28} />
          <YAxis domain={yMax === undefined ? [0, 'auto'] : [0, yMax]} unit={unit} {...axis} width={46} />
          <Tooltip
            contentStyle={{
              background: token.colorBgElevated,
              border: `1px solid ${token.colorBorderSecondary}`,
              borderRadius: token.borderRadius,
              fontSize: 12,
              padding: '6px 10px',
            }}
            formatter={(v) => `${Number(v).toFixed(digits)}${suffix}`}
          />
          {spec.map((s) => (
            <Line
              key={s.key}
              type="monotone"
              dataKey={s.key}
              name={s.name}
              stroke={s.color}
              strokeWidth={1.8}
              dot={false}
              // A gap means "no sample"; joining across it would invent data.
              connectNulls={false}
              // The view refetches on every poll; re-animating every 15 seconds
              // is distracting rather than informative.
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    );
  };

  if (hosts.length === 0) return <Empty description="暂无机器" />;

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Card size="small">
        <Space size={16} wrap align="center">
          <Space size={8} align="center">
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              机器
            </Typography.Text>
            <Select
              size="small"
              style={{ minWidth: 160 }}
              value={hostId ?? undefined}
              onChange={setHostId}
              options={hosts.map((h) => ({ value: h.id, label: h.label }))}
            />
          </Space>
          <Space size={8} align="center">
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              时段
            </Typography.Text>
            <Segmented
              size="small"
              value={hours}
              onChange={(v) => setHours(v as number)}
              options={RANGES}
            />
          </Space>
          {loading && <Spin size="small" />}
          {error && <Typography.Text type="danger">{`加载失败: ${error}`}</Typography.Text>}
        </Space>
      </Card>

      {points.length === 0 && !loading ? (
        <Card size="small">
          <Empty
            description={
              <span>
                这段时间没有采样记录。
                <br />
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  原始采样只保留 <code>db.raw_retention_hours</code> 小时(默认 168);
                  更早的数据只剩按小时的用量汇总,见「用量」页。
                </Typography.Text>
              </span>
            }
          />
        </Card>
      ) : (
        <Row gutter={[12, 12]}>
          <Col xs={24} lg={12}>
            <ChartCard title="利用率">
              {chart(
                [
                  { key: 'gpu_util', name: 'GPU 平均利用率', color: token.colorPrimary },
                  { key: 'cpu_pct', name: 'CPU', color: token.colorSuccess },
                ],
                { percent: true, digits: 1, yMax: 100 },
              )}
            </ChartCard>
          </Col>
          <Col xs={24} lg={12}>
            <ChartCard title="占用比例">
              {chart(
                [
                  { key: 'gpu_mem_pct', name: '显存占用', color: token.colorWarning },
                  { key: 'mem_pct', name: '内存', color: token.colorPrimary },
                ],
                { percent: true, digits: 1, yMax: 100 },
              )}
            </ChartCard>
          </Col>
          <Col xs={24} lg={12}>
            <ChartCard title="温度" extra="所有卡中最高的一张">
              {chart([{ key: 'temp_c', name: '最高温度', color: token.colorError }], {
                unit: '°C',
              })}
            </ChartCard>
          </Col>
          <Col xs={24} lg={12}>
            <ChartCard title="功耗" extra="整机合计">
              {chart([{ key: 'power_w', name: '整机功耗', color: token.colorWarning }], {
                unit: 'W',
              })}
            </ChartCard>
          </Col>
        </Row>
      )}

      {points.length > 0 && (
        <Typography.Text type="secondary" style={{ fontSize: 11.5 }}>
          {host ? `${host.label} · ` : ''}
          {points.length} 个点,每个聚合约 {bucketLabel(points)} 的数据(采集本身是{' '}
          {Math.round((snapshot?.config.interval_ms ?? 15000) / 1000)} 秒一次)。
          GPU 数字为所有卡的平均值,温度取最高的一张。
        </Typography.Text>
      )}
    </Space>
  );
}

function ChartCard({
  title,
  extra,
  children,
}: {
  title: string;
  extra?: string;
  children: React.ReactNode;
}) {
  return (
    <Card
      size="small"
      title={title}
      extra={
        extra ? (
          <Typography.Text type="secondary" style={{ fontSize: 11.5 }}>
            {extra}
          </Typography.Text>
        ) : undefined
      }
    >
      {children}
    </Card>
  );
}
