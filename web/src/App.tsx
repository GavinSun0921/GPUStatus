import { Component, useEffect, useState, type ReactNode } from 'react';
import { Alert, ConfigProvider, Layout, Segmented, Space, Tabs, Typography, theme as antdTheme } from 'antd';
import zhCN from 'antd/locale/zh_CN';

import { useSnapshot } from './api';
import { useTheme, type ThemeMode } from './theme';
import { Overview } from './components/Overview';
import { EventsView, UsageView, UsersView } from './components/Reports';
import { HistoryView } from './components/HistoryView';
import { AdminView } from './components/AdminView';
import { ago } from './format';

/**
 * Contains a render error to the view that caused it.
 *
 * A missing field in the admin API used to throw inside the table and unmount
 * the WHOLE app, leaving a blank page with no clue what happened -- the user
 * could only report "the admin page won't open". With a boundary the header,
 * tabs and other views survive, and the actual message is shown.
 *
 * Keyed by tab, so switching tabs clears a previous failure.
 */
class ViewErrorBoundary extends Component<
  { children: ReactNode; view: string },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error(`view "${this.props.view}" crashed:`, error);
  }

  render() {
    if (this.state.error) {
      return (
        <Alert
          type="error"
          showIcon
          message={`「${this.props.view}」页渲染出错`}
          description={
            <>
              <Typography.Paragraph style={{ marginBottom: 4 }}>
                <Typography.Text code>{this.state.error.message}</Typography.Text>
              </Typography.Paragraph>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                其他页签仍可正常使用。这通常是后端返回的字段与界面预期不一致,请把上面这行信息反馈。
              </Typography.Text>
            </>
          }
        />
      );
    }
    return this.props.children;
  }
}

type Tab = 'overview' | 'users' | 'history' | 'usage' | 'events' | 'admin';

const TABS: { key: Tab; label: string }[] = [
  { key: 'overview', label: '总览' },
  { key: 'users', label: '用户' },
  { key: 'history', label: '历史' },
  { key: 'usage', label: '用量' },
  { key: 'events', label: '事件' },
  { key: 'admin', label: '管理' },
];

const THEME_OPTIONS: { value: ThemeMode; label: string }[] = [
  { value: 'auto', label: '自动' },
  { value: 'light', label: '亮' },
  { value: 'dark', label: '暗' },
];

export default function App() {
  const { mode, resolved, setMode } = useTheme();

  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        // The system preference is already resolved by theme.ts, so antd only
        // has to pick the matching algorithm.
        algorithm: resolved === 'dark' ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
        token: { borderRadius: 8, fontSize: 13, wireframe: false },
      }}
    >
      <Shell mode={mode} setMode={setMode} />
    </ConfigProvider>
  );
}

/** Split out so it can consume the ConfigProvider context (theme.useToken etc.). */
function Shell({
  mode,
  setMode,
}: {
  mode: ThemeMode;
  setMode: (m: ThemeMode) => void;
}) {
  const { token } = antdTheme.useToken();
  const { snapshot, connected, now } = useSnapshot();
  const [tab, setTab] = useState<Tab>('overview');

  // Surface problems in the browser tab too: a wall display should be
  // noticeable without anyone reading the table.
  useEffect(() => {
    if (!snapshot) return;
    const { hosts_down, hosts_stale, hosts_unknown } = snapshot.summary;
    const bad = hosts_down + hosts_stale + hosts_unknown;
    const prefix = hosts_down > 0 ? `(${hosts_down} 失联) ` : bad > 0 ? `(${bad} 异常) ` : '';
    document.title = `${prefix}${snapshot.site ? `${snapshot.site} ` : ''}GPUStatus`;
  }, [snapshot]);

  return (
    <Layout style={{ minHeight: '100vh', background: token.colorBgLayout }}>
      <Layout.Header
        style={{
          background: token.colorBgContainer,
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
          padding: 0,
          height: 'auto',
          lineHeight: 1.5,
          position: 'sticky',
          top: 0,
          zIndex: 10,
        }}
      >
        <div className="shell header-inner">
          {/* The lab name leads: it identifies the installation, whereas the
              tool name is secondary. `site` falls back to "GPUStatus" so an
              unconfigured deployment still has a title. */}
          <Space size={10} align="center">
            {/* The emblem is dark blue, roughly 2:1 against the dark theme's
                background, so it sits on a chip that stays light in BOTH themes
                rather than being recoloured -- it is an official mark, and its
                colours are not ours to adjust. `colorWhite` is a theme-invariant
                antd token, which keeps this out of the hardcoded-colour rule. */}
            <span
              style={{
                width: 42,
                height: 42,
                borderRadius: 10,
                background: token.colorWhite,
                boxShadow: `inset 0 0 0 1px ${token.colorBorderSecondary}`,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                flex: 'none',
              }}
            >
              {/* Decorative: the site name sits immediately beside it. */}
              <img src="/logo.png" alt="" width={36} height={36} style={{ display: 'block' }} />
            </span>
            <Typography.Text strong style={{ fontSize: 23, letterSpacing: 0.2, lineHeight: 1.15 }}>
              {snapshot?.site || 'GPUStatus'}
            </Typography.Text>
            {snapshot?.site && (
              <Typography.Text type="secondary" style={{ fontSize: 13 }}>
                GPUStatus · GPU 集群监控
              </Typography.Text>
            )}
          </Space>

          {/* Navigation sits on the SAME row as the brand: the header was two
              rows, and the brand row had a lot of unused width while the tab row
              had its own. `header-nav` keeps antd's Tabs from stretching and
              from adding its usual bottom margin. */}
          <Tabs
            className="header-nav"
            activeKey={tab}
            onChange={(k) => setTab(k as Tab)}
            items={TABS.map((t) => ({ key: t.key, label: t.label }))}
            tabBarStyle={{ marginBottom: 0 }}
          />

          <div className="header-right">
            {snapshot && (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {snapshot.config.interval_ms / 1000}s 轮询 ·{' '}
                {snapshot.last_poll_completed_at ? ago(now - snapshot.last_poll_completed_at) : '—'}
                {!connected && <Typography.Text type="warning"> · 连接中断,重连中</Typography.Text>}
              </Typography.Text>
            )}
            <Segmented
              size="small"
              value={mode}
              onChange={(v) => setMode(v as ThemeMode)}
              options={THEME_OPTIONS}
            />
          </div>
        </div>
      </Layout.Header>

      <Layout.Content>
        {/* The page stays narrower than the viewport: a wide table is harder to
            read, not easier. */}
        <div className="shell content-inner">
          {!snapshot && (
            <Typography.Paragraph type="secondary" style={{ textAlign: 'center', marginTop: 64 }}>
              正在连接后端…如果长时间没有响应,请确认后端已启动(<Typography.Text code>npm start</Typography.Text>)。
            </Typography.Paragraph>
          )}

          <ViewErrorBoundary key={tab} view={TABS.find((t) => t.key === tab)?.label ?? tab}>
            {snapshot && tab === 'overview' && <Overview snapshot={snapshot} now={now} />}
            {snapshot && tab === 'users' && <UsersView snapshot={snapshot} />}
            {tab === 'history' && <HistoryView snapshot={snapshot} />}
            {snapshot && tab === 'usage' && <UsageView />}
            {snapshot && tab === 'events' && <EventsView />}
            {tab === 'admin' && <AdminView snapshot={snapshot} />}
          </ViewErrorBoundary>
        </div>
      </Layout.Content>

    </Layout>
  );
}
