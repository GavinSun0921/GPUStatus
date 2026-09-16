import { DownOutlined, WarningFilled } from '@ant-design/icons';
import { Button, Badge, Card, Col, Progress, Row, Space, Table, Tag, Tooltip, Typography, theme } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useState } from 'react';
import type { Gpu, GpuProc, Host } from '../types';
import { duration, gib, num, pct, warningLabel, ago } from '../format';
import { activityColor, severity, useSeverityColors } from '../severity';
import { StatusLight } from './StatusLight';
import { HostNote } from './Announcement';
import { MachineHistory } from './MachineHistory';
import { MachineInfo } from './MachineInfo';

/**
 * One machine: a header of labelled meters, then a table with ONE ROW PER CARD.
 *
 * The row models the physical device because that is what the columns describe
 * -- utilisation, memory, temperature and power are all card-level figures. The
 * processes are a PROCESS-level fact, so they are shown as an expandable sub
 * table rather than as extra rows or as a "user" column near the front. That
 * makes the awkward cases fall out naturally:
 *
 *   idle card            -> one row, 用户 column shows 空闲, not expandable
 *   one user on a card   -> one row, name in the 用户 column, expandable for PID
 *   three users sharing  -> one row, "alice 等 3 人", expand for each PID
 */
export function Machine({ host, now, site }: { host: Host; now: number; site?: string | null }) {
  const colors = useSeverityColors();
  const { token } = theme.useToken();
  const noteBorder = `1px solid ${token.colorBorderSecondary}`;

  const ageMs = host.last_ok === null ? null : now - host.last_ok;
  const stale = host.status !== 'ok';
  const [showDetail, setShowDetail] = useState(false);

  /**
   * Temperature at which these cards begin to slow down for heat.
   *
   * Empirically derived from this fleet: across 28k samples, the thermal
   * slowdown bit first appears at 80°C and rises steeply above it. It is not a
   * documented per-SKU figure -- nvidia-smi reports the target (85°C here) and
   * T.Limit values as unexplained offsets -- so it is stated as what it is.
   */
  const THERMAL_THROTTLE_C = 80;

  const temps = host.gpus.map((g) => g.temp_c).filter((t): t is number => t !== null);
  const hottest = temps.length ? Math.max(...temps) : -Infinity;
  const hasTemp = temps.length > 0;
  // Cards that were thermally (or hardware) limited at any point in the recent
  // window -- not cards at their power cap, which is normal at full load.
  const thermalRecent = host.gpus.filter(
    (g) => (g.thermal_recent_pct ?? 0) > 0 || g.throttle_reasons.some((r) => r.includes('热')),
  ).length;

  const allocated = host.gpus.filter((g) => g.n_procs > 0).length;
  // A host that has never been polled reports nothing, which is NOT the same as
  // reporting zero. Rendering "0 / 0 占用" and a "显卡 0/8" mismatch badge would
  // assert facts we have no data for.
  const hasData = host.last_ok !== null;

  const columns: ColumnsType<Gpu> = [
    {
      // Index and model are separate columns: cramming the model under the
      // number shrank it to muted 11px footnote text, which is the opposite of
      // what you look at the table for.
      title: '#',
      dataIndex: 'index',
      width: 58,
      // Bare numeral: the column header already says this is the index, so a
      // '#' on every row is decoration. The class is a stable hook for the
      // render check, which cannot string-match a bare digit safely.
      render: (index: number) => (
        <Typography.Text strong className="cell-index">
          {index}
        </Typography.Text>
      ),
    },
    {
      title: '型号',
      dataIndex: 'display_name',
      // Wide enough for the longest name in the fleet plus the throttle marker:
      // "RTX Pro 6000D (84G)" measures 128px and the marker ~27px, against 184px
      // of usable width after cell padding. At the previous 188px the pair
      // overflowed to 172px of content in 172px of space and wrapped to two
      // lines, which is what broke Server19/Server20's rows once they throttled.
      width: 200,
      render: (name: string | null, gpu: Gpu) => (
        <Space size={6} align="center">
          {name ? (
            <Typography.Text className="cell-model" style={{ fontSize: 13 }}>
              {name}
            </Typography.Text>
          ) : (
            <Typography.Text type="secondary">—</Typography.Text>
          )}
          {/* A throttled card reports 100% utilisation at a sane temperature and
              is nonetheless slow. This tag is the only thing on the row that
              says so, so it carries the clock ratio too. */}
          {gpu.throttled && (
            <Tooltip
              title={[
                gpu.throttle_reasons.join(' · ') || '降频',
                gpu.sm_clock_mhz !== null && gpu.sm_clock_max_mhz
                  ? `SM ${Math.round(gpu.sm_clock_mhz)} / ${Math.round(gpu.sm_clock_max_mhz)} MHz`
                  : null,
                gpu.power_limit_w !== null ? `功耗上限 ${Math.round(gpu.power_limit_w)} W` : null,
              ]
                .filter(Boolean)
                .join('\n')}
            >
              {/* Icon only: the words "降频" cost 30px, which was the difference
                  between fitting and wrapping. The reason and the clock ratio
                  are in the tooltip, and the machine header states the count in
                  words. NB: inside JSX *children* a `//` line is literal text,
                  not a comment -- it renders on the page. */}
              <Tag
                className="throttle-tag"
                color="warning"
                style={{ margin: 0, padding: '0 5px', lineHeight: '16px' }}
              >
                <WarningFilled style={{ fontSize: 11 }} />
              </Tag>
            </Tooltip>
          )}
        </Space>
      ),
    },
    {
      // Deliberately presented as a raw instantaneous reading rather than as a
      // verdict: one sample per poll cannot tell an idle card from one that is
      // between compute bursts. Sustained usage belongs on the 用量 page.
      title: (
        <Tooltip title="nvidia-smi 的瞬时采样值,只代表查询那一刻,不能据此判断显卡是否在空转。长期用量请看「用量」页。">
          <span style={{ borderBottom: '1px dotted currentColor', cursor: 'help' }}>利用率</span>
        </Tooltip>
      ),
      dataIndex: 'util',
      width: 150,
      sorter: (a, b) => (a.util ?? 0) - (b.util ?? 0),
      render: (util: number | null) => (
        <Progress
          percent={util ?? 0}
          size="small"
          strokeColor={activityColor(util, colors)}
          format={(p) => (util === null ? '—' : `${Math.round(p ?? 0)}%`)}
        />
      ),
    },
    {
      title: '显存',
      dataIndex: 'mem_pct',
      width: 190,
      sorter: (a, b) => (a.mem_used_mib ?? 0) - (b.mem_used_mib ?? 0),
      render: (_v, gpu) => (
        <Progress
          percent={gpu.mem_pct ?? 0}
          size="small"
          strokeColor={colors[severity(gpu.mem_pct)]}
          format={() => `${gib(gpu.mem_used_mib)} / ${gib(gpu.mem_total_mib, 0)}`}
        />
      ),
    },
    {
      title: '温度',
      dataIndex: 'temp_c',
      width: 82,
      align: 'right',
      sorter: (a, b) => (a.temp_c ?? 0) - (b.temp_c ?? 0),
      render: (temp: number | null) =>
        temp === null ? (
          <Typography.Text type="secondary">—</Typography.Text>
        ) : (
          <Typography.Text style={temp >= 80 ? { color: colors.danger } : undefined}>
            {Math.round(temp)}°C
          </Typography.Text>
        ),
    },
    {
      title: '功耗',
      dataIndex: 'power_w',
      width: 82,
      align: 'right',
      render: (power: number | null) =>
        power === null ? (
          <Typography.Text type="secondary">—</Typography.Text>
        ) : (
          `${Math.round(power)}W`
        ),
    },
    {
      title: '用户 / 进程',
      key: 'users',
      render: (_v, gpu) => <ProcSummary gpu={gpu} />,
    },
  ];

  return (
    <Card
      id={`host-${host.id}`}
      size="small"
      title={
        <Space size={8} wrap>
          <StatusLight status={host.status} everPolled={hasData} />
          <Typography.Text strong style={{ fontSize: 15 }}>
            {host.label}
          </Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 11.5, fontWeight: 400 }}>
            {host.hostname ?? host.ssh}
          </Typography.Text>
          {/* Only shown when it actually distinguishes this host from the
              installation as a whole: the lab name belongs in the header once,
              not repeated on every card. */}
          {host.group && host.group !== site && <Tag>{host.group}</Tag>}
          {hasData && host.expect_gpus !== null && host.gpus.length !== host.expect_gpus && (
            <Tag color="error">
              显卡 {host.gpus.length}/{host.expect_gpus}
            </Tag>
          )}
        </Space>
      }
      extra={
        <Space size={10} align="center">
          <Typography.Text type="secondary" style={{ fontSize: 11.5 }}>
            驱动 {host.driver_version ?? '—'} · 运行 {duration(host.uptime_s)}
            {stale && host.last_ok !== null && ` · 数据 ${ago(ageMs)}`}
          </Typography.Text>
          {/* Collapsed by default: the machine list is for scanning status, and
              a trend chart on every card would bury that. */}
          <Button
            type="text"
            size="small"
            className="detail-toggle"
            onClick={() => setShowDetail((v) => !v)}
            style={{ fontSize: 12 }}
          >
            {showDetail ? '收起' : '详情'}
            <DownOutlined
              style={{
                fontSize: 10,
                marginLeft: 4,
                transition: 'transform .2s',
                transform: showDetail ? 'rotate(180deg)' : undefined,
              }}
            />
          </Button>
        </Space>
      }
      styles={{ body: { padding: 0 } }}
    >
      {stale && (
        <div style={{ padding: '7px 16px', borderBottom: noteBorder }}>
          <Typography.Text
            type={host.status === 'down' ? 'danger' : 'warning'}
            style={{ fontSize: 12.5 }}
          >
            {host.last_ok === null ? (
              <>
                尚未采集到数据
                {host.consecutive_failures > 0 &&
                  ` — 已失败 ${host.consecutive_failures} 次${host.last_error ? `:${host.last_error}` : ''}`}
              </>
            ) : host.status === 'down' ? (
              <>
                机器失联 — 连续 {host.consecutive_failures} 次采集失败
                {host.last_error ? `:${host.last_error}` : ''}。下表是 {ago(ageMs)}的最后一次数据。
              </>
            ) : (
              <>
                数据陈旧 — 最后一次成功采集在 {ago(ageMs)}
                {host.last_error ? `,最近一次失败:${host.last_error}` : ''}。
              </>
            )}
          </Typography.Text>
        </div>
      )}

      {host.warnings.length > 0 && (
        <div style={{ padding: '7px 16px', borderBottom: noteBorder }}>
          <Typography.Text type="warning" style={{ fontSize: 12.5 }}>
            {host.warnings.map(warningLabel).join(' · ')}
          </Typography.Text>
        </div>
      )}

      {/* Per-machine notice, set in the admin page. Rendered below the health
          warnings so an operational problem is never pushed out of sight by an
          informational note. */}
      {host.note && <HostNote note={host.note} tone={noteBorder} />}

      {/* Directly under the header, above the meters and the card table: the
          point of the toggle is to SEE the trend, and at the bottom of the card
          clicking 详情 looked like it had done nothing until you scrolled past
          eight GPU rows and the disk panel. */}
      {showDetail && (
        <>
          <MachineHistory hostId={host.id} />
          <MachineInfo host={host} />
        </>
      )}

      <div style={{ padding: '12px 16px 4px' }}>
        <Row gutter={[28, 12]}>
          <Col xs={24} sm={12} md={6}>
            <Stat
              label="CPU"
              value={pct(host.cpu?.pct, 1)}
              percent={host.cpu?.pct}
              // One load figure inline; the full 1/5/15-minute triplet is in
              // the tooltip. Printing all three made the line dense and, on a
              // steady machine, showed essentially the same number three times.
              sub={hasData ? `${host.cpu?.ncpu ?? '—'} 核 · 负载 ${num(host.cpu?.load1, 1)}` : '—'}
              subTitle={`1/5/15 分钟平均负载:${num(host.cpu?.load1, 2)} / ${num(host.cpu?.load5, 2)} / ${num(host.cpu?.load15, 2)}`}
            />
          </Col>
          <Col xs={24} sm={12} md={6}>
            <Stat
              label="内存"
              value={`${gib(host.mem?.used_mib)} / ${gib(host.mem?.total_mib, 0)}`}
              percent={host.mem?.pct}
              // "可用" is deliberately NOT printed: used is derived as
              // total - available, so it would only restate the line above.
              // Swap, when in use, is genuinely separate information.
              sub={
                !hasData
                  ? '—'
                  : host.mem?.swap_total_mib && (host.mem.swap_used_mib ?? 0) > 0
                    ? `swap 已用 ${gib(host.mem.swap_used_mib)} / ${gib(host.mem.swap_total_mib, 0)}`
                    : `${host.cpu?.total_procs ?? '—'} 个系统进程`
              }
            />
          </Col>
          <Col xs={24} sm={12} md={6}>
            <Stat
              label="显卡"
              value={hasData ? `${allocated} / ${host.gpus.length} 占用` : '—'}
              percent={host.gpus.length ? (allocated / host.gpus.length) * 100 : null}
              // Occupancy is NOT a health gradient: a fully allocated machine
              // is the normal, desirable state. Feeding it through severity()
              // painted a full RED bar on every busy machine, which read as an
              // alarm. Only utilisation and disk pressure use that ramp.
              color={colors.accent}
              // Repeating "all occupied" under "8 / 8 占用" added nothing, so
              // this line now carries facts the headline cannot: how many people
              // are on the machine, and how many cards are untouched.
              sub={
                !hasData
                  ? '—'
                  : [
                      host.users.length > 0 ? `${host.users.length} 人在用` : null,
                      host.gpus.length - allocated > 0
                        ? `${host.gpus.length - allocated} 张无进程`
                        : null,
                    ]
                      .filter(Boolean)
                      .join(' · ') || '无人占用'
              }
            />
          </Col>
          <Col xs={24} sm={12} md={6}>
            <Stat
              label="散热"
              value={hasTemp ? `${Math.round(hottest)}°C` : '—'}
              // The bar is the distance to the throttle point, not a percentage
              // of some arbitrary maximum: 100% means "about to slow down".
              percent={hasTemp ? Math.min((hottest / THERMAL_THROTTLE_C) * 100, 100) : null}
              // Colour comes from FACTS, not from a made-up ramp: red only when a
              // card is actually being throttled for heat, amber once the
              // temperature reaches the point where that starts. Feeding °C
              // through severity() would paint a perfectly healthy 56°C card
              // amber.
              color={
                !hasTemp
                  ? undefined
                  : thermalRecent > 0
                    ? colors.danger
                    : hottest >= THERMAL_THROTTLE_C
                      ? colors.warn
                      : colors.accent
              }
              sub={
                !hasTemp
                  ? '—'
                  : thermalRecent > 0
                    ? `${thermalRecent} 张卡近期热降频`
                    : hottest >= THERMAL_THROTTLE_C
                      ? `已达降频温度 ${THERMAL_THROTTLE_C}°C`
                      : `距降频 ${Math.round(THERMAL_THROTTLE_C - hottest)}°C`
              }
              subTitle={`所有卡里最高的一张。${THERMAL_THROTTLE_C}°C 是实测的降频起点(见 README:全机群 2.8 万个样本中,热降频最早出现在 80°C)。`}
            />
          </Col>
        </Row>
      </div>

      <Table<Gpu>
        size="small"
        rowKey="index"
        columns={columns}
        dataSource={host.gpus}
        pagination={false}
        className={stale ? 'dimmed' : undefined}
        // Stable per-row hook so the render check can count GPU rows exactly,
        // independent of antd's own class names.
        //
        // The second class marks the rows that respond to a click, so the cursor
        // advertises it. It is deliberately NOT named `gpu-row-...`: the render
        // check counts rows by counting occurrences of the string "gpu-row", and
        // a superstring would be counted twice (which it was, reporting 95 rows
        // for 48 cards).
        rowClassName={(gpu) => (gpu.procs.length > 0 ? 'gpu-row row-clickable' : 'gpu-row')}
        expandable={{
          // Only cards with processes have anything to expand.
          rowExpandable: (gpu) => gpu.procs.length > 0,
          expandedRowRender: (gpu) => (
            <>
              <CardTelemetry gpu={gpu} />
              <ProcTable gpu={gpu} />
            </>
          ),
          // Clicking anywhere on the row toggles it, not just the icon. The
          // icon stays: it is what tells you the row CAN be expanded, and it
          // has to remain clickable for that to be discoverable.
          expandRowByClick: true,
        }}
        locale={{ emptyText: '未检测到显卡' }}
      />

      <DiskPanel host={host} />
      <NetMountPanel host={host} />
    </Card>
  );
}

/**
 * Drop the leading slash from a path for display: "/home" -> "home".
 *
 * The root mount is the one case that must NOT be stripped -- "/" would become
 * an empty label, which reads as a rendering bug rather than as a mount point.
 */
function shortPath(path: string): string {
  const trimmed = path.replace(/^\/+/, '');
  return trimmed === '' ? '/' : trimmed;
}

/**
 * The bordered tile used for every disk entry.
 *
 * Kept as a hook so the panel below stays declarative and the four properties
 * that define "a tile" live in one place.
 */
function useTileStyle(): React.CSSProperties {
  const { token } = theme.useToken();
  return {
    height: '100%',
    border: `1px solid ${token.colorBorderSecondary}`,
    borderRadius: token.borderRadius,
    padding: '6px 10px 8px',
    background: token.colorFillQuaternary,
  };
}

/** Disk usage for the directories ticked for this host in the admin page. */
function DiskPanel({ host }: { host: Host }) {
  const colors = useSeverityColors();
  const { token } = theme.useToken();
  const box = useTileStyle();

  // The host reports every discovered filesystem so the admin page can offer
  // them all; the overview shows only what was ticked.
  const shown = host.disks.filter((d) => d.selected);
  if (shown.length === 0) return null;

  const hidden = host.disks.length - shown.length;

  return (
    <div
      style={{ padding: '10px 16px 12px', borderTop: `1px solid ${token.colorBorderSecondary}` }}
    >
      {/* The standing explanation lives in the tooltip: it is guidance, not
          data, and repeating it on every card is noise. Only the case where
          something is actually hidden is worth stating on screen. */}
      <Typography.Text
        type="secondary"
        style={{ fontSize: 11 }}
        title="在管理页勾选要统计的目录;未配置时显示全部自动发现的挂载点"
      >
        磁盘{host.disks_configured && hidden > 0 ? `(另有 ${hidden} 项未选)` : ''}
      </Typography.Text>
      <Row gutter={[10, 10]} style={{ marginTop: 6 }}>
        {shown.map((disk, i) => {
          const label = disk.path ?? disk.mount ?? `disk-${i}`;
          // A configured path sitting inside a mount (e.g. /tmp on the / volume)
          // would otherwise look like a duplicate of that mount.
          const showMount = disk.mount !== null && disk.mount !== disk.path;

          if (disk.missing) {
            return (
              <Col xs={24} sm={12} md={8} lg={6} key={label}>
                <div className="disk-tile" style={box}>
                  <Typography.Text style={{ fontSize: 12.5 }}>{shortPath(label)}</Typography.Text>
                  <div>
                    <Typography.Text type="warning" style={{ fontSize: 11.5 }}>
                      目录不存在
                    </Typography.Text>
                  </div>
                </div>
              </Col>
            );
          }

          const color = colors[severity(disk.use_pct)];
          return (
            <Col xs={24} sm={12} md={8} lg={6} key={label}>
              <div className="disk-tile" style={box}>
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'baseline',
                    gap: 8,
                  }}
                >
                  {/* Plain text rather than a code chip: the grey monospace
                      box dominated the tile and made a column of them look
                      heavy. The full path stays in the tooltip. */}
                  <Typography.Text
                    style={{ fontSize: 12.5 }}
                    ellipsis
                    title={showMount ? `挂载点 ${disk.mount}` : disk.path ?? undefined}
                  >
                    {shortPath(label)}
                    {showMount && (
                      <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                        {' '}
                        → {shortPath(disk.mount ?? '')}
                      </Typography.Text>
                    )}
                  </Typography.Text>
                  <Typography.Text style={{ fontSize: 12, color, whiteSpace: 'nowrap' }}>
                    {gib(disk.avail_mib)} 可用
                  </Typography.Text>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 2 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <Progress
                      percent={disk.use_pct ?? 0}
                      size="small"
                      showInfo={false}
                      strokeColor={color}
                    />
                  </div>
                  <Typography.Text type="secondary" style={{ fontSize: 11.5, whiteSpace: 'nowrap' }}>
                    {gib(disk.used_mib, 0)} / {gib(disk.total_mib, 0)}
                  </Typography.Text>
                </div>
              </div>
            </Col>
          );
        })}
      </Row>
    </div>
  );
}

/**
 * Network mounts (NFS/CIFS/...) for this machine: health only.
 *
 * This section has its own shape on purpose, because its situation is fixed:
 * every machine mounts the same two or three site-wide NFS directories, and all
 * that matters is whether they are actually there.
 *
 * So it is ONE full-width strip: the label and every mount share a single line.
 * Two attempts before this one failed for a reason worth recording:
 *
 *   - copy of the disk tiles -> wrong: disks are a variable-length list of
 *     per-machine volumes and deserve a grid; mounts are a fixed short list.
 *   - label on its own line, mounts below -> the two mounts covered half the
 *     card and the other half was empty, which looked broken.
 *
 * A strip spanning the full width has no empty half, costs one line of height,
 * and looks like nothing else on the page.
 */
function NetMountPanel({ host }: { host: Host }) {
  const { token } = theme.useToken();
  if (host.net_mounts.length === 0) return null;

  // Anything not actually mounted is 异常, whatever the reason. The probe still
  // distinguishes autofs / missing / stale (useful diagnostics, shown in the
  // tooltip), but the colour is decided by whether the mount is really there:
  // it is listed in net_mounts precisely because it is EXPECTED to be there.
  const tone: Record<string, { color: string; label: string; bad: boolean; hint: string }> = {
    rw: { color: token.colorSuccess, label: '已挂载', bad: false, hint: '已挂载且可读写' },
    // Read-only is a state, not necessarily a fault -- a shared dataset may be
    // deliberately mounted ro.
    ro: { color: token.colorWarning, label: '只读', bad: false, hint: '已挂载但为只读' },
    autofs: {
      color: token.colorError,
      label: '未挂载',
      bad: true,
      hint: '只有自动挂载器条目,尚未真正挂载(通常在首次访问时才会挂载)',
    },
    stale: { color: token.colorError, label: '无响应', bad: true, hint: '已挂载但无响应' },
    missing: { color: token.colorError, label: '未挂载', bad: true, hint: '这台机器上完全没有挂载' },
  };
  const problems = host.net_mounts.filter((m) => tone[m.status]?.bad).length;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: '2px 22px',
        padding: '7px 16px 9px',
        borderTop: `1px solid ${token.colorBorderSecondary}`,
        background: token.colorFillQuaternary,
      }}
    >
      <Typography.Text
        type="secondary"
        style={{ fontSize: 11 }}
        title="仅检查是否健康挂载。容量属于文件服务器,不按机器统计"
      >
        网络挂载
      </Typography.Text>

      {host.net_mounts.map((m) => {
        const state = tone[m.status] ?? {
          color: token.colorError,
          label: '异常',
          bad: true,
          hint: m.status,
        };
        const full = m.path ?? '(未知路径)';
        // Just the directory name; the full path is in the tooltip.
        const name = full.replace(/\/+$/, '').split('/').filter(Boolean).pop() ?? full;

        return (
          <span
            key={full}
            className="net-tile"
            title={[`${full}${m.fstype ? ` (${m.fstype})` : ''}`, state.hint].join(' — ')}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
          >
            <Badge color={state.color} />
            <Typography.Text strong style={{ fontSize: 12 }}>
              {name}
            </Typography.Text>
            <Typography.Text style={{ fontSize: 12, color: state.color }}>
              {state.label}
            </Typography.Text>
          </span>
        );
      })}

      {problems > 0 && (
        <Typography.Text type="danger" style={{ fontSize: 11, marginLeft: 'auto' }}>
          {problems} 项异常
        </Typography.Text>
      )}
    </div>
  );
}

/**
 * Colour a throttle reason by whether anyone can act on it.
 *
 * A power cap at full utilisation is the card doing exactly what it is
 * configured to do -- every one of Server14's eight cards sits there whenever it
 * is busy. Painting that red trains people to ignore the colour. Thermal and
 * hardware reasons are the ones worth a red mark.
 */
function throttleTone(gpu: Gpu, token: ReturnType<typeof theme.useToken>['token']) {
  if (gpu.throttle_reasons.length === 0) return undefined;
  const serious = gpu.throttle_reasons.some((r) => r !== '功耗墙' && r !== '空闲');
  if (serious) return token.colorError;
  return gpu.throttle_reasons.includes('功耗墙') ? token.colorWarning : token.colorTextTertiary;
}

/**
 * The full telemetry for one card, shown when its row is expanded.
 *
 * These are per-card values that do not fit as table columns without squeezing
 * the process list, and they are only interesting once you have already decided
 * to look at this card.
 */
export function CardTelemetry({ gpu }: { gpu: Gpu }) {
  const { token } = theme.useToken();

  const cell = (label: string, value: React.ReactNode, hint?: string) => (
    <div key={label} title={hint} style={{ minWidth: 96 }}>
      <div style={{ fontSize: 10.5, color: token.colorTextTertiary }}>{label}</div>
      <div style={{ fontSize: 12 }}>{value}</div>
    </div>
  );

  const pcieDegraded =
    gpu.pcie_width !== null &&
    gpu.pcie_width_max !== null &&
    gpu.pcie_width < gpu.pcie_width_max &&
    (gpu.n_procs > 0 || (gpu.util ?? 0) >= 5);

  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: '10px 26px',
        padding: '10px 12px',
        marginBottom: 8,
        borderRadius: token.borderRadius,
        background: token.colorFillQuaternary,
      }}
    >
      {cell(
        'SM 时钟',
        gpu.sm_clock_mhz === null
          ? '—'
          : `${Math.round(gpu.sm_clock_mhz)} / ${Math.round(gpu.sm_clock_max_mhz ?? 0)} MHz`,
        '当前 SM 时钟 / 该卡最高 SM 时钟。远低于最高值说明在降频。',
      )}
      {cell(
        '显存带宽',
        gpu.mem_util_pct === null ? '—' : `${Math.round(gpu.mem_util_pct)}%`,
        '显存带宽利用率,与"显存占用"不是一回事。算力高而带宽低=算力受限;反过来=卡在数据搬运上。',
      )}
      {cell(
        '风扇',
        gpu.fan_pct === null ? '—' : `${Math.round(gpu.fan_pct)}%`,
        '风扇转速。温度高而转速不满,可能是散热或风扇故障。',
      )}
      {cell('P-State', gpu.pstate ?? '—', 'P0=满性能,P2/P8=节能状态')}
      {cell(
        '功耗',
        gpu.power_w === null || gpu.power_limit_w === null ? (
          '—'
        ) : (
          // Shown against the limit, because "212 W" means nothing without it:
          // 212 of 285 is a card with headroom, 212 of 220 is a card pinned at
          // its cap.
          <span
            style={{
              color:
                gpu.power_w / gpu.power_limit_w >= 0.98 ? token.colorWarning : undefined,
            }}
          >
            {Math.round(gpu.power_w)} / {Math.round(gpu.power_limit_w)} W
            <Typography.Text type="secondary" style={{ fontSize: 11 }}>
              {' '}
              {Math.round((gpu.power_w / gpu.power_limit_w) * 100)}%
            </Typography.Text>
          </span>
        ),
        '当前功耗 / 该卡功耗上限。接近 100% 说明卡在功耗墙上,再快也快不了。',
      )}
      {cell(
        'PCIe',
        gpu.pcie_gen === null || gpu.pcie_width === null ? (
          '—'
        ) : (
          <span style={{ color: pcieDegraded ? token.colorError : undefined }}>
            Gen{gpu.pcie_gen} ×{gpu.pcie_width}
            {gpu.pcie_width_max !== null && gpu.pcie_width < gpu.pcie_width_max && (
              <span style={{ color: token.colorTextTertiary }}>
                {' '}
                (最高 ×{gpu.pcie_width_max})
              </span>
            )}
          </span>
        ),
        'PCIe 链路。繁忙时宽度低于该卡上限,说明链路降速 —— 其它指标都正常,但卡会变慢。',
      )}
      {cell(
        '降频原因',
        gpu.throttle_reasons.length === 0 ? (
          '无'
        ) : (
          <span style={{ color: throttleTone(gpu, token) }}>{gpu.throttle_reasons.join(' · ')}</span>
        ),
        '热降频是散热问题,需要处理;功耗墙是满载时的正常表现。',
      )}
      {cell(
        '近 1 小时热降频',
        gpu.thermal_recent_pct === null ? (
          '—'
        ) : gpu.thermal_recent_pct === 0 ? (
          '无'
        ) : (
          <span style={{ color: token.colorError }}>{gpu.thermal_recent_pct}% 的采样</span>
        ),
        // The reason above is the INSTANTANEOUS bit, and a card near its thermal
        // target alternates between power cap and thermal slowdown from one
        // sample to the next. Server19 sits at 87°C reporting "功耗墙" while
        // roughly 1% of its samples were thermally throttled -- invisible
        // without this figure.
        '最近约 1 小时的采样里,有多少比例处于热降频。瞬时原因会掩盖它。',
      )}
    </div>
  );
}

/** Compact "who is on this card" summary: user next to PID, as requested. */
function ProcSummary({ gpu }: { gpu: Gpu }) {
  if (gpu.procs.length === 0) {
    return <Typography.Text type="secondary">空闲</Typography.Text>;
  }

  // EVERY process gets a chip. The previous version showed only the first and
  // collapsed the rest into "共 N 个进程", so on a card shared by two people the
  // second person's name never appeared anywhere in the table -- which is
  // precisely the question the table exists to answer.
  //
  // Chips wrap, so a card with several users grows downwards instead of
  // truncating. `user@pid` keeps the owner and the process on one line, and the
  // tooltip carries the detail (utilisation, memory, command) for anyone who
  // needs more than a glance.
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
      {gpu.procs.map((proc) => (
        <Tag
          key={proc.pid}
          style={{ margin: 0, fontSize: 11.5 }}
          title={[
            proc.username ?? '未知用户',
            `PID ${proc.pid}`,
            proc.sm_pct === null ? null : `SM ${Math.round(proc.sm_pct)}%`,
            proc.used_mem_mib === null ? null : `显存 ${gib(proc.used_mem_mib)}`,
            proc.name,
          ]
            .filter(Boolean)
            .join(' · ')}
        >
          {proc.username ?? '未知用户'}@{proc.pid}
        </Tag>
      ))}
    </div>
  );
}

/**
 * Expanded detail: one row per process, user next to PID.
 *
 * Exported so the render check can exercise the shared-card case directly --
 * collapsed rows deliberately do not contain the other users' PIDs.
 */
export function ProcTable({ gpu }: { gpu: Gpu }) {
  const colors = useSeverityColors();

  const columns: ColumnsType<GpuProc> = [
    {
      title: '用户',
      dataIndex: 'username',
      width: 160,
      render: (user: string | null) =>
        user ?? <Typography.Text type="secondary">未知用户</Typography.Text>,
    },
    {
      title: 'PID',
      dataIndex: 'pid',
      width: 110,
      render: (pid: number) => (
        <Typography.Text code style={{ fontSize: 11.5 }}>
          {pid}
        </Typography.Text>
      ),
    },
    {
      // How long this process has been holding the card. A job left running for
      // days is the usual reason a GPU looks busy but nobody is getting anything
      // out of it, and nothing else on the page showed it.
      title: '已运行',
      dataIndex: 'elapsed_s',
      width: 100,
      align: 'right',
      render: (secs: number | null) =>
        secs === null ? (
          <Typography.Text type="secondary">—</Typography.Text>
        ) : (
          <Typography.Text style={{ fontSize: 11.5 }}>{duration(secs)}</Typography.Text>
        ),
    },
    {
      title: 'SM 利用率',
      dataIndex: 'sm_pct',
      width: 130,
      render: (sm: number | null) =>
        sm === null ? (
          <Typography.Text type="secondary">—</Typography.Text>
        ) : (
          <Typography.Text style={{ color: activityColor(sm, colors) }}>
            {Math.round(sm)}%
          </Typography.Text>
        ),
    },
    {
      title: '显存',
      dataIndex: 'used_mem_mib',
      width: 110,
      align: 'right',
      render: (mib: number | null) => gib(mib),
    },
    {
      title: '进程',
      dataIndex: 'name',
      ellipsis: true,
      render: (name: string | null) => (
        <Typography.Text type="secondary" style={{ fontSize: 11.5 }} title={name ?? undefined}>
          {name ?? '—'}
        </Typography.Text>
      ),
    },
  ];

  return (
    <Table<GpuProc>
      size="small"
      rowKey="pid"
      columns={columns}
      dataSource={gpu.procs}
      pagination={false}
    />
  );
}

/** A labelled meter used for the CPU / memory / card summary. */
function Stat({
  label,
  value,
  percent,
  sub,
  subTitle,
  color: colorOverride,
}: {
  label: string;
  value: string;
  percent: number | null | undefined;
  sub: string;
  subTitle?: string;
  /** Overrides the severity ramp; see the card-occupancy meter below. */
  color?: string;
}) {
  const colors = useSeverityColors();
  const color = colorOverride ?? colors[severity(percent)];
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <Typography.Text type="secondary" style={{ fontSize: 11.5 }}>
          {label}
        </Typography.Text>
        <Typography.Text strong style={{ fontSize: 12.5, color }}>
          {value}
        </Typography.Text>
      </div>
      <Progress percent={percent ?? 0} size="small" showInfo={false} strokeColor={color} />
      <Typography.Text type="secondary" style={{ fontSize: 11 }} title={subTitle}>
        {sub}
      </Typography.Text>
    </div>
  );
}
