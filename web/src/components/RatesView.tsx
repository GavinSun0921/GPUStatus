import { Alert, Card, Empty, Flex, Skeleton, Tooltip, Typography, theme } from 'antd';

import { useJson } from '../api';
import type { PriceBook } from '../types';
import { displayFallbackName } from '../format';

type RateRow = {
  key: string;
  model: string;
  short: string;
  price: number;
};

/**
 * Static rate board (`config/prices.json`).
 *
 * Deliberately not an inventory: this page only answers "what does one card-hour
 * of this model cost". Machine placement lives on the 总览 / 机器 cards. Prices
 * are always the CURRENT rates -- a research-compute estimate, not a bill.
 */
export function RatesView() {
  const { token } = theme.useToken();
  const { data, loading, error } = useJson<PriceBook>('/api/prices');

  const rows: RateRow[] = Object.entries(data?.rates ?? {})
    .map(([model, price]) => ({
      key: model,
      model,
      short: displayFallbackName(model),
      price,
    }))
    .sort((a, b) => a.price - b.price || a.short.localeCompare(b.short));

  const ready = !loading && !error;

  return (
    <div style={{ maxWidth: 560, margin: '0 auto' }}>
      <Card
        size="small"
        title="价目表"
        extra={
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            元 / 卡·时
          </Typography.Text>
        }
      >
        <Typography.Paragraph
          style={{
            fontSize: 12,
            marginBottom: 12,
            lineHeight: 1.5,
            color: token.colorTextTertiary,
          }}
        >
          {data?.label ? `${data.label} · ` : ''}
          {data?.note ?? '按占用计,只用最新价。'}
        </Typography.Paragraph>

        {error && (
          <Alert type="error" showIcon style={{ marginBottom: 8 }} message={error} />
        )}

        {loading && <Skeleton active paragraph={{ rows: 5 }} title={false} />}

        {ready && rows.length === 0 && (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                尚未配置价目
              </Typography.Text>
            }
          />
        )}

        {ready && rows.length > 0 && (
          <div
            style={{
              border: `1px solid ${token.colorBorderSecondary}`,
              borderRadius: token.borderRadius,
              overflow: 'hidden',
            }}
          >
            {rows.map((r, i) => (
              <Flex
                key={r.key}
                align="center"
                justify="space-between"
                gap={12}
                style={{
                  padding: '9px 14px',
                  background: i % 2 ? token.colorFillQuaternary : token.colorBgContainer,
                  borderTop: i === 0 ? undefined : `1px solid ${token.colorBorderSecondary}`,
                }}
              >
                <Flex vertical gap={1} style={{ minWidth: 0 }}>
                  <Tooltip title={r.model}>
                    <Typography.Text
                      strong
                      style={{ fontSize: 15, lineHeight: 1.3, color: token.colorText }}
                      ellipsis
                    >
                      {r.short}
                    </Typography.Text>
                  </Tooltip>
                  <Typography.Text
                    style={{ fontSize: 11, lineHeight: 1.3, color: token.colorTextTertiary }}
                    ellipsis={{ tooltip: r.model }}
                  >
                    {r.model}
                  </Typography.Text>
                </Flex>

                <Typography.Text
                  strong
                  style={{
                    fontSize: 18,
                    lineHeight: 1.2,
                    fontVariantNumeric: 'tabular-nums',
                    flex: 'none',
                    color: token.colorPrimary,
                  }}
                >
                  ¥{r.price}
                  <Typography.Text
                    style={{ fontSize: 12, fontWeight: 400, color: token.colorTextSecondary }}
                  >
                    {' '}
                    /卡·时
                  </Typography.Text>
                </Typography.Text>
              </Flex>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
