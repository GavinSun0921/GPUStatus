/**
 * HTTP API.
 *
 * The frontend and backend are separate: everything the UI needs is exposed as
 * JSON over `/api/*`, and live updates arrive as Server-Sent Events. Point a
 * different static host at this API and nothing here needs to change (CORS is
 * open for the read-only endpoints, because those are unauthenticated and
 * intranet-facing by design).
 *
 * Everything under `/api/admin/*` except login/session requires a valid session
 * cookie -- see auth.js.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { loadConfig, serializeConfig } from './config.js';
import { SESSION_COOKIE, parseCookies } from './auth.js';

const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;
const MAX_BODY_BYTES = 256 * 1024;

/**
 * Parse a time parameter. Accepts epoch milliseconds, an ISO-8601 date, or a
 * relative offset such as `-30m`, `-24h`, `-7d`, `-1y`. Returns null if the
 * value cannot be understood, so callers can fall back to a default.
 */
export function parseTime(value) {
  if (value === null || value === undefined || value === '') return null;
  const str = String(value).trim();

  if (/^-?\d+$/.test(str)) {
    const n = Number(str);
    // Heuristic: 10-digit values are seconds, 13-digit are milliseconds.
    return str.replace('-', '').length <= 10 ? n * 1000 : n;
  }

  const rel = /^-(\d+)([smhdwy])$/.exec(str);
  if (rel) {
    const amount = Number(rel[1]);
    const unit = { s: 1000, m: 60_000, h: HOUR_MS, d: DAY_MS, w: 7 * DAY_MS, y: 365 * DAY_MS }[rel[2]];
    return Date.now() - amount * unit;
  }

  const parsed = Date.parse(str);
  return Number.isNaN(parsed) ? null : parsed;
}

function json(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    ...extraHeaders,
  });
  res.end(payload);
}

/** Read and parse a JSON request body, refusing anything oversized. */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch (err) {
        reject(new Error(`invalid JSON body: ${err.message}`));
      }
    });
    req.on('error', reject);
  });
}

/** Resolve a {from,to} window from query params, with period-preserving defaults. */
function resolveWindow(query, defaultSpanMs = DAY_MS) {
  const now = Date.now();
  let to = parseTime(query.get('to'));
  let from = parseTime(query.get('from'));
  if (to === null) to = now;
  if (from === null) from = to - defaultSpanMs;
  if (from > to) [from, to] = [to, from];
  return { from, to };
}

/**
 * Server-Sent Events stream of full snapshots.
 *
 * SSE rather than WebSocket: updates are one-directional, it reconnects
 * automatically, it is plain HTTP (so nginx/SSH tunnels need no upgrade
 * configuration), and it costs nothing to implement without a dependency.
 */
function handleStream(req, res, state) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Disable proxy buffering, otherwise events arrive in bursts.
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': '*',
  });

  const send = (snapshot, reason) => {
    res.write(`event: snapshot\ndata: ${JSON.stringify({ reason, ...snapshot })}\n\n`);
  };

  send(state.buildSnapshot(), 'initial');
  const unsubscribe = state.subscribe(send);

  // Comment frames keep intermediaries from closing an idle connection.
  const heartbeat = setInterval(() => {
    res.write(': ping\n\n');
  }, 15_000);

  const close = () => {
    clearInterval(heartbeat);
    unsubscribe();
  };
  req.on('close', close);
  req.on('error', close);
}

/**
 * The editable view of the configuration. The password is never returned --
 * only whether one is set.
 *
 * Every field the admin page reads MUST be listed here. Omitting one is not a
 * cosmetic problem: the page dereferences them directly, so a missing key threw
 * `Cannot read properties of undefined` and blanked the whole view *after* a
 * successful login. `npm test` now asserts this shape against the UI's needs.
 *
 * Exported for that test.
 */
export function publicAdminConfig(config) {
  return {
    site: config.site ?? '',
    announcement: config.announcement ?? { level: 'info', title: '', body: '' },
    poll: {
      interval_ms: config.poll.intervalMs,
      timeout_ms: config.poll.timeoutMs,
      stale_after_ms: config.poll.staleAfterMs,
      down_after_failures: config.poll.downAfterFailures,
    },
    naming: {
      strip_domain: config.naming.stripDomain,
      capitalize: config.naming.capitalize,
    },
    admin: {
      has_password: Boolean(config.admin.password || config.admin.passwordSha256),
      using_sha256: Boolean(config.admin.passwordSha256),
      session_hours: config.admin.sessionHours,
    },
    hosts: config.hosts.map((h) => ({
      id: h.id,
      label: h.label ?? '',
      ssh: h.ssh,
      group: h.group ?? '',
      expect_gpus: h.expectGpus,
      disks: h.disks,
      net_mounts: h.netMounts ?? [],
      note: h.note ?? '',
    })),
  };
}

/**
 * Persist an edited configuration.
 *
 * The candidate is serialised to a temporary file and re-parsed through the
 * normal loader before the real file is touched. That guarantees a working
 * config is never replaced by one that would fail at the next start, and it also
 * validates the serialiser itself, since the round trip is what gets loaded.
 */
function saveConfig(config, editable) {
  const candidate = {
    site: editable.site === undefined ? config.site : String(editable.site).trim() || null,
    // Not editable in the UI, but must survive a save.
    diskExclude: config.diskExclude,
    gpuNames: config.gpuNames,
    announcement: editable.announcement
      ? {
          level: ['info', 'warning', 'error'].includes(String(editable.announcement.level))
            ? String(editable.announcement.level)
            : 'info',
          title: String(editable.announcement.title ?? ''),
          body: String(editable.announcement.body ?? ''),
          // Empty text disables it, so a cleared announcement never renders as
          // an empty coloured box.
          enabled:
            editable.announcement.enabled !== false &&
            Boolean(
              String(editable.announcement.title ?? '').trim() ||
                String(editable.announcement.body ?? '').trim(),
            ),
        }
      : config.announcement,
    // Untouched sections are carried over verbatim (see serializeConfig).
    server: config.server,
    ssh: config.ssh,
    db: config.db,
    admin: config.admin,
    raw: config.raw,
    poll: {
      intervalMs: Number(editable.poll?.interval_ms ?? config.poll.intervalMs),
      timeoutMs: Number(editable.poll?.timeout_ms ?? config.poll.timeoutMs),
      staleAfterMs: Number(editable.poll?.stale_after_ms ?? config.poll.staleAfterMs),
      downAfterFailures: Number(
        editable.poll?.down_after_failures ?? config.poll.downAfterFailures,
      ),
    },
    naming: {
      stripDomain: editable.naming?.strip_domain !== false,
      capitalize: editable.naming?.capitalize !== false,
    },
    hosts: (editable.hosts ?? []).map((h) => ({
      id: String(h?.id ?? '').trim(),
      label: h?.label ? String(h.label).trim() : null,
      ssh: String(h?.ssh ?? '').trim(),
      group: h?.group ? String(h.group).trim() : null,
      expectGpus:
        h?.expect_gpus === null || h?.expect_gpus === undefined || h?.expect_gpus === ''
          ? null
          : Number(h.expect_gpus),
      // null (never configured) must stay null: coercing it to [] would silently
      // switch the machine to "ticked nothing" and blank its disk panel.
      disks:
        h?.disks === null || h?.disks === undefined
          ? null
          : Array.isArray(h.disks)
            ? h.disks.map((d) => String(d).trim()).filter(Boolean)
            : [],
      // Every field the admin page can edit MUST be mapped here. Omitting one
      // does not fail loudly -- it silently resets that setting to empty on the
      // next save. `net_mounts` was missing, so each save wiped every machine's
      // network-mount list, and with it the ability to notice a mount that had
      // gone missing.
      netMounts: Array.isArray(h?.net_mounts)
        ? h.net_mounts.map((n) => String(n).trim()).filter(Boolean)
        : [],
      note: h?.note ? String(h.note).trim() || null : null,
    })),
  };

  const text = serializeConfig(candidate);
  // Validated in the system temp dir, not next to the real config: a save that
  // was killed mid-flight used to leave `.hosts.json.validate-<pid>` files
  // littering config/. Relative paths inside the config resolve against the
  // project root rather than the file's own directory, so validating from
  // elsewhere changes nothing.
  const temp = join(tmpdir(), `gpustatus-validate-${process.pid}.json`);

  try {
    writeFileSync(temp, text, 'utf8');
    return { text, validated: loadConfig(temp) }; // throws on any validation error
  } finally {
    try {
      rmSync(temp, { force: true });
    } catch {
      /* best effort */
    }
  }
}

export function createApi(app) {
  const { state, db, auth, reloadConfig } = app;
  const config = () => app.config;

  return async function handle(req, res, url) {
    const { pathname, searchParams } = url;
    const now = Date.now();

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      res.end();
      return true;
    }

    // ------------------------------------------------------------- admin ---
    if (pathname.startsWith('/api/admin/')) {
      const cookies = parseCookies(req.headers.cookie);
      const token = cookies[SESSION_COOKIE];
      const authenticated = auth.enabled && auth.verifyToken(token, now);
      const ip = req.socket.remoteAddress ?? 'unknown';

      if (pathname === '/api/admin/session' && req.method === 'GET') {
        json(res, 200, {
          enabled: auth.enabled,
          authenticated,
          hint: auth.enabled
            ? null
            : '未设置管理密码。请在 config/hosts.json 的 admin 段设置 password 或 password_sha256 后重启服务。',
        });
        return true;
      }

      if (pathname === '/api/admin/login' && req.method === 'POST') {
        if (!auth.enabled) {
          json(res, 503, { error: '未配置管理密码' });
          return true;
        }
        if (auth.isLockedOut(ip, now)) {
          json(res, 429, { error: '尝试次数过多,请 15 分钟后再试' });
          return true;
        }

        let body;
        try {
          body = await readJsonBody(req);
        } catch (err) {
          json(res, 400, { error: err.message });
          return true;
        }

        if (!auth.verifyPassword(body.password)) {
          auth.noteFailure(ip, now);
          json(res, 401, { error: '密码错误' });
          return true;
        }

        auth.noteSuccess(ip);
        json(res, 200, { ok: true }, { 'Set-Cookie': auth.sessionCookie(auth.issueToken(now)) });
        return true;
      }

      if (pathname === '/api/admin/logout' && req.method === 'POST') {
        json(res, 200, { ok: true }, { 'Set-Cookie': auth.clearCookie() });
        return true;
      }

      // Everything below requires a session.
      if (!authenticated) {
        json(res, 401, { error: '未登录或会话已过期' });
        return true;
      }

      if (pathname === '/api/admin/config' && req.method === 'GET') {
        json(res, 200, publicAdminConfig(config()));
        return true;
      }

      if (pathname === '/api/admin/config' && req.method === 'PUT') {
        let body;
        try {
          body = await readJsonBody(req);
        } catch (err) {
          json(res, 400, { error: err.message });
          return true;
        }

        try {
          const { text, validated } = saveConfig(config(), body);

          // Keep one backup of the operator's hand-written file before the
          // first UI save replaces its comments with the standard ones.
          const backup = `${config().configPath}.bak`;
          if (!existsSync(backup)) {
            try {
              writeFileSync(backup, readFileSync(config().configPath, 'utf8'), 'utf8');
            } catch {
              /* backup is best effort */
            }
          }

          writeFileSync(config().configPath, text, 'utf8');
          reloadConfig(validated);
          json(res, 200, {
            ok: true,
            hosts: validated.hosts.length,
            backup: existsSync(backup) ? backup : null,
          });
        } catch (err) {
          json(res, 400, { error: String(err.message ?? err) });
        }
        return true;
      }

      json(res, 404, { error: 'not found' });
      return true;
    }

    if (req.method !== 'GET') {
      json(res, 405, { error: 'method not allowed' });
      return true;
    }

    switch (pathname) {
      case '/api/health':
        json(res, 200, {
          ok: true,
          version: 1,
          uptime_s: Math.round((now - state.startedAt) / 1000),
          last_poll_completed_at: state.lastPollCompletedAt,
          hosts: config().hosts.length,
          interval_ms: config().poll.intervalMs,
          db: db.filePath,
        });
        return true;

      case '/api/config':
        json(res, 200, {
          site: config().site,
          poll: config().poll,
          groups: [...new Set(config().hosts.map((h) => h.group).filter(Boolean))],
          hosts: config().hosts.map((h) => ({
            id: h.id,
            label: h.label,
            group: h.group,
            expect_gpus: h.expectGpus,
            disks: h.disks,
            note: h.note,
          })),
        });
        return true;

      case '/api/snapshot':
        json(res, 200, state.buildSnapshot());
        return true;

      case '/api/stream':
        handleStream(req, res, state);
        return true;

      case '/api/events': {
        const limit = Math.min(1000, Math.max(1, Number(searchParams.get('limit')) || 100));
        const hostId = searchParams.get('host');
        json(res, 200, { events: db.queryEvents({ limit, hostId: hostId || null }) });
        return true;
      }

      // ------------------------------------------------ usage / accounting --
      case '/api/usage': {
        const { from, to } = resolveWindow(searchParams, DAY_MS);
        const bucketSeconds = Math.max(0, Number(searchParams.get('bucket')) || 0);
        const rows = db.queryUsage({
          fromTs: from,
          toTs: to,
          hostId: searchParams.get('host') || null,
          username: searchParams.get('user') || null,
          bucketSeconds,
        });
        json(res, 200, { from, to, bucket_seconds: bucketSeconds, rows: rows.map(decorateUsage) });
        return true;
      }

      case '/api/usage/totals': {
        const { from, to } = resolveWindow(searchParams, 30 * DAY_MS);
        const rows = db.queryUsageTotals({
          fromTs: from,
          toTs: to,
          hostId: searchParams.get('host') || null,
        });
        json(res, 200, { from, to, rows: rows.map(decorateUsage) });
        return true;
      }

      case '/api/usage/users': {
        json(res, 200, { users: db.queryRecentUsers(now - 7 * DAY_MS) });
        return true;
      }

      // -------------------------------------------------------- history -----
      case '/api/history/gpu': {
        const hostId = searchParams.get('host');
        const gpuIndex = Number(searchParams.get('gpu'));
        if (!hostId || !Number.isInteger(gpuIndex)) {
          json(res, 400, { error: 'host and integer gpu parameters are required' });
          return true;
        }
        const { from, to } = resolveWindow(searchParams, 6 * HOUR_MS);
        json(res, 200, {
          host: hostId,
          gpu: gpuIndex,
          from,
          to,
          points: db.queryGpuHistory(hostId, gpuIndex, from, to),
        });
        return true;
      }

      case '/api/history/host': {
        const hostId = searchParams.get('host');
        if (!hostId) {
          json(res, 400, { error: 'host parameter is required' });
          return true;
        }
        const { from, to } = resolveWindow(searchParams, 6 * HOUR_MS);
        json(res, 200, { host: hostId, from, to, points: db.queryHostHistory(hostId, from, to) });
        return true;
      }

      default:
        return false;
    }
  };
}

/**
 * Convert stored integrals into the units people actually quote.
 *
 * The stored values are SI seconds, so GPU-hours is /3600 and memory is
 * converted from MiB-seconds to GiB-hours (MiB * s / 1024 / 3600).
 */
function decorateUsage(row) {
  return {
    ...row,
    gpu_hours: row.gpu_seconds === null ? null : Number((row.gpu_seconds / 3600).toFixed(4)),
    effective_gpu_hours:
      row.sm_gpu_seconds === null ? null : Number((row.sm_gpu_seconds / 3600).toFixed(4)),
    mem_gib_hours:
      row.mem_mib_seconds === null ? null : Number((row.mem_mib_seconds / 1024 / 3600).toFixed(4)),
  };
}
