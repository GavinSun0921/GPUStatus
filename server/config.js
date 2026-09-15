/**
 * Configuration loading and validation.
 *
 * The config file is JSONC (JSON with comments and trailing commas) because it
 * is meant to be edited by operators, and the ability to annotate hosts is
 * worth the ~30 lines of preprocessing below.
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = resolve(HERE, '..');

/**
 * Strip // and /* *\/ comments plus trailing commas from a JSONC document.
 *
 * This is a character scanner rather than a regex on purpose: a naive regex
 * would corrupt any string containing `//` (e.g. a URL or a path), so string
 * and escape state is tracked explicitly.
 */
export function parseJsonc(text) {
  let out = '';
  let inString = false;
  let inLine = false;
  let inBlock = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (inLine) {
      if (ch === '\n') {
        inLine = false;
        out += ch;
      }
      continue;
    }
    if (inBlock) {
      if (ch === '*' && next === '/') {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += ch;
      if (ch === '\\') {
        // Copy the escaped character verbatim so `\"` does not end the string.
        if (next !== undefined) {
          out += next;
          i++;
        }
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === '/' && next === '/') {
      inLine = true;
      i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlock = true;
      i++;
      continue;
    }
    out += ch;
  }

  // Drop trailing commas: a comma followed only by whitespace and a closer.
  return out.replace(/,(\s*[}\]])/g, '$1');
}

function fail(msg) {
  throw new Error(`Configuration error: ${msg}`);
}

/**
 * Turn a probed hostname into a display name.
 *
 *   server19.example.com  ->  Server19
 *   gpu-node-01.example.com  ->  Gpu-Node-01
 *   A100-node2               ->  A100-Node2   (existing case preserved)
 *   192.0.2.1                ->  192.0.2.1    (an IP has no domain to strip)
 *
 * Only the first letter of the name and of each `-`/`_` segment is upper-cased;
 * the rest is left alone so that mixed-case hostnames such as `A100` survive.
 * Dots are not capitalised, so keeping the domain (`stripDomain: false`) does not
 * produce `Server19.Ipa.Npu-Cvr.Cn`.
 *
 * Returns null when no usable name can be derived, so the caller can fall back
 * to the configured host id.
 */
export function deriveHostLabel(hostname, { stripDomain = true, capitalize = true } = {}) {
  if (!hostname) return null;

  let name = String(hostname).trim().replace(/\.+$/, ''); // drop trailing root dot
  if (!name) return null;

  // An IPv4 literal has no domain component and nothing worth capitalising.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(name)) return name;

  if (stripDomain) {
    const first = name.split('.')[0];
    if (first) name = first;
  }
  if (!capitalize) return name;

  // Capitalise only within the host part, so keeping the domain yields
  // "Server19.example.com" rather than "Server19.Ipa.Npu-Cvr.Cn".
  const dot = name.indexOf('.');
  const head = dot === -1 ? name : name.slice(0, dot);
  const tail = dot === -1 ? '' : name.slice(dot);
  return head.replace(/(^|[-_])([a-z])/g, (_match, sep, ch) => sep + ch.toUpperCase()) + tail;
}

/**
 * The name to show for a host.
 *
 * Precedence: an explicit `label` in the config, then the hostname reported by
 * the machine itself, then the configured id. Deriving from the hostname means a
 * newly added machine is named correctly with no configuration, which is the
 * whole point of the probe reporting it.
 */
export function resolveHostLabel(host, hostname, naming) {
  if (host.label) return host.label;
  return deriveHostLabel(hostname, naming) ?? host.id;
}

function intOr(value, fallback, { min = 0, name } = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min) {
    fail(`${name ?? 'value'} must be a number >= ${min}, got ${JSON.stringify(value)}`);
  }
  return Math.trunc(n);
}

/** Resolve a config-relative path against the project root. */
function resolvePath(p, fallback) {
  const value = p && String(p).trim() ? String(p).trim() : fallback;
  return isAbsolute(value) ? value : resolve(PROJECT_ROOT, value);
}

/**
 * Render a config object back to the on-disk JSONC document.
 *
 * The admin page saves through this, so the file keeps its explanatory comments
 * instead of degrading into a bare JSON dump. It does mean hand-written comments
 * are replaced by the standard ones -- index.js takes a backup before the first
 * overwrite for that reason.
 *
 * Sections the admin UI does not edit (server, ssh, db) are re-emitted from
 * `config.raw`, i.e. exactly what the operator originally wrote. Emitting the
 * RESOLVED values instead would silently rewrite a relative "data/gpustatus.db"
 * into an absolute machine-specific path.
 */
export function serializeConfig(config) {
  const j = (v) => JSON.stringify(v);
  const raw = config.raw ?? {};
  const rawServer = raw.server ?? {};
  const rawSsh = raw.ssh ?? {};
  const rawDb = raw.db ?? {};

  const hostBlocks = config.hosts.map((h) => {
    const fields = [`      "id": ${j(h.id)}`];
    if (h.label) fields.push(`      "label": ${j(h.label)}`);
    fields.push(`      "ssh": ${j(h.ssh)}`);
    if (h.group) fields.push(`      "group": ${j(h.group)}`);
    if (h.expectGpus !== null && h.expectGpus !== undefined) {
      fields.push(`      "expect_gpus": ${h.expectGpus}`);
    }
    if (Array.isArray(h.disks)) {
      // Written even when empty, because "ticked nothing" is a real choice that
      // must survive a save rather than reverting to "show everything".
      fields.push(
        `      // 要统计展示的目录(在管理页勾选;不写这一项 = 显示全部自动发现项)\n` +
          `      "disks": ${j(h.disks)}`,
      );
    }
    if (h.note) {
      fields.push(`      // 该机单独的通告,显示在这台机器的卡片上\n      "note": ${j(h.note)}`);
    }
    if (h.netMounts && h.netMounts.length) {
      fields.push(
        `      // 网络挂载(NFS 等):只检查是否健康挂载,不统计容量\n` +
          `      "net_mounts": ${j(h.netMounts)}`,
      );
    }
    return `    {\n${fields.join(',\n')}\n    }`;
  });

  let adminBlock = '';
  if (config.admin.passwordSha256) {
    adminBlock = `    "password_sha256": ${j(config.admin.passwordSha256)},\n`;
  } else if (config.admin.password) {
    adminBlock = `    "password": ${j(config.admin.password)},\n`;
  }

  return `{
  // ===========================================================================
  //  GPUStatus configuration
  //  JSON with comments (JSONC); trailing commas are allowed.
  //
  //  The admin page (/admin) regenerates this file on save, so hand-written
  //  comments are replaced by these standard ones. A one-time backup is kept
  //  next to it as hosts.json.bak.
  //
  //  Adding a machine requires NO action on that machine: the collector logs in
  //  over SSH, runs a read-only shell probe, and the target stays untouched.
  // ===========================================================================

  // Name of this installation, shown in the page header. Leave empty to fall
  // back to "GPUStatus".
  "site": ${j(config.site ?? '')},

  "server": {
    "port": ${j(rawServer.port ?? config.server.port)},
    "bind": ${j(rawServer.bind ?? config.server.bind)},
    "web_dist": ${j(rawServer.web_dist ?? 'web/dist')}
  },

  "poll": {
    "interval_ms": ${config.poll.intervalMs},
    "timeout_ms": ${config.poll.timeoutMs},
    // No successful sample for this long => status turns YELLOW.
    "stale_after_ms": ${config.poll.staleAfterMs},
    // This many consecutive failures => status turns RED.
    "down_after_failures": ${config.poll.downAfterFailures}
  },

  "ssh": {
    "user": ${j(rawSsh.user ?? config.ssh.user)},
    "control_persist_s": ${j(rawSsh.control_persist_s ?? config.ssh.controlPersistS)},
    "connect_timeout_s": ${j(rawSsh.connect_timeout_s ?? config.ssh.connectTimeoutS)},
    "extra_options": ${j(rawSsh.extra_options ?? config.ssh.extraOptions)}
  },

  "db": {
    "path": ${j(rawDb.path ?? 'data/gpustatus.db')},
    "raw_retention_hours": ${j(rawDb.raw_retention_hours ?? config.db.rawRetentionHours)}
  },

  // Site-wide announcement shown above the dashboard. Multi-line body; bare
  // http(s) links are turned into clickable links by the UI.
  // Set "enabled": false (or clear the text) to hide it.
  "announcement": {
    "enabled": ${config.announcement ? 'true' : 'false'},
    "level": ${j(config.announcement?.level ?? 'info')},
    "title": ${j(config.announcement?.title ?? '')},
    "body": ${j(config.announcement?.body ?? '')}
  },

  // Friendly GPU names, keyed by the exact string nvidia-smi reports. Anything
  // not listed falls back to a shortened form of the raw name.
  "gpu_names": ${j(config.gpuNames ?? {}, null, 2).replace(/\n/g, '\n  ')},

  // Mount points filtered out on every machine. "/" is the OS disk and
  // "/boot/efi" is firmware; neither reflects whether a job can write data.
  // Set to [] to report every local filesystem again.
  "disk_exclude": ${j(config.diskExclude ?? [])},

  // Display names are derived from each machine's own hostname:
  //   server19.example.com -> Server19
  // Set an explicit "label" on a host to override this.
  "naming": {
    "strip_domain": ${config.naming.stripDomain},
    "capitalize": ${config.naming.capitalize}
  },

  // Password for the admin page. Prefer "password_sha256"; generate it with:
  //   node -e "console.log(require('crypto').createHash('sha256').update('你的密码').digest('hex'))"
  //
  // Leave BOTH unset to keep the admin page disabled. A placeholder default is
  // deliberately NOT written: emitting "change-me" would quietly enable the page
  // behind a publicly known password.
  //
  // The admin page cannot change this -- edit the file and restart, so a lost
  // password is always recoverable without the UI.
  "admin": {
${adminBlock}    "session_hours": ${config.admin.sessionHours}
  },

  "hosts": [
${hostBlocks.join(',\n')}
  ]
}
`;
}

export function loadConfig(configPath) {
  const preferred = configPath
    ? resolve(process.cwd(), configPath)
    : resolve(PROJECT_ROOT, 'config/hosts.json');

  // `config/hosts.json` is gitignored because it holds real hostnames and the
  // admin password hash. A fresh clone therefore has only the sanitised example,
  // so fall back to it rather than refusing to start -- the UI comes up with the
  // sample hosts and the operator copies the file to begin.
  let path = preferred;
  let usingExample = false;
  if (!configPath && !existsSync(preferred)) {
    const example = resolve(PROJECT_ROOT, 'config/hosts.example.json');
    if (existsSync(example)) {
      path = example;
      usingExample = true;
    }
  }

  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`Cannot read config file ${path}: ${err.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(parseJsonc(raw));
  } catch (err) {
    throw new Error(`Cannot parse ${path} as JSONC: ${err.message}`);
  }

  const server = parsed.server ?? {};
  const poll = parsed.poll ?? {};
  const ssh = parsed.ssh ?? {};
  const db = parsed.db ?? {};
  const naming = parsed.naming ?? {};
  const admin = parsed.admin ?? {};

  // Mount points never worth reporting, overridable but defaulted.
  //
  // "/" is the OS disk and "/boot/efi" is a few hundred MB of firmware: neither
  // says anything about whether a GPU job can write its data, and both crowded
  // out the actual data volumes. They are filtered in the PROBE, so they are
  // never collected, never stored and never offered in the admin page.
  //
  // Kept configurable rather than hardcoded: if a root filesystem ever fills up
  // and breaks a machine, the fix must not require editing source.
  // Site-wide announcement shown above the dashboard.
  //
  // Optional, and disabled unless explicitly turned on: an announcement that
  // silently appears from a config default is worse than none.
  let announcement = null;
  if (parsed.announcement !== undefined && parsed.announcement !== null) {
    const a = parsed.announcement;
    if (typeof a !== 'object' || Array.isArray(a)) fail('announcement must be an object');
    const level = a.level === undefined ? 'info' : String(a.level);
    if (!['info', 'warning', 'error'].includes(level)) {
      fail(`announcement.level must be info, warning or error (got "${level}")`);
    }
    const body = a.body === undefined || a.body === null ? '' : String(a.body);
    const title = a.title === undefined || a.title === null ? '' : String(a.title);
    if (a.enabled !== false && (body.trim() || title.trim())) {
      announcement = { level, title, body };
    }
  }

  // Friendly names for GPU models, keyed by the exact string nvidia-smi reports.
  //
  // nvidia-smi names are long and inconsistent ("NVIDIA GeForce RTX 4090" vs
  // "NVIDIA RTX 5880 Ada Generation"), which does not fit a table column. The
  // map is applied on the SERVER so every consumer -- UI, API, exports -- shows
  // the same name. Anything unmapped falls back to a cleaned-up short form.
  let gpuNames = {};
  if (parsed.gpu_names !== undefined && parsed.gpu_names !== null) {
    if (typeof parsed.gpu_names !== 'object' || Array.isArray(parsed.gpu_names)) {
      fail('gpu_names must be an object mapping nvidia-smi names to display names');
    }
    for (const [raw, shown] of Object.entries(parsed.gpu_names)) {
      gpuNames[String(raw)] = String(shown);
    }
  }

  let diskExclude = ['/', '/boot/efi'];
  if (parsed.disk_exclude !== undefined && parsed.disk_exclude !== null) {
    if (!Array.isArray(parsed.disk_exclude)) {
      fail('disk_exclude must be an array of mount points');
    }
    diskExclude = parsed.disk_exclude.map((d) => String(d).trim()).filter(Boolean);
  }

  if (!Array.isArray(parsed.hosts) || parsed.hosts.length === 0) {
    fail(`${path}: "hosts" must be a non-empty array`);
  }

  const seen = new Set();
  const hosts = parsed.hosts.map((h, i) => {
    if (!h || typeof h !== 'object') fail(`hosts[${i}] must be an object`);

    const id = String(h.id ?? '').trim();
    const target = String(h.ssh ?? '').trim();
    if (!id) fail(`hosts[${i}] is missing "id"`);
    if (!target) fail(`host "${id}" is missing "ssh"`);
    if (!/^[A-Za-z0-9._@-]+$/.test(id)) {
      fail(`host id "${id}" may only contain letters, digits, dot, dash, underscore`);
    }
    if (seen.has(id)) fail(`duplicate host id "${id}"`);
    seen.add(id);

    const expectGpus = h.expect_gpus === undefined || h.expect_gpus === null
      ? null
      : intOr(h.expect_gpus, null, { min: 0, name: `host "${id}" expect_gpus` });

    // Directories whose free space matters on THIS machine.
    //
    // Three distinct states, and the difference matters:
    //   key absent -> null  : never configured, so show EVERYTHING discovered
    //   "disks": []         : explicitly ticked nothing, so show nothing
    //   "disks": ["/home"]  : show exactly these
    //
    // The probe always auto-discovers every mounted filesystem, so the admin
    // page can offer them as checkboxes; this list only selects among them.
    // A path that is not a mount point (e.g. /data living on the / volume) is
    // still probed, which is how subdirectories can be tracked separately.
    let disks = null;
    if (h.disks !== undefined && h.disks !== null) {
      if (!Array.isArray(h.disks)) fail(`host "${id}" disks must be an array of paths`);
      disks = h.disks.map((d) => String(d).trim()).filter(Boolean);
      for (const d of disks) {
        if (!d.startsWith('/')) fail(`host "${id}" disk path must be absolute: "${d}"`);
        if (d.includes('\n')) fail(`host "${id}" disk path may not contain a newline`);
      }
    }

    // Network mounts to health-check on this machine (NFS/CIFS/...).
    //
    // These are NOT disk-usage entries: their capacity belongs to the server, so
    // reporting it per machine would print the same figure on every row.
    // Listing them here is what makes "this machine failed to mount /share"
    // detectable -- discovery alone is silent about a mount that is absent.
    // Auto-discovered network mounts are always checked as well.
    let netMounts = [];
    if (h.net_mounts !== undefined && h.net_mounts !== null) {
      if (!Array.isArray(h.net_mounts)) fail(`host "${id}" net_mounts must be an array of paths`);
      netMounts = h.net_mounts.map((d) => String(d).trim()).filter(Boolean);
      for (const d of netMounts) {
        if (!d.startsWith('/')) fail(`host "${id}" net_mounts path must be absolute: "${d}"`);
        if (d.includes('\n')) fail(`host "${id}" net_mounts path may not contain a newline`);
      }
    }

    return {
      id,
      // null means "name this machine after the hostname it reports", which
      // keeps new machines zero-config. An explicit label always wins.
      label: h.label ? String(h.label) : null,
      ssh: target,
      group: h.group ? String(h.group) : null,
      expectGpus,
      disks,
      netMounts,
      note: h.note ? String(h.note) : null,
    };
  });

  // Note: interval/timeout are intentionally unclamped at the low end beyond a
  // sane floor, since a too-fast interval would open a new SSH session per host
  // faster than the remote can answer.
  const intervalMs = intOr(poll.interval_ms, 5000, { min: 500, name: 'poll.interval_ms' });
  const timeoutMs = intOr(poll.timeout_ms, 9000, { min: 1000, name: 'poll.timeout_ms' });
  const staleAfterMs = intOr(poll.stale_after_ms, Math.max(intervalMs * 3, 15000), {
    min: 1000,
    name: 'poll.stale_after_ms',
  });

  return {
    configPath: path,
    /** true when the example file was used because config/hosts.json is absent */
    usingExample,
    // Name of the lab / site this deployment belongs to. Shown once, prominently
    // in the header, rather than repeated as a group tag on every machine --
    // it describes the installation, not an individual host.
    site: parsed.site ? String(parsed.site).trim() : null,
    // The document exactly as written, so a UI save can re-emit the sections it
    // does not edit without substituting resolved (absolute) values.
    raw: parsed,
    server: {
      port: intOr(server.port, 8787, { min: 1, name: 'server.port' }),
      bind: server.bind ? String(server.bind) : '0.0.0.0',
      webDist: resolvePath(server.web_dist, 'web/dist'),
    },
    poll: {
      intervalMs,
      timeoutMs,
      staleAfterMs,
      downAfterFailures: intOr(poll.down_after_failures, 3, {
        min: 1,
        name: 'poll.down_after_failures',
      }),
    },
    ssh: {
      user: ssh.user ? String(ssh.user).trim() : '',
      controlPersistS: intOr(ssh.control_persist_s, 60, {
        min: 0,
        name: 'ssh.control_persist_s',
      }),
      connectTimeoutS: intOr(ssh.connect_timeout_s, 6, {
        min: 1,
        name: 'ssh.connect_timeout_s',
      }),
      extraOptions: Array.isArray(ssh.extra_options) ? ssh.extra_options.map(String) : [],
    },
    db: {
      path: resolvePath(db.path, 'data/gpustatus.db'),
      rawRetentionHours: intOr(db.raw_retention_hours, 168, {
        min: 0,
        name: 'db.raw_retention_hours',
      }),
    },
    naming: {
      stripDomain: naming.strip_domain !== false,
      capitalize: naming.capitalize !== false,
    },
    diskExclude,
    gpuNames,
    announcement,
    admin: {
      // Either a plaintext password or its SHA-256 hex digest. The digest is
      // preferred so the file does not contain the secret itself.
      password: admin.password ? String(admin.password) : null,
      passwordSha256: admin.password_sha256 ? String(admin.password_sha256).toLowerCase() : null,
      sessionHours: intOr(admin.session_hours, 12, { min: 1, name: 'admin.session_hours' }),
    },
    hosts,
  };
}
