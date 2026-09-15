import type { ReactNode } from 'react';
import { Alert, Typography } from 'antd';
import type { Announcement } from '../types';

/**
 * Site-wide announcement, shown above the dashboard.
 *
 * Deliberately not dismissible: an announcement is there to be read, and on a
 * wall display a per-browser dismissal would just hide it from whoever closed it
 * once. Hiding it for everyone is what the admin toggle is for.
 */
export function AnnouncementBanner({ announcement }: { announcement: Announcement | null }) {
  if (!announcement) return null;
  const { level, title, body } = announcement;
  if (!title.trim() && !body.trim()) return null;

  return (
    <Alert
      type={level}
      showIcon
      message={title.trim() || undefined}
      description={
        body.trim() ? (
          // pre-wrap so the configured line breaks survive; the old dashboard's
          // announcement relied on them.
          <Typography.Paragraph style={{ marginBottom: 0, whiteSpace: 'pre-wrap' }}>
            {linkify(body)}
          </Typography.Paragraph>
        ) : undefined
      }
    />
  );
}

/** A per-machine notice, rendered inside that machine's card. */
export function HostNote({ note, tone }: { note: string; tone: string }) {
  return (
    <div style={{ padding: '7px 16px', borderBottom: `1px solid ${tone}` }}>
      <Typography.Text style={{ fontSize: 12.5, whiteSpace: 'pre-wrap' }}>
        {linkify(note)}
      </Typography.Text>
    </div>
  );
}

// Split on URLs, keeping them as captures. Trailing CJK and ASCII punctuation is
// excluded so a link at the end of a sentence does not swallow the full stop.
const URL_SPLIT = /(https?:\/\/[^\s，。；：、！？）)】」》"'<>]+)/g;
const IS_URL = /^https?:\/\//;

/**
 * Turn bare http(s) URLs into links.
 *
 * Built as React elements rather than injected HTML: the text comes from an
 * operator-editable config file, and `dangerouslySetInnerHTML` would make it an
 * injection point for no benefit.
 */
function linkify(text: string): ReactNode[] {
  return text.split(URL_SPLIT).map((part, index) =>
    IS_URL.test(part) ? (
      <a key={index} href={part} target="_blank" rel="noreferrer noopener">
        {part}
      </a>
    ) : (
      part
    ),
  );
}
