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
import { Empty, Select, Segmented, Space, Spin, Typography, theme } from 'antd';
import { MachineHistorySchema } from '../../../shared/schema';
import type { HistoryPoint } from '../types';

/**
 * Trend for one machine, shown inside that machine's expanded detail.
 *
 * ONE chart with two selectors rather than a grid of charts: metric on the left,
 * time range on the right. The separate 历史 page this replaced drew four charts
 * at once, which meant three of them were always in the way -- only utilisation
 * was ever read. Switching is now an explicit act, so the screen stays readable
 * and adding a metric costs nothing visually.
 *
 * Served from the hourly rollup (`host_hourly`), which is never pruned, so every
 * range works -- the raw per-GPU samples only survive 30 days.
 */

type Point = HistoryPoint;

/**
 * The plottable fields, as a union so `p[metric]` stays type-checked.
 *
 * Kept in step with `Point` above and with the columns the API returns: adding a
 * metric here without the server sending it is a type error, not a blank chart.
 */
type MetricKey =
  | 'gpu_util'
  | 'gpu_mem_pct'
  | 'gpu_bw_pct'
  | 'cpu_pct'
  | 'sysmem_pct'
  | 'temp_c'
  | 'power_w'
  | 'throttled_cards';

/**
 * What can be plotted, and how to present it.
 *
 * `max: 100` pins the percentage scales so the shape of a line is comparable
 * between metrics; power and temperature scale to their own range.
 */
interface MetricSpec {
  value: MetricKey;
  label: string;
  unit: string;
  /** fixed upper bound; undefined scales to the data */
  max: number | undefined;
  digits: number;
  hint: string;
}

const METRICS: MetricSpec[] = [
  {
    value: 'gpu_util',
    label: '显卡利用率',
    unit: '%',
    max: 100,
    digits: 1,
    hint: '整机所有显卡的平均 SM 利用率',
  },
  {
    value: 'gpu_mem_pct',
    label: '显存占用',
    unit: '%',
    max: 100,
    digits: 1,
    hint: '整机所有显卡的平均显存占用比例',
  },
  {
    value: 'gpu_bw_pct',
    label: '显存带宽',
    unit: '%',
    max: 100,
    digits: 1,
    hint: '显存带宽利用率,与"显存占用"是两回事。算力高而带宽低=算力受限;反过来=卡在数据搬运上',
  },
  {
    value: 'cpu_pct',
    label: 'CPU 利用率',
    unit: '%',
    max: 100,
    digits: 1,
    hint: '该机器整体 CPU 使用率',
  },
  {
    value: 'sysmem_pct',
    label: '系统内存',
    unit: '%',
    max: 100,
    digits: 1,
    hint: '系统内存占用比例',
  },
  {
    value: 'temp_c',
    label: '温度',
    unit: '°C',
    max: undefined,
    digits: 0,
    hint: '所有卡里最高的一张的温度',
  },
  {
    value: 'power_w',
    label: '整机功耗',
    unit: 'W',
    max: undefined,
    digits: 0,
    hint: '所有卡的功耗之和',
  },
  {
    value: 'throttled_cards',
    label: '降频卡数',
    unit: ' 张',
    max: undefined,
    digits: 2,
    hint: '因热降频或硬件原因而降频的显卡数量。功耗墙不算 —— 满载撞功耗墙是正常表现',
  },
];

const RANGES = [
  { label: '24 小时', value: 24 },
  { label: '3 天', value: 72 },
  { label: '7 天', value: 168 },
  { label: '30 天', value: 720 },
];

const DEFAULT_METRIC: MetricKey = 'gpu_util';
const DEFAULT_RANGE_HOURS = 24;

export function MachineHistory({ hostId }: { hostId: string }) {
  const { token } = theme.useToken();
  const [metric, setMetric] = useState<MetricKey>(DEFAULT_METRIC);
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
        // Validated, not cast: a renamed or re-cased column on the server would
        // otherwise read as undefined and simply draw nothing.
        const parsed = MachineHistorySchema.safeParse(body);
        if (!parsed.success) {
          const first = parsed.error.issues[0];
          setError(`数据格式不符: ${first.path.join('.') || '(根)'} ${first.message}`);
          return;
        }
        setPoints(parsed.data.points);
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

  const spec: MetricSpec = METRICS.find((m) => m.value === metric) ?? METRICS[0];

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
  const partialHistory =
    firstBucket !== null && firstBucket > Date.now() - hours * 3600_000 + 3600_000;

  // A metric with no data in this window (a column added after some history was
  // written) should say so rather than draw an empty grid.
  const hasValues = points.some((p) => p[metric] !== null && p[metric] !== undefined);

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
        {/* Left: what to plot. */}
        <Space size={8} align="center">
          <Select
            size="small"
            value={metric}
            onChange={(v) => setMetric(v as MetricKey)}
            style={{ minWidth: 132 }}
            options={METRICS.map((m) => ({ value: m.value, label: m.label }))}
          />
          {/* The hint is what makes 显存带宽 distinguishable from 显存占用 and
              explains why 功耗墙 is not counted as throttling. It truncates on
              narrow screens rather than wrapping the controls onto two rows. */}
          <Typography.Text
            type="secondary"
            className="metric-hint"
            style={{ fontSize: 11, maxWidth: 340 }}
            ellipsis={{ tooltip: spec.hint }}
          >
            {spec.hint}
          </Typography.Text>
          {loading && <Spin size="small" />}
        </Space>

        {/* Right: over how long. */}
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
      ) : !hasValues ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              这段时间没有「{spec.label}」的记录
            </Typography.Text>
          }
        />
      ) : (
        <>
          <ResponsiveContainer width="100%" height={160}>
            {/* Margins are sized from the LABELS, not guessed:
                  left   0  -- a negative left margin leaves too little room for
                               "100%" (27px), which then overflows the container
                               and has its leading "1" cut off.
                  top   10  -- the top tick is centred on the top gridline, so
                               half a line of text sits above the plot.
                  right 30  -- recharts centre-anchors every x tick including the
                               last, which overhangs the plot edge by half a label
                               (46px / 2 = 23px). */}
            <LineChart data={data} margin={{ top: 10, right: 30, bottom: 0, left: 0 }}>
              <CartesianGrid stroke={token.colorBorderSecondary} vertical={false} />
              <XAxis
                dataKey="label"
                stroke={token.colorBorderSecondary}
                tick={{ fontSize: 10.5, fill: token.colorTextTertiary }}
                minTickGap={40}
              />
              <YAxis
                domain={spec.max === undefined ? [0, 'auto'] : [0, spec.max]}
                unit={spec.unit.trim()}
                stroke={token.colorBorderSecondary}
                tick={{ fontSize: 10.5, fill: token.colorTextTertiary }}
                width={52}
                allowDecimals={spec.digits > 0}
              />
              <Tooltip
                contentStyle={{
                  background: token.colorBgElevated,
                  border: `1px solid ${token.colorBorderSecondary}`,
                  borderRadius: token.borderRadius,
                  fontSize: 12,
                  padding: '6px 10px',
                }}
                formatter={(v) => [`${Number(v).toFixed(spec.digits)}${spec.unit}`, spec.label]}
              />
              <Line
                type="monotone"
                dataKey={metric}
                name={spec.label}
                stroke={token.colorPrimary}
                strokeWidth={1.8}
                dot={false}
                // A gap means no samples for that hour, not 0%.
                connectNulls={false}
                // Re-fetched on range change; animating each time is noise.
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
          <Typography.Text type="secondary" style={{ fontSize: 11 }}>
            按小时汇总。
            {partialHistory && ' 该时段早于本服务开始记录的时间,左侧为空白。'}
            {points.length > 0 && ` 共 ${points.length} 个小时的数据。`}
          </Typography.Text>
        </>
      )}
    </div>
  );
}
