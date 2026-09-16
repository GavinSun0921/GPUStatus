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
import { Empty, Segmented, Space, Spin, Typography, theme } from 'antd';

/**
 * Utilisation trend for one machine, shown inside that machine's expanded
 * detail.
 *
 * Replaced a separate 历史 page: only one of its four charts was ever looked at,
 * and reading a machine's history meant navigating away from the machine list
 * and re-finding it in a dropdown. Here the chart belongs to the card it
 * describes.
 *
 * Served from the hourly rollup (`host_hourly`), which is never pruned, so every
 * range works -- the raw per-GPU samples only survive 7 days, and keeping a
 * month of them would approach a gigabyte.
 */

interface Point {
  bucket: number;
  gpu_util: number | null;
  n_gpus: number | null;
}

const RANGES = [
  { label: '24 小时', value: 24 },
  { label: '3 天', value: 72 },
  { label: '7 天', value: 168 },
  { label: '30 天', value: 720 },
];

const DEFAULT_RANGE_HOURS = 24;

export function MachineHistory({ hostId }: { hostId: string }) {
  const { token } = theme.useToken();
  const [hours, setHours] = useState(DEFAULT_RANGE_HOURS);
  const [points, setPoints] = useState<Point[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const to = Date.now();
    const from = to - hours * 3600_000;
    fetch(`/api/history/machine?host=${encodeURIComponent(hostId)}&from=${from}&to=${to}`)
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
  }, [hostId, hours]);

  const data = useMemo(
    () =>
      points.map((p) => ({
        ...p,
        label: new Date(p.bucket).toLocaleString('zh-CN', {
          month: 'numeric',
          day: 'numeric',
          hour: '2-digit',
        }),
      })),
    [points],
  );

  // Everything recorded so far, so a range that predates collection says so
  // rather than looking like a machine that was idle.
  const firstBucket = points.length > 0 ? points[0].bucket : null;
  const requestedFrom = Date.now() - hours * 3600_000;
  const partialHistory = firstBucket !== null && firstBucket > requestedFrom + 3600_000;

  return (
    <div style={{ padding: '10px 16px 12px', borderTop: `1px solid ${token.colorBorderSecondary}` }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 12,
          flexWrap: 'wrap',
          marginBottom: 8,
        }}
      >
        <Space size={8} align="center">
          <Typography.Text type="secondary" style={{ fontSize: 11 }}>
            显卡利用率趋势
          </Typography.Text>
          {loading && <Spin size="small" />}
        </Space>
        <Segmented
          size="small"
          value={hours}
          onChange={(v) => setHours(v as number)}
          options={RANGES}
        />
      </div>

      {error ? (
        <Typography.Text type="danger" style={{ fontSize: 12 }}>
          {`加载失败: ${error}`}
        </Typography.Text>
      ) : !loading && points.length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              还没有积累到这段时间的数据(按小时汇总,从服务启动开始记录)
            </Typography.Text>
          }
        />
      ) : (
        <>
          <ResponsiveContainer width="100%" height={160}>
            <LineChart data={data} margin={{ top: 6, right: 10, bottom: 0, left: -16 }}>
              <CartesianGrid stroke={token.colorBorderSecondary} vertical={false} />
              <XAxis
                dataKey="label"
                stroke={token.colorBorderSecondary}
                tick={{ fontSize: 10.5, fill: token.colorTextTertiary }}
                minTickGap={40}
              />
              <YAxis
                domain={[0, 100]}
                unit="%"
                stroke={token.colorBorderSecondary}
                tick={{ fontSize: 10.5, fill: token.colorTextTertiary }}
                width={46}
              />
              <Tooltip
                contentStyle={{
                  background: token.colorBgElevated,
                  border: `1px solid ${token.colorBorderSecondary}`,
                  borderRadius: token.borderRadius,
                  fontSize: 12,
                  padding: '6px 10px',
                }}
                formatter={(v) => [`${Number(v).toFixed(1)}%`, '平均利用率']}
              />
              <Line
                type="monotone"
                dataKey="gpu_util"
                name="平均利用率"
                stroke={token.colorPrimary}
                strokeWidth={1.8}
                dot={false}
                // A gap means no samples for that hour, not 0%. The rollup has a
                // row for every hour the poller ran, so gaps only appear where
                // the service was down.
                connectNulls={false}
                // The chart is re-fetched when the range changes; animating every
                // time is noise rather than information.
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
          <Typography.Text type="secondary" style={{ fontSize: 11 }}>
            整机所有显卡的平均利用率,按小时汇总。
            {partialHistory && ' 该时段早于本服务开始记录的时间,左侧为空白。'}
            {points.length > 0 && ` 共 ${points.length} 个小时的数据。`}
          </Typography.Text>
        </>
      )}
    </div>
  );
}
