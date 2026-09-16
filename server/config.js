/**
 * Configuration loading and validation.
 *
 * The config file is JSONC (JSON with comments and trailing commas) because it
 * is meant to be edited by operators, and the ability to annotate hosts is
 * worth the ~30 lines of preprocessing below.
 */

import { existsSync, readFileSync } from 'node:fs';
import { parse, printParseErrorCode } from 'jsonc-parser';
import { RawConfigSchema, formatConfigIssues } from './config-schema.ts';
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
/**
 * Parse JSON-with-comments into a value.
 *
 * Delegates to `jsonc-parser`, the implementation VS Code uses for the same job.
 * This was hand-written (a ~60-line character state machine). It passed every
 * adversarial case thrown at it, but "my parser is correct" is not a claim worth
 * maintaining when a battle-tested one is one import away.
 *
 * The library also reports WHERE a problem is, which is what makes a broken
 * config file diagnosable instead of just "unexpected token".
 */
/** 1-based line/column for a character offset, for a human-readable error. */
function offsetToLineColumn(text, offset) {
  const upto = text.slice(0, offset);
  // 0-based, like most editors' internals; the caller adds 1 for display.
  return {
    line: upto.split('\n').length - 1,
    column: offset - (upto.lastIndexOf('\n') + 1),
  };
}

export function parseJsonc(text) {
  const errors = [];
  const value = parse(text, errors, {
    allowTrailingComma: true,
    disallowComments: false,
    allowEmptyContent: false,
  });

  if (errors.length > 0) {
    const { error, offset } = errors[0];
    const { line, column } = offsetToLineColumn(text, offset);
    throw new Error(
      `${printParseErrorCode(error)} at offset ${offset} (line ${line + 1}, column ${column + 1})`,
    );
  }
  return value;
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

/**
 * Apply a default for an absent numeric setting.
 *
 * This used to validate as well (finite, above a floor, truncated). That is now
 * RawConfigSchema's job, and doing it twice meant two sets of error messages
 * that could disagree -- so this is only the default.
 */
function withDefault(value, fallback) {
  return value === undefined || value === null ? fallback : value;
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

  let document;
  try {
    document = parseJsonc(raw);
  } catch (err) {
    throw new Error(`Cannot parse ${path} as JSONC: ${err.message}`);
  }

  // Validate the whole file at once and report EVERY problem, rather than
  // throwing on the first one. Fixing a config used to take one restart per
  // mistake; now the list is complete on the first run.
  //
  // The document is validated as written -- no defaults, no renaming -- because
  // `raw` is kept below so an admin-page save can re-emit sections it does not
  // edit without substituting resolved values.
  const checked = RawConfigSchema.safeParse(document);
  if (!checked.success) {
    throw new Error(
      `Configuration error in ${path}:\n${formatConfigIssues(checked.error.issues)}`,
    );
  }
  const parsed = checked.data;

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
  // Shape and level were validated by RawConfigSchema; this only decides whether
  // there is anything worth showing.
  let announcement = null;
  if (parsed.announcement) {
    const a = parsed.announcement;
    const level = a.level ?? 'info';
    const body = a.body ?? '';
    const title = a.title ?? '';
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
  const gpuNames = {};
  for (const [raw, shown] of Object.entries(parsed.gpu_names ?? {})) {
    gpuNames[raw] = shown;
  }

  const diskExclude = (parsed.disk_exclude ?? ['/', '/boot/efi'])
    .map((d) => d.trim())
    .filter(Boolean);

  // Everything below is normalisation, not validation: RawConfigSchema has
  // already guaranteed the ids exist, are unique and well-formed, and that the
  // path lists are arrays of absolute paths without newlines.
  const hosts = parsed.hosts.map((h) => {
    const id = h.id;
    const target = h.ssh;
    const expectGpus = h.expect_gpus ?? null;

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
    const disks = h.disks == null ? null : h.disks.map((d) => d.trim()).filter(Boolean);

    // Network mounts to health-check on this machine (NFS/CIFS/...).
    //
    // These are NOT disk-usage entries: their capacity belongs to the server, so
    // reporting it per machine would print the same figure on every row.
    // Listing them here is what makes "this machine failed to mount /share"
    // detectable -- discovery alone is silent about a mount that is absent.
    // Auto-discovered network mounts are always checked as well.
    const netMounts = (h.net_mounts ?? []).map((d) => d.trim()).filter(Boolean);

    return {
      id,
      // null means "name this machine after the hostname it reports", which
      // keeps new machines zero-config. An explicit label always wins.
      label: h.label || null,
      ssh: target,
      group: h.group || null,
      expectGpus,
      disks,
      netMounts,
      note: h.note || null,
    };
  });

  // Note: interval/timeout are intentionally unclamped at the low end beyond a
  // sane floor, since a too-fast interval would open a new SSH session per host
  // faster than the remote can answer.
  const intervalMs = withDefault(poll.interval_ms, 5000);
  const timeoutMs = withDefault(poll.timeout_ms, 9000);
  const staleAfterMs = withDefault(poll.stale_after_ms, Math.max(intervalMs * 3, 15000), {
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
      port: withDefault(server.port, 8787),
      bind: server.bind ? String(server.bind) : '0.0.0.0',
      webDist: resolvePath(server.web_dist, 'web/dist'),
    },
    poll: {
      intervalMs,
      timeoutMs,
      staleAfterMs,
      downAfterFailures: withDefault(poll.down_after_failures, 3),
    },
    ssh: {
      user: ssh.user ? String(ssh.user).trim() : '',
      controlPersistS: withDefault(ssh.control_persist_s, 60),
      connectTimeoutS: withDefault(ssh.connect_timeout_s, 6),
      extraOptions: Array.isArray(ssh.extra_options) ? ssh.extra_options.map(String) : [],
    },
    db: {
      path: resolvePath(db.path, 'data/gpustatus.db'),
      rawRetentionHours: withDefault(db.raw_retention_hours, 168),
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
      sessionHours: withDefault(admin.session_hours, 12),
    },
    hosts,
  };
}
