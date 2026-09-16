import { AdminConfigSchema } from '../../../shared/schema';
import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Col,
  Row,
  Form,
  Input,
  InputNumber,
  Popconfirm,
  Segmented,
  Space,
  Spin,
  Switch,
  Table,
  Typography,
  message,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { Snapshot } from '../types';

/**
 * Configuration page.
 *
 * Guarded by a password held in the config file (see server/auth.js). The
 * session is an HttpOnly cookie, so this component never sees the credential --
 * it only asks the server whether the current session is valid.
 *
 * The password itself is deliberately NOT editable here: a lost password must
 * always be recoverable by editing the file and restarting, without needing the
 * UI that the password protects.
 */

interface EditableAnnouncement {
  enabled: boolean;
  level: 'info' | 'warning' | 'error';
  title: string;
  body: string;
}

// `EditableHost` / `AdminConfig` used to be declared here as well -- a fourth
// hand-maintained copy of a shape that `shared/schema.ts` now defines once.
// `key` is a React list key that only exists in this component's state, hence
// the intersection rather than a new interface.
import type { EditableHost as EditableHostFields, AdminConfig as AdminConfigFields } from '../types';

type EditableHost = EditableHostFields & { key: string };
type AdminConfig = AdminConfigFields & {
  /** `enabled` is derived for the toggle; the API carries only title/body. */
  announcement: EditableAnnouncement;
};

export function AdminView({ snapshot }: { snapshot: Snapshot | null }) {
  const [session, setSession] = useState<{ enabled: boolean; authenticated: boolean; hint: string | null } | null>(null);
  const [password, setPassword] = useState('');
  const [loggingIn, setLoggingIn] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);

  const checkSession = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/session');
      setSession(await res.json());
    } catch {
      setSession({ enabled: false, authenticated: false, hint: '无法连接后端' });
    }
  }, []);

  useEffect(() => {
    void checkSession();
  }, [checkSession]);

  if (!session) {
    return (
      <Card size="small">
        <Spin /> <Typography.Text type="secondary">正在检查登录状态…</Typography.Text>
      </Card>
    );
  }

  if (!session.enabled) {
    return (
      <Card size="small" title="管理">
        <Alert
          type="warning"
          showIcon
          message="管理页面未启用"
          description={
            <>
              <Typography.Paragraph>{session.hint}</Typography.Paragraph>
              <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
                生成密码摘要:
                <br />
                <Typography.Text code>
                  node -e &quot;console.log(require(&apos;crypto&apos;).createHash(&apos;sha256&apos;).update(&apos;你的密码&apos;).digest(&apos;hex&apos;))&quot;
                </Typography.Text>
              </Typography.Paragraph>
            </>
          }
        />
      </Card>
    );
  }

  if (!session.authenticated) {
    return (
      <Card size="small" title="管理登录" style={{ maxWidth: 420 }}>
        <Form
          layout="vertical"
          onFinish={async () => {
            setLoggingIn(true);
            setLoginError(null);
            try {
              const res = await fetch('/api/admin/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password }),
              });
              const body = await res.json().catch(() => ({}));
              if (!res.ok) {
                setLoginError(body.error ?? `登录失败 (HTTP ${res.status})`);
                return;
              }
              setPassword('');
              await checkSession();
            } catch (err) {
              setLoginError(err instanceof Error ? err.message : String(err));
            } finally {
              setLoggingIn(false);
            }
          }}
        >
          <Form.Item label="管理密码" required>
            <Input.Password
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoFocus
              placeholder="请输入配置文件中设置的密码"
            />
          </Form.Item>
          {loginError && (
            <Form.Item>
              <Typography.Text type="danger">{loginError}</Typography.Text>
            </Form.Item>
          )}
          <Button type="primary" htmlType="submit" loading={loggingIn} block>
            登录
          </Button>
          <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 12, marginBottom: 0 }}>
            提示:服务当前是 HTTP,密码在网络上不加密。内网可信环境之外请套 HTTPS 或走 SSH 隧道。
          </Typography.Paragraph>
        </Form>
      </Card>
    );
  }

  return <ConfigEditor onLogout={checkSession} snapshot={snapshot} />;
}

/**
 * Tick which network mounts this machine is EXPECTED to have.
 *
 * Every discovered network mount is health-checked regardless, so ticking does
 * not add or remove anything from the dashboard. What it buys is failure
 * detection: a mount that is expected but absent is reported as 未挂载, whereas
 * an unconfigured one would simply vanish from the list with no trace.
 */
function NetMountPicker({
  hostId,
  value,
  onChange,
  snapshot,
}: {
  hostId: string;
  value: string[];
  onChange: (next: string[]) => void;
  snapshot: Snapshot | null;
}) {
  const host = snapshot?.hosts.find((h) => h.id === hostId);
  const discovered = (host?.net_mounts ?? []).map((m) => m.path ?? '').filter(Boolean);
  const allOptions = [...new Set([...discovered, ...(value ?? [])])];

  if (!host) {
    return (
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        等待首次采集…
      </Typography.Text>
    );
  }
  if (allOptions.length === 0) {
    return (
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        该机未发现网络挂载。
      </Typography.Text>
    );
  }

  const statusOf = (path: string) => (host.net_mounts ?? []).find((m) => m.path === path);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 4 }}>
      {allOptions.map((path) => {
        const state = statusOf(path);
        return (
          <Checkbox
            key={path}
            checked={value.includes(path)}
            onChange={(e) =>
              onChange(e.target.checked ? [...value, path] : value.filter((p) => p !== path))
            }
          >
            <Typography.Text code style={{ fontSize: 12 }}>
              {path}
            </Typography.Text>
            {state?.fstype && (
              <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                {' '}
                {state.fstype}
              </Typography.Text>
            )}
            {!state ? (
              <Typography.Text type="danger" style={{ fontSize: 11 }}>
                {' '}
                当前未挂载
              </Typography.Text>
            ) : state.status !== 'rw' ? (
              <Typography.Text type="warning" style={{ fontSize: 11 }}>
                {' '}
                {state.status === 'ro' ? '只读' : state.status === 'stale' ? '无响应' : '未挂载'}
              </Typography.Text>
            ) : null}
          </Checkbox>
        );
      })}
      <Typography.Text type="secondary" style={{ fontSize: 11 }}>
        未勾选的挂载一旦消失不会被发现;勾选后缺失会显示为「未挂载」。
      </Typography.Text>
    </div>
  );
}

/**
 * Tick which of a machine's filesystems should be tracked.
 *
 * Options come from the LIVE snapshot, not from the saved config: the probe
 * always reports every discovered mount, so the full list is available even for
 * machines that already have a selection. Without that, anything unticked would
 * vanish from this list and could never be re-ticked.
 *
 * `null` means the host was never configured, in which case everything is shown
 * and every box starts ticked.
 */
function DiskPicker({
  hostId,
  value,
  onChange,
  snapshot,
}: {
  hostId: string;
  value: string[] | null;
  onChange: (next: string[] | null) => void;
  snapshot: Snapshot | null;
}) {
  const host = snapshot?.hosts.find((h) => h.id === hostId);
  if (!host || host.disks.length === 0) {
    return (
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {host ? '未发现可用的文件系统' : '等待首次采集…'}
      </Typography.Text>
    );
  }

  const allPaths = host.disks.map((d) => d.path ?? '').filter(Boolean);
  const checked = value === null ? allPaths : value.filter((p) => allPaths.includes(p));
  // Paths kept in the config that the machine no longer reports (e.g. a mount
  // that disappeared). They stay selectable so they are not silently dropped.
  const orphaned = (value ?? []).filter((p) => !allPaths.includes(p));

  const emit = (next: string[]) => {
    // An empty selection is a real choice, so it is saved as [] rather than
    // reverting to null ("show everything").
    onChange(next);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <Space size={8} style={{ marginBottom: 2 }}>
        <Button size="small" type="link" style={{ padding: 0 }} onClick={() => emit(allPaths)}>
          全选
        </Button>
        <Button size="small" type="link" style={{ padding: 0 }} onClick={() => emit([])}>
          全不选
        </Button>
        {value === null && (
          <Typography.Text type="secondary" style={{ fontSize: 11 }}>
            未配置,当前显示全部
          </Typography.Text>
        )}
        {value !== null && (
          <Typography.Text type="secondary" style={{ fontSize: 11 }}>
            已选 {checked.length} / {allPaths.length}
          </Typography.Text>
        )}
      </Space>

      {host.disks.map((disk) => {
        const path = disk.path ?? '';
        const isChecked = checked.includes(path);
        return (
          <Checkbox
            key={path}
            checked={isChecked}
            onChange={(e) =>
              emit(e.target.checked ? [...checked, path] : checked.filter((p) => p !== path))
            }
          >
            <Typography.Text code style={{ fontSize: 12 }}>
              {path}
            </Typography.Text>
            {disk.mount !== null && disk.mount !== disk.path && (
              <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                {' '}
                → {disk.mount}
              </Typography.Text>
            )}
            {disk.missing ? (
              <Typography.Text type="warning" style={{ fontSize: 11 }}>
                {' '}
                目录不存在
              </Typography.Text>
            ) : (
              <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                {' '}
                {disk.use_pct}% 已用
              </Typography.Text>
            )}
          </Checkbox>
        );
      })}

      {orphaned.map((path) => (
        <Checkbox
          key={path}
          checked
          onChange={() => emit(checked.filter((p) => p !== path))}
        >
          <Typography.Text code style={{ fontSize: 12 }}>
            {path}
          </Typography.Text>
          <Typography.Text type="warning" style={{ fontSize: 11 }}>
            {' '}
            该机已不再上报此项
          </Typography.Text>
        </Checkbox>
      ))}

      <Space.Compact style={{ marginTop: 4 }}>
        <Input
          size="small"
          placeholder="手工加一个子目录,如 /data"
          onPressEnter={(e) => {
            const v = (e.target as HTMLInputElement).value.trim();
            if (v && !checked.includes(v)) {
              emit([...checked, v]);
              (e.target as HTMLInputElement).value = '';
            }
          }}
        />
      </Space.Compact>
    </div>
  );
}

function ConfigEditor({
  onLogout,
  snapshot,
}: {
  onLogout: () => Promise<void>;
  snapshot: Snapshot | null;
}) {
  const [config, setConfig] = useState<AdminConfig | null>(null);
  const [hosts, setHosts] = useState<EditableHost[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [messageApi, contextHolder] = message.useMessage();

  useEffect(() => {
    (async () => {
      const res = await fetch('/api/admin/config');
      if (res.status === 401) {
        await onLogout();
        return;
      }
      if (!res.ok) {
        setLoadError(`加载配置失败 (HTTP ${res.status})`);
        return;
      }
      // Validated, not cast. This page previously dereferenced fields directly
      // on an unchecked cast, and when one was missing from the payload the
      // whole view threw and rendered blank -- after a successful login, so it
      // looked like the login had failed. The defensive `?.`/`??` chain that
      // grew here afterwards is unnecessary once the shape is checked.
      const parsed = AdminConfigSchema.safeParse(await res.json());
      if (!parsed.success) {
        const where = parsed.error.issues
          .slice(0, 3)
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; ');
        setLoadError(`服务端返回的管理配置不符合约定 — ${where}`);
        return;
      }
      const body = parsed.data;
      setConfig({
        ...body,
        announcement: {
          enabled: Boolean(body.announcement.title || body.announcement.body),
          level: body.announcement.level,
          title: body.announcement.title,
          body: body.announcement.body,
        },
      });
      setHosts(body.hosts.map((h, i) => ({ ...h, key: `${h.id}-${i}` })));
    })();
  }, [onLogout]);

  if (loadError) return <Alert type="error" showIcon message={loadError} />;
  if (!config) {
    return (
      <Card size="small">
        <Spin /> <Typography.Text type="secondary">正在加载配置…</Typography.Text>
      </Card>
    );
  }

  const patch = (key: string, changes: Partial<EditableHost>) =>
    setHosts((prev) => prev.map((h) => (h.key === key ? { ...h, ...changes } : h)));

  const columns: ColumnsType<EditableHost> = [
    {
      title: 'ID',
      dataIndex: 'id',
      width: 130,
      render: (value: string, row) => (
        <Input
          value={value}
          onChange={(e) => patch(row.key, { id: e.target.value })}
          placeholder="唯一标识"
        />
      ),
    },
    {
      title: 'SSH 目标',
      dataIndex: 'ssh',
      width: 170,
      render: (value: string, row) => (
        <Input
          value={value}
          onChange={(e) => patch(row.key, { ssh: e.target.value })}
          placeholder="别名或 user@ip"
        />
      ),
    },
    {
      title: '显示名',
      dataIndex: 'label',
      width: 130,
      render: (value: string, row) => (
        <Input
          value={value}
          onChange={(e) => patch(row.key, { label: e.target.value })}
          placeholder="留空=用 hostname"
        />
      ),
    },
    {
      title: '分组',
      dataIndex: 'group',
      width: 110,
      render: (value: string, row) => (
        <Input value={value} onChange={(e) => patch(row.key, { group: e.target.value })} />
      ),
    },
    {
      title: '卡数',
      dataIndex: 'expect_gpus',
      width: 90,
      render: (value: number | null, row) => (
        <InputNumber
          value={value}
          min={0}
          style={{ width: '100%' }}
          onChange={(v) => patch(row.key, { expect_gpus: v })}
        />
      ),
    },
    {
      title: '监控目录',
      dataIndex: 'disks',
      width: 210,
      render: (value: string[] | null, row) => (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {value === null ? '全部本地磁盘' : `已选 ${value.length} 项`}
          {(row.net_mounts ?? []).length > 0 && ` · 网络挂载 ${row.net_mounts.length}`}
        </Typography.Text>
      ),
    },
    {
      title: '',
      width: 70,
      render: (_v, row) => (
        <Popconfirm
          title="删除这台机器?"
          description="该机历史仍保留在数据库中,但不再采集。"
          onConfirm={() => setHosts((prev) => prev.filter((h) => h.key !== row.key))}
        >
          <Button size="small" danger type="text">
            删除
          </Button>
        </Popconfirm>
      ),
    },
  ];

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch('/api/admin/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          site: config.site,
          announcement: config.announcement,
          poll: config.poll,
          naming: config.naming,
          hosts: hosts.map(({ key: _key, ...rest }) => rest),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setSaveError(body.error ?? `保存失败 (HTTP ${res.status})`);
        return;
      }
      messageApi.success(`已保存并生效:${body.hosts} 台机器${body.backup ? '(原文件已备份为 hosts.json.bak)' : ''}`);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      {contextHolder}

      <Alert
        type="info"
        showIcon
        message="保存后立即生效,无需重启"
        description="保存会按标准注释重新生成 config/hosts.json,你手写的注释会被替换;第一次保存前会自动留一份 hosts.json.bak。"
      />

      <Card
        size="small"
        title="采集设置"
        extra={
          <Space>
            <Button
              onClick={async () => {
                await fetch('/api/admin/logout', { method: 'POST' });
                await onLogout();
              }}
            >
              退出登录
            </Button>
            <Button type="primary" loading={saving} onClick={save}>
              保存
            </Button>
          </Space>
        }
      >
        <Space size={24} wrap align="start">
          <Form.Item label="实验室 / 站点名称" style={{ marginBottom: 0 }}>
            <Input
              style={{ width: 180 }}
              value={config.site}
              placeholder="显示在页面顶部,留空则显示 GPUStatus"
              onChange={(e) => setConfig({ ...config, site: e.target.value })}
            />
          </Form.Item>
          <Form.Item label="采集间隔(秒)" style={{ marginBottom: 0 }}>
            <InputNumber
              min={1}
              value={Math.round(config.poll.interval_ms / 1000)}
              onChange={(v) =>
                setConfig({ ...config, poll: { ...config.poll, interval_ms: (v ?? 15) * 1000 } })
              }
            />
          </Form.Item>
          <Form.Item label="超时(秒)" style={{ marginBottom: 0 }}>
            <InputNumber
              min={1}
              value={Math.round(config.poll.timeout_ms / 1000)}
              onChange={(v) =>
                setConfig({ ...config, poll: { ...config.poll, timeout_ms: (v ?? 12) * 1000 } })
              }
            />
          </Form.Item>
          <Form.Item label="多久没更新变黄(秒)" style={{ marginBottom: 0 }}>
            <InputNumber
              min={1}
              value={Math.round(config.poll.stale_after_ms / 1000)}
              onChange={(v) =>
                setConfig({ ...config, poll: { ...config.poll, stale_after_ms: (v ?? 45) * 1000 } })
              }
            />
          </Form.Item>
          <Form.Item label="连续失败几次变红" style={{ marginBottom: 0 }}>
            <InputNumber
              min={1}
              value={config.poll.down_after_failures}
              onChange={(v) =>
                setConfig({ ...config, poll: { ...config.poll, down_after_failures: v ?? 3 } })
              }
            />
          </Form.Item>
          <Form.Item label="显示名去掉域名" style={{ marginBottom: 0 }}>
            <Switch
              checked={config.naming.strip_domain}
              onChange={(v) => setConfig({ ...config, naming: { ...config.naming, strip_domain: v } })}
            />
          </Form.Item>
          <Form.Item label="显示名首字母大写" style={{ marginBottom: 0 }}>
            <Switch
              checked={config.naming.capitalize}
              onChange={(v) => setConfig({ ...config, naming: { ...config.naming, capitalize: v } })}
            />
          </Form.Item>
        </Space>
      </Card>

      <Card size="small" title="公告栏">
        <Form layout="vertical" style={{ marginBottom: -8 }}>
          <Space size={24} wrap align="start">
            <Form.Item label="显示公告">
              <Switch
                checked={config.announcement.enabled}
                onChange={(v) =>
                  setConfig({ ...config, announcement: { ...config.announcement, enabled: v } })
                }
              />
            </Form.Item>
            <Form.Item label="级别">
              <Segmented
                value={config.announcement.level}
                onChange={(v) =>
                  setConfig({
                    ...config,
                    announcement: {
                      ...config.announcement,
                      level: v as EditableAnnouncement['level'],
                    },
                  })
                }
                options={[
                  { value: 'info', label: '通知' },
                  { value: 'warning', label: '注意' },
                  { value: 'error', label: '重要' },
                ]}
              />
            </Form.Item>
            <Form.Item label="标题" style={{ minWidth: 320 }}>
              <Input
                value={config.announcement.title}
                placeholder="例如:使用须知"
                onChange={(e) =>
                  setConfig({
                    ...config,
                    announcement: { ...config.announcement, title: e.target.value },
                  })
                }
              />
            </Form.Item>
          </Space>
          <Form.Item label="内容(支持多行;http 链接会自动变成可点击)">
            <Input.TextArea
              rows={4}
              value={config.announcement.body}
              placeholder={'请使用绿色状态服务器。\n服务器使用手册:https://example.com/手册\n有问题请联系管理员。'}
              onChange={(e) =>
                setConfig({
                  ...config,
                  announcement: { ...config.announcement, body: e.target.value },
                })
              }
            />
          </Form.Item>
        </Form>
      </Card>

      <Card
        size="small"
        title={`机器列表(${hosts.length})`}
        extra={
          <Button
            onClick={() =>
              setHosts((prev) => [
                ...prev,
                {
                  key: `new-${Date.now()}`,
                  id: '',
                  label: '',
                  ssh: '',
                  group: prev[0]?.group ?? '',
                  expect_gpus: 8,
                  disks: [],
                  net_mounts: [],
                  note: '',
                },
              ])
            }
          >
            添加机器
          </Button>
        }
      >
        {saveError && (
          <Alert type="error" showIcon message="保存失败" description={saveError} style={{ marginBottom: 12 }} />
        )}
        <Table<EditableHost>
          size="small"
          rowKey="key"
          columns={columns}
          dataSource={hosts}
          pagination={false}
          // No `scroll={{x:'max-content'}}`: combined with an expanded row (a
          // single cell spanning every column) antd derives the column widths
          // from that row and collapses all the others. Same bug as the users
          // table; fixed here before anyone hit it.
          expandable={{
            // The two pickers are wide and only needed occasionally, so they
            // live behind the expander rather than widening every row.
            expandedRowRender: (row) => (
              <Row gutter={[24, 12]}>
                <Col xs={24} lg={12}>
                  <Typography.Text strong style={{ fontSize: 12 }}>
                    本地磁盘(勾选要统计并显示用量的)
                  </Typography.Text>
                  <Typography.Paragraph
                    type="secondary"
                    style={{ fontSize: 11, margin: '2px 0 0' }}
                  >
                    {snapshot
                      ? '系统盘与 EFI 分区按 disk_exclude 配置全局排除,不在下面的列表中。'
                      : ''}
                  </Typography.Paragraph>
                  <DiskPicker
                    hostId={row.id}
                    value={row.disks}
                    onChange={(next) => patch(row.key, { disks: next })}
                    snapshot={snapshot}
                  />
                </Col>
                <Col xs={24} lg={24}>
                  <Typography.Text strong style={{ fontSize: 12 }}>
                    该机通告(显示在这台机器的卡片上,留空则不显示)
                  </Typography.Text>
                  <Input.TextArea
                    style={{ marginTop: 4 }}
                    rows={2}
                    value={row.note}
                    placeholder="例如:本机 3/15 全天维护,请提前保存进度"
                    onChange={(e) => patch(row.key, { note: e.target.value })}
                  />
                </Col>
                <Col xs={24} lg={12}>
                  <Typography.Text strong style={{ fontSize: 12 }}>
                    网络挂载(只检查是否健康挂载,不统计容量)
                  </Typography.Text>
                  <NetMountPicker
                    hostId={row.id}
                    value={row.net_mounts}
                    onChange={(next) => patch(row.key, { net_mounts: next })}
                    snapshot={snapshot}
                  />
                </Col>
              </Row>
            ),
          }}
        />
        <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 10, marginBottom: 0 }}>
          展开每行可勾选该机要统计的<b>本地磁盘</b>,以及要检查健康状态的<b>网络挂载</b>。
          磁盘填目录即可(用 <Typography.Text code>df</Typography.Text> 自动解析到所在文件系统);
          系统盘与 EFI 分区已全局排除。
        </Typography.Paragraph>
      </Card>
    </Space>
  );
}
