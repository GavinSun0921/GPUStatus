import { Card, Col, Progress, Row, Statistic, Typography } from 'antd';
import type { Snapshot } from '../types';
import { gib } from '../format';
import { Machine } from './Machine';
import { AnnouncementBanner } from './Announcement';
import { useSeverityColors } from '../severity';

/** Cluster summary cards, then one machine card each. */
export function Overview({ snapshot, now }: { snapshot: Snapshot; now: number }) {
  const colors = useSeverityColors();
  const s = snapshot.summary;

  const problems = [
    s.hosts_stale > 0 ? `${s.hosts_stale} 台陈旧` : null,
    s.hosts_down > 0 ? `${s.hosts_down} 台失联` : null,
    s.hosts_unknown > 0 ? `${s.hosts_unknown} 台未知` : null,
  ].filter(Boolean);

  const hostColor = s.hosts_down > 0 ? colors.danger : problems.length ? colors.warn : colors.ok;
  const memPct = s.gpus_mem_total_mib > 0 ? (s.gpus_mem_used_mib / s.gpus_mem_total_mib) * 100 : 0;
  const allocPct = s.gpus_total > 0 ? (s.gpus_allocated / s.gpus_total) * 100 : 0;
  // Derived rather than sent, so the same figure cannot accidentally be shown
  // twice the way "显卡占用"/"空闲显卡" once were.
  const freeGpus = Math.max(0, s.gpus_total - s.gpus_allocated);

  return (
    <>
      <AnnouncementBanner announcement={snapshot.announcement} />

      <Row gutter={[12, 12]}>
        <Col xs={12} sm={8} lg={6}>
          <SummaryCard
            label="机器状态"
            value={`${s.hosts_ok} / ${s.hosts_total}`}
            color={hostColor}
            sub={problems.length ? problems.join(' · ') : '全部正常'}
          />
        </Col>
        {/* "空闲显卡" used to have its own card, but free is exactly
            total - allocated, so it restated this number twice over (once as a
            value, once as the sub-label). The free count is still shown here as
            context, not as a second headline figure. */}
        <Col xs={12} sm={8} lg={6}>
          <SummaryCard
            label="显卡占用"
            value={`${s.gpus_allocated} / ${s.gpus_total}`}
            suffix="张"
            color={colors.accent}
            percent={allocPct}
            sub={
              freeGpus > 0 ? `${freeGpus} 张无进程` : `${s.users_active} 人占用全部显卡`
            }
          />
        </Col>
        <Col xs={12} sm={8} lg={6}>
          <SummaryCard
            label="显存占用"
            value={gib(s.gpus_mem_used_mib, 0)}
            color={colors.accent}
            percent={memPct}
            sub={`共 ${gib(s.gpus_mem_total_mib, 0)}`}
          />
        </Col>
        <Col xs={12} sm={8} lg={6}>
          <SummaryCard
            label="在线用户"
            value={String(s.users_active)}
            suffix="人"
            sub={`${s.procs_total} 个进程`}
          />
        </Col>
      </Row>

      {snapshot.hosts.map((host) => (
        <Machine host={host} key={host.id} now={now} site={snapshot.site} />
      ))}
    </>
  );
}

function SummaryCard({
  label,
  value,
  suffix,
  sub,
  color,
  percent,
}: {
  label: string;
  value: string;
  suffix?: string;
  sub?: string;
  color?: string;
  percent?: number;
}) {
  return (
    <Card size="small" styles={{ body: { padding: '10px 14px' } }}>
      <Statistic
        title={<span style={{ fontSize: 11.5 }}>{label}</span>}
        value={value}
        suffix={suffix ? <span style={{ fontSize: 12 }}>{suffix}</span> : undefined}
        styles={{ content: { fontSize: 19, fontWeight: 650, color } }}
      />
      {percent !== undefined && (
        <Progress percent={percent} size="small" showInfo={false} strokeColor={color} />
      )}
      {sub && (
        <Typography.Text type="secondary" style={{ fontSize: 11.5 }}>
          {sub}
        </Typography.Text>
      )}
    </Card>
  );
}
