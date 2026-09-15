#!/usr/bin/env node
/**
 * GPUStatus server entry point.
 *
 * One process does everything: polls the configured hosts over SSH, persists
 * samples and usage rollups to SQLite, and serves the JSON/SSE API plus the
 * built frontend. Nothing is installed on the monitored machines.
 *
 * Usage:
 *   node server/index.js [--config path/to/hosts.json] [--once] [--no-poll]
 */

import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';

import { loadConfig, resolveHostLabel } from './config.js';
import { Auth, generateSecret } from './auth.js';
import { Db } from './db.js';
import { Collector } from './collector.js';
import { State } from './state.js';
import { createApi } from './api.js';

// ----------------------------------------------------------------- CLI ------
function parseArgs(argv) {
  const args = { config: null, once: false, poll: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--config') args.config = argv[++i];
    else if (a === '--once') args.once = true;
    else if (a === '--no-poll') args.poll = false;
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(`GPUStatus

  --config <path>   config file (default config/hosts.json)
  --once            run a single poll cycle, print a summary, exit
  --no-poll         serve the API without polling (for frontend development)
  --help            this message
`);
  process.exit(0);
}

const log = (...parts) => {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}]`, ...parts);
};

// ------------------------------------------------------------- startup ------
let config;
try {
  config = loadConfig(args.config);
} catch (err) {
  console.error(String(err.message ?? err));
  process.exit(1);
}

log(`config        ${config.configPath}`);
if (config.usingExample) {
  log('');
  log('  NOTE: config/hosts.json was not found, so the bundled EXAMPLE config is in use.');
  log('        It lists sample hosts (gpu01, gpu02) that do not exist here.');
  log('        Create your own:  cp config/hosts.example.json config/hosts.json');
  log('');
}
log(`hosts         ${config.hosts.map((h) => h.id).join(', ')}`);
log(`poll          every ${config.poll.intervalMs}ms (timeout ${config.poll.timeoutMs}ms)`);
log(`status        stale after ${config.poll.staleAfterMs}ms, down after ${config.poll.downAfterFailures} failures`);

const db = new Db(config.db.path, { intervalMs: config.poll.intervalMs });
db.registerHosts(config.hosts);
log(`database      ${db.filePath}`);

const collector = new Collector(config);
const state = new State(config);

// Session secret lives in the database so admin sessions survive a restart.
let sessionSecret = db.getMeta('session_secret');
if (!sessionSecret) {
  sessionSecret = generateSecret();
  db.setMeta('session_secret', sessionSecret);
}

/**
 * Everything the request handlers need, in one mutable object.
 *
 * A reload replaces `app.config` in place rather than rebuilding the process, so
 * open SSE streams and the poll schedule survive a configuration change.
 */
const app = {
  config,
  db,
  collector,
  state,
  auth: new Auth(config.admin, sessionSecret),
  reloadConfig: applyConfig,
};

/** Adopt a freshly loaded configuration without restarting. */
function applyConfig(next) {
  const previousIds = new Set(app.config.hosts.map((h) => h.id));
  const nextIds = new Set(next.hosts.map((h) => h.id));

  app.config = next;
  collector.config = next;
  app.auth = new Auth(next.admin, sessionSecret);

  state.applyConfig(next);
  db.registerHosts(next.hosts);

  const added = [...nextIds].filter((id) => !previousIds.has(id));
  const removed = [...previousIds].filter((id) => !nextIds.has(id));
  log(
    `config reloaded: ${next.hosts.length} hosts` +
      (added.length ? `, added ${added.join(',')}` : '') +
      (removed.length ? `, removed ${removed.join(',')}` : '') +
      `, interval ${next.poll.intervalMs}ms`,
  );

  state.notify('config');
}

// Status transitions are reported from exactly one place, so the event log
// cannot miss one whether it was caused by a poll result or by the simple
// passage of time (a stalled poller).
state.onTransition((transition, entry) => {
  try {
    db.recordEvent(transition.ts, transition.hostId, transition.kind, transition.message);
  } catch (err) {
    log(`ERROR recording event for ${transition.hostId}: ${err.message}`);
  }
  log(`${state.labelFor(entry.host.id)}: ${transition.kind} (${transition.from} -> ${transition.to}) - ${transition.message}`);
});

const MAX_EVENT_HISTORY = 500;

/** Poll every host in parallel and fold the results into state and storage. */
async function pollCycle() {
  const started = Date.now();

  await Promise.allSettled(
    app.config.hosts.map(async (host) => {
      const result = await collector.collect(host);

      if (result.ok && result.sample) {
        try {
          // Resolve the display name from the hostname this very poll reported,
          // so a newly added machine is named correctly on its first sample
          // instead of showing a placeholder for a cycle.
          db.recordSuccess(host.id, {
            ...result.sample,
            label: resolveHostLabel(host, result.sample.hostname, app.config.naming),
          });
        } catch (err) {
          // A storage failure must not be reported as a healthy host, but the UI
          // should still show the freshly collected data.
          log(`ERROR storing sample for ${host.id}: ${err.message}`);
          db.recordEvent(Date.now(), host.id, 'storage_error', String(err.message).slice(0, 300));
        }
      } else {
        try {
          db.recordFailure(host.id, Date.now(), result.error ?? 'unknown error');
        } catch (err) {
          log(`ERROR recording failure for ${host.id}: ${err.message}`);
        }
      }

      state.applyResult(host.id, result);
      if (!result.ok) log(`${host.id}: poll failed (${result.durationMs}ms) - ${result.error}`);
    }),
  );

  state.cycleComplete();
  return Date.now() - started;
}

// -------------------------------------------------------------- pollers -----
let pollTimer = null;
let statusTimer = null;
let pruneTimer = null;
let running = true;

async function pollLoop() {
  if (!running) return;
  let elapsed = 0;
  try {
    elapsed = await pollCycle();
  } catch (err) {
    log(`ERROR poll cycle failed: ${err.message}`);
  }
  if (!running) return;
  // Schedule after completion rather than on a fixed interval: a slow cycle
  // must not let the next one start on top of it.
  const delay = Math.max(50, app.config.poll.intervalMs - elapsed);
  pollTimer = setTimeout(pollLoop, delay);
}

function prune() {
  try {
    const removed = db.pruneRaw(app.config.db.rawRetentionHours);
    if (removed > 0) log(`pruned ${removed} raw rows older than ${app.config.db.rawRetentionHours}h`);
  } catch (err) {
    log(`ERROR pruning: ${err.message}`);
  }
}

// ----------------------------------------------------------------- HTTP -----
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

const webDist = config.server.webDist;
const api = createApi(app);

/**
 * Serve the built frontend. Any unknown non-API path falls back to index.html so
 * client-side routes work on refresh.
 */
function serveStatic(req, res, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    res.writeHead(400).end('bad request');
    return;
  }

  // Containment check: normalize away any `..` before joining, then verify the
  // result is still inside webDist. Without this, `/../../etc/passwd` escapes.
  const safePath = normalize(decoded).replace(/^(\.\.[/\\])+/, '');
  let filePath = join(webDist, safePath);
  if (!filePath.startsWith(webDist + sep) && filePath !== webDist) {
    res.writeHead(403).end('forbidden');
    return;
  }

  let isFile = false;
  try {
    isFile = statSync(filePath).isFile();
  } catch {
    isFile = false;
  }
  if (!isFile) {
    filePath = join(webDist, 'index.html');
    if (!existsSync(filePath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(
        'GPUStatus API is running, but the frontend has not been built.\n\n' +
          '  npm --prefix web install\n  npm run build\n\n' +
          `Expected: ${webDist}/index.html\n`,
      );
      return;
    }
  }

  const ext = extname(filePath).toLowerCase();
  const headers = {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    'Access-Control-Allow-Origin': '*',
  };
  // Hashed asset filenames are safe to cache forever; index.html must not be.
  headers['Cache-Control'] =
    ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable';

  res.writeHead(200, headers);
  createReadStream(filePath).pipe(res);
}

const server = createServer((req, res) => {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  } catch {
    res.writeHead(400).end('bad request');
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    Promise.resolve(api(req, res, url))
      .then((handled) => {
        if (!handled && !res.writableEnded) {
          res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'not found' }));
        }
      })
      .catch((err) => {
        log(`ERROR handling ${url.pathname}: ${err.stack ?? err.message}`);
        if (!res.writableEnded) {
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'internal error' }));
        }
      });
    return;
  }

  serveStatic(req, res, url.pathname);
});

// ------------------------------------------------------------- shutdown -----
function shutdown(signal) {
  if (!running) return;
  running = false;
  log(`${signal} received, shutting down`);
  clearTimeout(pollTimer);
  clearInterval(statusTimer);
  clearInterval(pruneTimer);

  server.close(() => {
    try {
      db.close();
    } catch {
      /* already closed */
    }
    log('bye');
    process.exit(0);
  });

  // Don't hang forever on a keep-alive connection (SSE clients hold one open).
  setTimeout(() => {
    try {
      db.close();
    } catch {
      /* already closed */
    }
    process.exit(0);
  }, 2000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => log(`WARN unhandled rejection: ${err}`));

// ---------------------------------------------------------------- start -----
if (args.once) {
  // Smoke-test mode: one cycle, human-readable summary, no server.
  const elapsed = await pollCycle();
  const snapshot = state.buildSnapshot();
  for (const host of snapshot.hosts) {
    const gpus = host.gpus.map((g) => `${g.index}:${g.util ?? '-'}%`).join(' ');
    // Show the resolved display name, plus the config id when they differ.
    const name = host.label === host.id ? host.id : `${host.label} (${host.id})`;
    log(
      `${name.padEnd(20)} ${host.status.padEnd(7)} cpu=${host.cpu?.pct?.toFixed(1) ?? '-'}% ` +
        `mem=${host.mem?.pct?.toFixed(1) ?? '-'}% gpus=${host.gpus.length} [${gpus}] ` +
        `users=${host.users.map((u) => u.username).join(',') || '-'}`,
    );
    for (const u of host.users) {
      log(`    ${u.username}: ${u.gpu_count} GPU(s) [${u.gpus.join(',')}] ${u.mem_mib} MiB sm~${u.sm_pct_avg}%`);
    }
    if (host.warnings.length) log(`    warnings: ${host.warnings.join(', ')}`);
    if (host.last_error) log(`    last_error: ${host.last_error}`);
  }
  log(`cycle took ${elapsed}ms`);
  db.close();
  process.exit(0);
}

server.listen(config.server.port, config.server.bind, () => {
  log(`listening     http://${config.server.bind}:${config.server.port}`);
  log(`frontend      ${existsSync(join(webDist, 'index.html')) ? webDist : '(not built - API only)'}`);
});

if (args.poll) {
  pollLoop();
  // Recompute statuses on a timer so a wedged poller still turns hosts yellow.
  // Transitions are logged via state.onTransition(); the UI only needs a push
  // when the picture actually changed.
  statusTimer = setInterval(() => {
    if (state.refreshStatuses().length > 0) state.notify('status');
  }, 1000);
  pruneTimer = setInterval(prune, 10 * 60_000);
  prune();
} else {
  log('polling       disabled (--no-poll)');
}
