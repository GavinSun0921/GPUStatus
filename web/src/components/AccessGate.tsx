import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Button, Card, Form, Input, Spin, Typography, theme as antdTheme } from 'antd';

/**
 * Site-wide entry gate.
 *
 * When the config sets an `access` password, nothing of the dashboard is
 * rendered (and no data API is reachable) until the shared password is entered.
 * The session is an HttpOnly cookie issued by `/api/access/login`; this
 * component only asks whether the current session is valid.
 *
 * With no password configured the gate is transparent and the app renders as
 * before.
 */
type AccessSession = {
  enabled: boolean;
  authenticated: boolean;
  site: string;
};

export function AccessGate({ children }: { children: ReactNode }) {
  const { token } = antdTheme.useToken();
  const [session, setSession] = useState<AccessSession | null>(null);
  const [password, setPassword] = useState('');
  const [loggingIn, setLoggingIn] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);

  const checkSession = useCallback(async () => {
    try {
      const res = await fetch('/api/access/session');
      setSession(await res.json());
    } catch {
      // Backend unreachable: keep the gate closed rather than inventing access.
      setSession({ enabled: true, authenticated: false, site: '' });
    }
  }, []);

  useEffect(() => {
    void checkSession();
  }, [checkSession]);

  if (!session) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Spin /> <Typography.Text type="secondary">正在检查访问口令…</Typography.Text>
      </div>
    );
  }

  if (!session.enabled || session.authenticated) return children;

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: token.colorBgLayout,
        padding: 24,
      }}
    >
      <Card size="small" title={session.site || 'GPUStatus'} style={{ width: 360 }}>
        <Form
          layout="vertical"
          onFinish={async () => {
            setLoggingIn(true);
            setLoginError(null);
            try {
              const res = await fetch('/api/access/login', {
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
          <Form.Item label="访问口令" required>
            <Input.Password
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoFocus
              placeholder="请输入访问口令"
            />
          </Form.Item>
          {loginError && (
            <Form.Item>
              <Typography.Text type="danger">{loginError}</Typography.Text>
            </Form.Item>
          )}
          <Button type="primary" htmlType="submit" loading={loggingIn} block>
            进入
          </Button>
        </Form>
      </Card>
    </div>
  );
}
