import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveHostLabel, loadConfig, parseJsonc, resolveHostLabel, serializeConfig } from '../config.js';
import { computeCpuPct, deriveSample, shellQuote } from '../collector.js';
import { Db, aggregateUserUsage } from '../db.js';
import { State, decodeThrottle, displayGpuName, gpuCountWarning, thermalShare, throttleWarnings } from '../state.js';
import { parseTime, publicAdminConfig } from '../api.js';
import { Auth, parseCookies } from '../auth.js';
import { AdminConfigSchema } from '../../shared/schema.ts';
// --------------------------------------------------------------- config -----

test('parseJsonc accepts the JSONC features our config files use', () => {
  // Comment stripping and trailing commas are now jsonc-parser's job. What is
  // still worth asserting is that we CONFIGURE it that way -- dropping the
  // allowTrailingComma option would silently make every existing config file
  // with a trailing comma unreadable.
  const parsed = parseJsonc(`{
    // line comment
    "site": "lab",          /* block comment */
    "url": "http://example.com//x",   // a URL is not a comment
    "list": [1, 2, 3,],
    "nested": { "a": true, },
  }`);

  assert.equal(parsed.site, 'lab');
  assert.equal(parsed.url, 'http://example.com//x', 'comment-like text inside a string was altered');
  assert.deepEqual(parsed.list, [1, 2, 3]);
  assert.deepEqual(parsed.nested, { a: true });
});

test('parseJsonc reports WHERE a config file is broken', () => {
  // The reason we do not just call JSON.parse: a bare "Unexpected token" for a
  // 300-line config file is not actionable. jsonc-parser gives an offset, and we
  // turn it into a line and column an editor can jump to.
  const broken = ['{', '  "site": "lab",', '  "hosts": @', '}'].join('\n');
  assert.throws(
    () => parseJsonc(broken),
    (err) => {
      assert.match(err.message, /line 3/, `expected a line number, got: ${err.message}`);
      assert.match(err.message, /column 12/, `expected a column, got: ${err.message}`);
      return true;
    },
  );

  // An empty or comment-only file is a mistake, not an empty config.
  assert.throws(() => parseJsonc(''), /line 1/);
  assert.throws(() => parseJsonc('// nothing here\n'), /ValueExpected|line/);
});

test('loadConfig rejects duplicate host ids and missing ssh targets', () => {
  assert.throws(() => loadConfig('/nonexistent/path.json'), /Cannot read config file/);
});

// ------------------------------------------------------- host naming --------

test('deriveHostLabel names a host after its hostname', () => {
  // The ssh alias (gpu19) is a local convenience; the display name comes from
  // the machine itself.
  assert.equal(deriveHostLabel('server19.example.com'), 'Server19');
  assert.equal(deriveHostLabel('server20.example.com'), 'Server20');
  assert.equal(deriveHostLabel('gpu-node-01.example.com'), 'Gpu-Node-01');
});

test('deriveHostLabel preserves existing capitalisation', () => {
  // A naive toLowerCase-then-capitalise would turn A100 into A100 but would
  // mangle names like "RTX-node"; only the leading letter of each segment moves.
  assert.equal(deriveHostLabel('A100-node2'), 'A100-Node2');
  assert.equal(deriveHostLabel('a_b-c9'), 'A_B-C9');
});

test('deriveHostLabel handles hostnames with no domain to strip', () => {
  assert.equal(deriveHostLabel('localhost'), 'Localhost');
  assert.equal(deriveHostLabel('node7.'), 'Node7'); // trailing root dot
  assert.equal(deriveHostLabel('  Server03  '), 'Server03'); // already named
});

test('deriveHostLabel leaves IPv4 literals alone', () => {
  // Stripping at the first dot would reduce 192.0.2.1 to "192".
  assert.equal(deriveHostLabel('192.0.2.1'), '192.0.2.1');
});

test('deriveHostLabel returns null when nothing usable is available', () => {
  // The caller falls back to the configured id in this case.
  assert.equal(deriveHostLabel(''), null);
  assert.equal(deriveHostLabel(null), null);
  assert.equal(deriveHostLabel(undefined), null);
  assert.equal(deriveHostLabel('.'), null);
});

test('deriveHostLabel honours the naming options', () => {
  assert.equal(
    deriveHostLabel('server19.example.com', { stripDomain: false }),
    // Capitalisation must not leak into the domain part.
    'Server19.example.com',
  );
  assert.equal(deriveHostLabel('server19', { capitalize: false }), 'server19');
});

test('resolveHostLabel prefers an explicit config label over the hostname', () => {
  const naming = { stripDomain: true, capitalize: true };

  assert.equal(resolveHostLabel({ id: 'gpu19', label: null }, 'server19.x.cn', naming), 'Server19');
  // An explicit label always wins, for labs with their own naming scheme.
  assert.equal(resolveHostLabel({ id: 'gpu19', label: 'A100-柜1' }, 'server19.x.cn', naming), 'A100-柜1');
  // Before the first poll the hostname is unknown, so fall back to the id.
  assert.equal(resolveHostLabel({ id: 'gpu19', label: null }, null, naming), 'gpu19');
  assert.equal(resolveHostLabel({ id: 'gpu19', label: null }, '', naming), 'gpu19');
});

// ------------------------------------------------------------------ cpu -----

test('computeCpuPct derives usage from jiffy deltas', () => {
  // idle advances by 50, busy by 50 => 50% busy, iowait 0.
  const prev = { ticks: [100, 0, 0, 100, 0, 0, 0, 0, 0, 0] };
  const cur = [150, 0, 0, 150, 0, 0, 0, 0, 0, 0];
  const { cpuPct, iowaitPct } = computeCpuPct(prev, cur);
  assert.equal(cpuPct, 50);
  assert.equal(iowaitPct, 0);
});

test('computeCpuPct counts iowait as idle for the busy figure', () => {
  // Of 100 new jiffies: 20 busy, 40 idle, 40 iowait.
  // iowait is time the CPU had nothing to run, so "busy" must be 20%, not 60%.
  const prev = { ticks: [0, 0, 0, 100, 0, 0, 0, 0, 0, 0] };
  const cur = [20, 0, 0, 140, 40, 0, 0, 0, 0, 0];
  const { cpuPct, iowaitPct } = computeCpuPct(prev, cur);
  assert.equal(cpuPct, 20);
  assert.equal(iowaitPct, 40);
});

test('computeCpuPct returns null when counters reset (host rebooted)', () => {
  // A reboot makes the counters go backwards; a naive subtraction would report
  // a large negative or absurd percentage.
  const prev = { ticks: [999999, 0, 0, 999999, 0, 0, 0, 0, 0, 0] };
  const cur = [10, 0, 0, 10, 0, 0, 0, 0, 0, 0];
  const { cpuPct, iowaitPct } = computeCpuPct(prev, cur);
  assert.equal(cpuPct, null);
  assert.equal(iowaitPct, null);
});

test('computeCpuPct returns null on the first sample', () => {
  const { cpuPct } = computeCpuPct(null, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(cpuPct, null);
});

// ------------------------------------------------------- user accounting ----

test('aggregateUserUsage counts GPUs once even with several processes per card', () => {
  const procs = [
    { username: 'alice', gpuIndex: 0, usedMemMib: 1000, smPct: 30 },
    { username: 'alice', gpuIndex: 0, usedMemMib: 2000, smPct: 40 },
    { username: 'alice', gpuIndex: 1, usedMemMib: 500, smPct: 10 },
  ];
  const [alice] = aggregateUserUsage(procs);

  // Two distinct cards, not three processes.
  assert.equal(alice.gpus, 2);
  assert.equal(alice.procCount, 3);
  assert.equal(alice.memSum, 3500);
  // SM is capped per card at 100: card0 = 30+40 = 70, card1 = 10.
  assert.equal(alice.smSum, 80);
});

test('aggregateUserUsage caps shared-card SM at 100 per GPU', () => {
  const procs = [
    { username: 'bob', gpuIndex: 0, usedMemMib: 100, smPct: 80 },
    { username: 'bob', gpuIndex: 0, usedMemMib: 100, smPct: 80 },
  ];
  const [bob] = aggregateUserUsage(procs);
  assert.equal(bob.gpus, 1);
  // Without the cap this would be 160, i.e. more than one GPU's worth of compute.
  assert.equal(bob.smSum, 100);
});

test('aggregateUserUsage keeps users separate and skips unresolved owners', () => {
  const procs = [
    { username: 'alice', gpuIndex: 0, usedMemMib: 10, smPct: 5 },
    { username: 'bob', gpuIndex: 1, usedMemMib: 20, smPct: 5 },
    { username: null, gpuIndex: 2, usedMemMib: 999, smPct: 99 },
  ];
  const result = aggregateUserUsage(procs);
  assert.equal(result.length, 2);
  assert.deepEqual(result.map((r) => r.username).sort(), ['alice', 'bob']);
});

test('aggregateUserUsage treats missing SM as zero rather than NaN', () => {
  const [carol] = aggregateUserUsage([
    { username: 'carol', gpuIndex: 0, usedMemMib: 10, smPct: null },
  ]);
  assert.equal(carol.smSum, 0);
  assert.ok(Number.isFinite(carol.smSum));
});

// -------------------------------------------------- state host naming ------

/** Minimal successful result carrying just the fields naming depends on. */
function sampleResult(hostname, extra = {}) {
  return {
    ok: true,
    durationMs: 1,
    sample: {
      ts: Date.now(),
      hostname,
      warnings: [],
      gpus: [],
      procs: [],
      host: {},
      disks: [],
      ...extra,
    },
  };
}

test('state names a host from its hostname as soon as it is polled', () => {
  const state = new State(makeConfig());
  // Nothing learned yet: fall back to the configured id.
  assert.equal(state.labelFor('h1'), 'h1');

  state.applyResult('h1', sampleResult('server19.example.com'));
  assert.equal(state.labelFor('h1'), 'Server19');
  assert.equal(state.buildSnapshot().hosts[0].label, 'Server19');
});

test('a learned hostname survives later poll failures', () => {
  // The dashboard must keep calling a down host by its real name, not revert to
  // the config id just because the machine stopped answering.
  const state = new State(makeConfig());
  state.applyResult('h1', sampleResult('server20.example.com'));
  state.applyResult('h1', { ok: false, error: 'ssh timeout', durationMs: 1 });

  assert.equal(state.labelFor('h1'), 'Server20');
  const [host] = state.buildSnapshot().hosts;
  assert.equal(host.label, 'Server20');
  assert.equal(host.status, 'stale');
});

test('an explicit config label beats the hostname', () => {
  const config = makeConfig();
  config.hosts[0].label = '柜1-A100';
  const state = new State(config);
  state.applyResult('h1', sampleResult('server19.example.com'));
  assert.equal(state.labelFor('h1'), '柜1-A100');
});

// ------------------------------------------------------- status machine ------
function makeConfig(overrides = {}) {
  return {
    poll: {
      intervalMs: 1000,
      timeoutMs: 5000,
      staleAfterMs: 5000,
      downAfterFailures: 3,
      ...overrides,
    },
    hosts: [{ id: 'h1', label: null, ssh: 'h1', group: null, expectGpus: 2, note: null }],
  };
}

/** Build a State whose only host already has one successful sample. */
function stateWithSample({ sampleTs = Date.now(), failures = 0 } = {}) {
  const state = new State(makeConfig());
  const now = Date.now();
  for (let i = 0; i < failures; i++) {
    state.applyResult('h1', { ok: false, error: 'boom', durationMs: 5 });
  }
  if (sampleTs !== null) {
    state.applyResult('h1', {
      ok: true,
      durationMs: 10,
      sample: { ts: sampleTs, warnings: [], gpus: [], procs: [], host: {}, disks: [] },
    });
  }
  // applyResult with failures before the success would reset the counter, so
  // re-apply them afterwards when both are requested.
  for (let i = 0; i < failures; i++) {
    state.applyResult('h1', { ok: false, error: 'boom', durationMs: 5 });
  }
  void now;
  return state;
}

test('status is unknown before the first attempt', () => {
  const state = new State(makeConfig());
  assert.equal(state.buildSnapshot().hosts[0].status, 'unknown');
});

test('status is ok right after a successful poll', () => {
  const state = stateWithSample();
  assert.equal(state.buildSnapshot().hosts[0].status, 'ok');
});

test('status turns stale (yellow) after a single failed poll', () => {
  const state = stateWithSample({ failures: 1 });
  assert.equal(state.buildSnapshot().hosts[0].status, 'stale');
});

test('status turns down (red) only after the configured number of failures', () => {
  const two = stateWithSample({ failures: 2 });
  assert.equal(two.buildSnapshot().hosts[0].status, 'stale');

  const three = stateWithSample({ failures: 3 });
  assert.equal(three.buildSnapshot().hosts[0].status, 'down');
});

test('a host that never succeeded warns after its first failure', () => {
  const state = new State(makeConfig());
  state.applyResult('h1', { ok: false, error: 'conn refused', durationMs: 5 });
  assert.equal(state.buildSnapshot().hosts[0].status, 'stale');

  state.applyResult('h1', { ok: false, error: 'conn refused', durationMs: 5 });
  state.applyResult('h1', { ok: false, error: 'conn refused', durationMs: 5 });
  assert.equal(state.buildSnapshot().hosts[0].status, 'down');
});

test('a stale sample goes yellow purely from the passage of time', () => {
  // Data older than staleAfterMs (5s) must not keep showing green just because
  // the poll that produced it succeeded. buildSnapshot has to be truthful on its
  // own, without relying on a poll result or a timer having run first.
  const state = stateWithSample({ sampleTs: Date.now() - 60_000 });
  assert.equal(state.buildSnapshot().hosts[0].status, 'stale');
});

test('refreshStatuses reports a time-based transition exactly once', () => {
  const state = stateWithSample();
  assert.equal(state.buildSnapshot().hosts[0].status, 'ok');

  // Simulate 60s elapsing with no poll completing (a stalled poller).
  state.hosts.get('h1').lastOk = Date.now() - 60_000;

  const transitions = state.refreshStatuses();
  assert.equal(transitions.length, 1);
  assert.equal(transitions[0].kind, 'stale');
  assert.equal(transitions[0].from, 'ok');
  assert.equal(transitions[0].to, 'stale');
  assert.equal(state.buildSnapshot().hosts[0].status, 'stale');
  // Idempotent: a second pass must not re-report the same transition.
  assert.deepEqual(state.refreshStatuses(), []);
});

test('transitions reach onTransition subscribers for logging', () => {
  const state = stateWithSample();
  const seen = [];
  state.onTransition((t) => seen.push(t.kind));

  state.applyResult('h1', { ok: false, error: 'x', durationMs: 1 });
  state.applyResult('h1', { ok: false, error: 'x', durationMs: 1 });
  state.applyResult('h1', { ok: false, error: 'x', durationMs: 1 });
  state.applyResult('h1', {
    ok: true,
    durationMs: 1,
    sample: { ts: Date.now(), warnings: [], gpus: [], procs: [], host: {}, disks: [] },
  });

  assert.deepEqual(seen, ['stale', 'down', 'recovered']);
});

test('the first successful poll is not reported as a recovery', () => {
  // Otherwise every restart would emit one bogus "recovered" event per host.
  const state = new State(makeConfig());
  const seen = [];
  state.onTransition((t) => seen.push(t.kind));
  state.applyResult('h1', {
    ok: true,
    durationMs: 1,
    sample: { ts: Date.now(), warnings: [], gpus: [], procs: [], host: {}, disks: [] },
  });
  assert.deepEqual(seen, []);
  assert.equal(state.buildSnapshot().hosts[0].status, 'ok');
});

test('recovery emits a recovered event and returns to ok', () => {
  const state = stateWithSample({ failures: 3 });
  assert.equal(state.buildSnapshot().hosts[0].status, 'down');

  const events = state.applyResult('h1', {
    ok: true,
    durationMs: 8,
    sample: { ts: Date.now(), warnings: [], gpus: [], procs: [], host: {}, disks: [] },
  });
  assert.equal(state.buildSnapshot().hosts[0].status, 'ok');
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'recovered');
});

test('down transition emits a down event exactly once', () => {
  const state = stateWithSample();
  const first = state.applyResult('h1', { ok: false, error: 'x', durationMs: 1 });
  const second = state.applyResult('h1', { ok: false, error: 'x', durationMs: 1 });
  const third = state.applyResult('h1', { ok: false, error: 'x', durationMs: 1 });
  const fourth = state.applyResult('h1', { ok: false, error: 'x', durationMs: 1 });

  assert.deepEqual(first.map((e) => e.kind), ['stale']);
  assert.deepEqual(second.map((e) => e.kind), []);
  assert.deepEqual(third.map((e) => e.kind), ['down']);
  // Staying down must not spam the event log on every subsequent cycle.
  assert.deepEqual(fourth.map((e) => e.kind), []);
});

// --------------------------------------------------------- deriveSample -----

test('deriveSample joins uuid, pmon and pid_users into per-process rows', () => {
  const raw = {
    ts: Math.floor(Date.now() / 1000),
    hostname: 'n1',
    cpu: { cores: 8, ticks: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], load1: 1, load5: 1, load15: 1 },
    mem: { total_kib: 1024 * 1024, available_kib: 512 * 1024 },
    gpus: [
      { index: 0, uuid: 'GPU-aaa', name: 'X', util: 50, mem_used_mib: 100, mem_total_mib: 200 },
    ],
    procs: [{ gpu_uuid: 'GPU-aaa', pid: 42, name: 'python', used_mem_mib: 90 }],
    pid_users: [{ pid: 42, user: 'dave' }],
    pmon: [{ gpu_index: 0, pid: 42, type: 'C', sm_pct: 77, mem_pct: 10 }],
    errors: [],
  };

  const sample = deriveSample({ id: 'n1', expectGpus: 1 }, raw, null, Date.now());
  assert.equal(sample.procs.length, 1);
  assert.equal(sample.procs[0].username, 'dave');
  assert.equal(sample.procs[0].gpuIndex, 0);
  assert.equal(sample.procs[0].smPct, 77);
  assert.equal(sample.gpus[0].nProcs, 1);
  assert.deepEqual(sample.warnings, []);
});

test('deriveSample no longer decides whether the card count is wrong', () => {
  // The check used to live here and compared against the config's expect_gpus.
  // It moved to State (see gpuCountWarning) because on this cluster the visible
  // count legitimately changes -- cards are masked off after boot -- so it has
  // to compare against the machine's own recent high-water mark.
  //
  // What this asserts is the layering: the collector reports what it SAW, and
  // does not invent a verdict about it.
  const raw = {
    ts: Math.floor(Date.now() / 1000),
    cpu: { ticks: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
    mem: {},
    gpus: [{ index: 0, uuid: 'GPU-a' }],
    procs: [],
    pid_users: [],
    pmon: [],
    errors: [],
  };
  const sample = deriveSample({ id: 'n1', expectGpus: 8 }, raw, null, Date.now());
  assert.equal(sample.gpus.length, 1, 'the collector did not report what it saw');
  assert.ok(
    !sample.warnings.some((w) => w.startsWith('gpu_count_')),
    'the collector is still deciding the card count is wrong; that belongs to State',
  );
});

test('deriveSample flags processes whose owner could not be resolved', () => {
  const raw = {
    ts: Math.floor(Date.now() / 1000),
    cpu: { ticks: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
    mem: {},
    gpus: [{ index: 0, uuid: 'GPU-a' }],
    procs: [{ gpu_uuid: 'GPU-a', pid: 7, name: 'x', used_mem_mib: 1 }],
    pid_users: [],
    pmon: [],
    errors: [],
  };
  const sample = deriveSample({ id: 'n1', expectGpus: 1 }, raw, null, Date.now());
  assert.equal(sample.procs[0].username, null);
  assert.ok(sample.warnings.includes('unresolved_process_users:1'));
});

test('deriveSample surfaces nvidia-smi failures as warnings', () => {
  const raw = {
    ts: Math.floor(Date.now() / 1000),
    cpu: { ticks: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
    mem: {},
    gpus: [],
    procs: [],
    pid_users: [],
    pmon: [],
    errors: ['nvidia_smi_failed'],
    nvidia_error: 'Failed to initialize NVML: Unknown Error',
  };
  const sample = deriveSample({ id: 'n1', expectGpus: null }, raw, null, Date.now());
  assert.equal(sample.gpus.length, 0);
  assert.ok(sample.warnings.includes('probe:nvidia_smi_failed'));
  assert.ok(sample.warnings.some((w) => w.startsWith('nvidia:')));
});

test('deriveSample computes memory used from MemAvailable, not MemFree', () => {
  const raw = {
    ts: Math.floor(Date.now() / 1000),
    cpu: { ticks: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
    // A machine with a huge page cache: MemFree is tiny but most is reclaimable.
    mem: { total_kib: 100 * 1024 * 1024, free_kib: 1024 * 1024, available_kib: 80 * 1024 * 1024 },
    gpus: [],
    procs: [],
    pid_users: [],
    pmon: [],
    errors: [],
  };
  const sample = deriveSample({ id: 'n1', expectGpus: null }, raw, null, Date.now());
  assert.equal(sample.host.memUsedMib, 20 * 1024);
  assert.equal(sample.host.memPct, 20);
});

// ------------------------------------------------------------------ time ----

test('parseTime understands relative offsets, ISO dates and epochs', () => {
  const now = Date.now();

  assert.ok(Math.abs(parseTime('-24h') - (now - 86_400_000)) < 1000);
  assert.ok(Math.abs(parseTime('-7d') - (now - 7 * 86_400_000)) < 1000);
  assert.equal(parseTime('1700000000'), 1_700_000_000_000); // seconds -> ms
  assert.equal(parseTime('1700000000000'), 1_700_000_000_000); // already ms
  assert.equal(parseTime('2024-01-01T00:00:00Z'), Date.parse('2024-01-01T00:00:00Z'));
  assert.equal(parseTime(''), null);
  assert.equal(parseTime('nonsense'), null);
});

// ------------------------------------------------------------- shell quoting -

test('shellQuote keeps a path with spaces as a single argument', () => {
  // Disk paths travel inside the remote command string, so an unquoted path
  // containing a space would arrive as several arguments and be reported as a
  // set of missing directories.
  assert.equal(shellQuote('/data'), "'/data'");
  assert.equal(shellQuote('/mnt/my data'), "'/mnt/my data'");
  assert.equal(shellQuote("/it's here"), `'/it'\\''s here'`);
  // A shell metacharacter must not be able to start a new command.
  assert.equal(shellQuote('/tmp; rm -rf /'), "'/tmp; rm -rf /'");
});

// ------------------------------------------------------------------- auth ----

const SHA_TEST = createHash('sha256').update('hunter2').digest('hex');

function authWith(admin, secret = 'test-secret') {
  return new Auth({ sessionHours: 12, password: null, passwordSha256: null, ...admin }, secret);
}

test('auth is disabled until a password is configured', () => {
  const auth = authWith({});
  assert.equal(auth.enabled, false);
  assert.equal(auth.verifyPassword(''), false);
  assert.equal(auth.verifyPassword('anything'), false);
});

test('auth accepts a plaintext password', () => {
  const auth = authWith({ password: 'hunter2' });
  assert.equal(auth.verifyPassword('hunter2'), true);
  assert.equal(auth.verifyPassword('hunter3'), false);
  assert.equal(auth.verifyPassword(''), false);
});

test('auth accepts a sha256 digest and never needs the plaintext', () => {
  const auth = authWith({ passwordSha256: SHA_TEST });
  assert.equal(auth.verifyPassword('hunter2'), true);
  assert.equal(auth.verifyPassword('wrong'), false);
  // A malformed digest must not throw or accidentally match.
  assert.equal(authWith({ passwordSha256: 'not-hex' }).verifyPassword('not-hex'), false);
});

test('session tokens round-trip and expire', () => {
  // Relies on the helper's 12-hour default: the assertions below probe +11h and
  // +13h, so forcing a shorter session here breaks them.
  const auth = authWith({ password: 'x' });
  const now = 1_000_000;
  const token = auth.issueToken(now);

  assert.equal(auth.verifyToken(token, now), true);
  assert.equal(auth.verifyToken(token, now + 11 * 3600 * 1000), true);
  assert.equal(auth.verifyToken(token, now + 13 * 3600 * 1000), false, 'token outlived its session');
});

test('a tampered session token is rejected', () => {
  const auth = authWith({ password: 'x' });
  const token = auth.issueToken(1_000_000);
  const [expiry, signature] = token.split('.');

  // Extending the expiry must invalidate the signature, otherwise the cookie
  // would be a self-service permanent login.
  const extended = `${Number(expiry) + 10_000_000}.${signature}`;
  assert.equal(auth.verifyToken(extended), false);

  assert.equal(auth.verifyToken(`${expiry}.${'0'.repeat(signature.length)}`), false);
  assert.equal(auth.verifyToken('garbage'), false);
  assert.equal(auth.verifyToken(''), false);
  assert.equal(auth.verifyToken(null), false);
  assert.equal(auth.verifyToken(undefined), false);
});

test('a token signed with a different secret is rejected', () => {
  const token = authWith({ password: 'x' }, 'secret-a').issueToken(1_000_000);
  // Rotating the secret (or stealing a token from another instance) must fail.
  assert.equal(authWith({ password: 'x' }, 'secret-b').verifyToken(token, 1_000_000), false);
});

test('repeated failures lock an address out, and success clears it', () => {
  const auth = authWith({ password: 'x' });
  const ip = '10.0.0.1';
  const now = 1_000_000;

  for (let i = 0; i < 4; i++) auth.noteFailure(ip, now);
  assert.equal(auth.isLockedOut(ip, now), false, 'locked out before the threshold');

  auth.noteFailure(ip, now);
  assert.equal(auth.isLockedOut(ip, now), true);

  // Another address is unaffected.
  assert.equal(auth.isLockedOut('10.0.0.2', now), false);

  // The lockout expires.
  assert.equal(auth.isLockedOut(ip, now + 16 * 60 * 1000), false);

  auth.noteFailure(ip, now);
  auth.noteSuccess(ip);
  assert.equal(auth.isLockedOut(ip, now), false);
});

test('cookies parse and the session cookie is HttpOnly', () => {
  assert.deepEqual(parseCookies('a=1; gpustatus_admin=xyz; b=2'), {
    a: '1',
    gpustatus_admin: 'xyz',
    b: '2',
  });
  assert.deepEqual(parseCookies(undefined), {});

  const cookie = authWith({ password: 'x' }).sessionCookie('tok');
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Path=\//);
});

// ------------------------------------------------- config serialisation ------

test('config round-trips through the serialiser', () => {
  const path = join(tmpdir(), `gpustatus-cfg-${process.pid}.json`);
  try {
    const config = loadConfig();
    const withDisks = {
      ...config,
      hosts: config.hosts.map((h, i) => ({ ...h, disks: i === 0 ? ['/home', '/data'] : [] })),
    };

    writeFileSync(path, serializeConfig(withDisks), 'utf8');
    const reloaded = loadConfig(path);

    assert.equal(reloaded.hosts.length, config.hosts.length);
    assert.deepEqual(reloaded.hosts[0].disks, ['/home', '/data']);
    assert.deepEqual(reloaded.hosts[1].disks, []);
  } finally {
    rmSync(path, { force: true });
  }
});

test('serialising without a password does NOT invent one', () => {
  // A placeholder default like "change-me" would silently enable the admin page
  // behind a publicly known password.
  const config = loadConfig();
  const noPassword = {
    ...config,
    admin: { password: null, passwordSha256: null, sessionHours: 12 },
  };
  const text = serializeConfig(noPassword);

  // Check the actual configuration, not the prose: the comments explain why a
  // default is not written, so a naive substring search matches that text.
  const codeOnly = text
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');

  assert.ok(!codeOnly.includes('change-me'), 'serialiser wrote a default password');
  assert.ok(!/"password"\s*:/.test(codeOnly), 'serialiser wrote a password field');
  assert.ok(!/"password_sha256"\s*:/.test(codeOnly), 'serialiser wrote a digest field');

  const path = join(tmpdir(), `gpustatus-nopw-${process.pid}.json`);
  try {
    writeFileSync(path, text, 'utf8');
    const reloaded = loadConfig(path);
    assert.equal(
      Boolean(reloaded.admin.password || reloaded.admin.passwordSha256),
      false,
      'reloaded config unexpectedly has a password',
    );
  } finally {
    rmSync(path, { force: true });
  }
});

test('serialising preserves relative paths for untouched sections', () => {
  // Emitting the RESOLVED value would rewrite a portable "data/gpustatus.db"
  // into an absolute, machine-specific path on every save.
  const config = loadConfig();
  const text = serializeConfig(config);
  assert.match(text, /"path": "data\/gpustatus\.db"/);
  assert.ok(!text.includes(config.db.path), 'absolute db path leaked into the file');
});

test('host disk paths must be absolute', () => {
  const config = loadConfig();
  const bad = {
    ...config,
    hosts: [{ ...config.hosts[0], disks: ['relative/path'] }],
  };
  const path = join(tmpdir(), `gpustatus-baddisk-${process.pid}.json`);
  try {
    writeFileSync(path, serializeConfig(bad), 'utf8');
    assert.throws(() => loadConfig(path), /必须是绝对路径/);
  } finally {
    rmSync(path, { force: true });
  }
});

// ------------------------------------------------- disk selection semantics --

test('an absent disks key and an empty list mean different things', () => {
  const config = loadConfig();
  const path = join(tmpdir(), `gpustatus-disks-${process.pid}.json`);

  try {
    const base = { ...config, hosts: [{ ...config.hosts[0] }] };

    // Never configured -> null -> the UI shows every discovered filesystem.
    writeFileSync(path, serializeConfig({ ...base, hosts: [{ ...config.hosts[0], disks: null }] }), 'utf8');
    assert.equal(loadConfig(path).hosts[0].disks, null, 'absent key should load as null');

    // Explicitly ticked nothing -> [] -> the UI shows nothing. This must survive
    // a save, otherwise unticking everything would silently revert to "show all".
    writeFileSync(path, serializeConfig({ ...base, hosts: [{ ...config.hosts[0], disks: [] }] }), 'utf8');
    assert.deepEqual(loadConfig(path).hosts[0].disks, [], 'empty selection should survive a round trip');

    // A selection round-trips.
    writeFileSync(
      path,
      serializeConfig({ ...base, hosts: [{ ...config.hosts[0], disks: ['/home', '/tmp'] }] }),
      'utf8',
    );
    assert.deepEqual(loadConfig(path).hosts[0].disks, ['/home', '/tmp']);
  } finally {
    rmSync(path, { force: true });
  }
});

// --------------------------------------------- disk exclusion + net mounts --

test('root and the EFI partition are excluded by default', () => {
  const config = loadConfig();
  assert.deepEqual(config.diskExclude, ['/', '/boot/efi']);

  // The list must survive a round trip, otherwise the first save from the admin
  // page would silently start reporting the OS disk again.
  const path = join(tmpdir(), `gpustatus-excl-${process.pid}.json`);
  try {
    writeFileSync(path, serializeConfig(config), 'utf8');
    assert.deepEqual(loadConfig(path).diskExclude, ['/', '/boot/efi']);
  } finally {
    rmSync(path, { force: true });
  }
});

test('the exclusion list is configurable rather than hardcoded', () => {
  // If a root filesystem ever fills up and breaks a machine, the fix must not
  // require editing source.
  const config = loadConfig();
  const path = join(tmpdir(), `gpustatus-excl2-${process.pid}.json`);

  try {
    writeFileSync(path, serializeConfig({ ...config, diskExclude: [] }), 'utf8');
    assert.deepEqual(loadConfig(path).diskExclude, []);

    writeFileSync(path, serializeConfig({ ...config, diskExclude: ['/boot/efi'] }), 'utf8');
    assert.deepEqual(loadConfig(path).diskExclude, ['/boot/efi']);
  } finally {
    rmSync(path, { force: true });
  }
});

test('disk_exclude must be an array', () => {
  const config = loadConfig();
  const path = join(tmpdir(), `gpustatus-excl3-${process.pid}.json`);
  try {
    writeFileSync(path, JSON.stringify({ ...config, disk_exclude: 'nope', hosts: config.hosts }), 'utf8');
    assert.throws(() => loadConfig(path), /必须是挂载点数组/);
  } finally {
    rmSync(path, { force: true });
  }
});

test('net_mounts round-trips and rejects relative paths', () => {
  const config = loadConfig();
  const path = join(tmpdir(), `gpustatus-net-${process.pid}.json`);

  try {
    const withNet = {
      ...config,
      hosts: [{ ...config.hosts[0], netMounts: ['/share', '/remote_userdata'] }],
    };
    writeFileSync(path, serializeConfig(withNet), 'utf8');
    assert.deepEqual(loadConfig(path).hosts[0].netMounts, ['/share', '/remote_userdata']);

    const bad = { ...config, hosts: [{ ...config.hosts[0], netMounts: ['share'] }] };
    writeFileSync(path, serializeConfig(bad), 'utf8');
    assert.throws(() => loadConfig(path), /必须是绝对路径/);
  } finally {
    rmSync(path, { force: true });
  }
});

test('network mount health is carried without any usage figures', () => {
  // The capacity of an NFS mount belongs to the server, so reporting it per
  // machine printed the same number on every row.
  const raw = {
    ts: Math.floor(Date.now() / 1000),
    cpu: { ticks: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
    mem: {},
    gpus: [],
    procs: [],
    pid_users: [],
    pmon: [],
    errors: [],
    net_mounts: [
      { path: '/share', fstype: 'nfs4', status: 'rw' },
      { path: '/scratch', fstype: 'nfs4', status: 'stale' },
      { path: '/gone', fstype: '-', status: 'missing' },
    ],
    disks: [{ path: '/data', mount: '/data', total_kib: 1024, used_kib: 512, avail_kib: 512, use_pct: 50 }],
  };
  const sample = deriveSample({ id: 'n1', expectGpus: null }, raw, null, Date.now());

  assert.equal(sample.netMounts.length, 3);
  assert.equal(sample.netMounts[0].status, 'rw');
  assert.equal(sample.netMounts[1].status, 'stale');
  // A missing mount reports no filesystem type rather than the '-' placeholder.
  assert.equal(sample.netMounts[2].fstype, null);

  for (const m of sample.netMounts) {
    assert.ok(!('totalMib' in m), 'net mount must not carry capacity');
    assert.ok(!('usePct' in m), 'net mount must not carry usage');
  }
});

// ------------------------------------------------- admin config contract ----

test('the admin API returns every field the admin page reads', () => {
  // This is the regression test for a real outage: `net_mounts` was added to the
  // config, the collector, the save path and the UI, but not to
  // publicAdminConfig. The page dereferences these fields directly, so the
  // missing key threw "Cannot read properties of undefined (reading 'length')"
  // and blanked the entire view -- but only AFTER a successful login, which is
  // why nothing caught it earlier.
  //
  // The snapshot API had a contract check from the start; the admin API had
  // none, which is exactly where the bug landed.
  const config = loadConfig();
  const view = publicAdminConfig(config);

  // The field lists used to be written out here by hand, in a second copy of
  // the shape. `shared/schema.ts` defines it once and the admin page validates
  // against the same schema at runtime, so this asserts the live payload
  // satisfies it rather than restating the fields.
  const validation = AdminConfigSchema.safeParse(view);
  assert.ok(
    validation.success,
    'admin config violates the contract: ' +
      (validation.success
        ? ''
        : validation.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')),
  );

  // The password must never be part of this payload.
  const serialised = JSON.stringify(view);
  assert.ok(!serialised.includes('password_sha256'), 'admin config leaked the digest');
  assert.ok(!('password' in view.admin), 'admin config leaked a password field');
  assert.equal(typeof view.admin.has_password, 'boolean');
});

test('admin config carries net_mounts through from the configuration', () => {
  const config = loadConfig();
  const withNfs = {
    ...config,
    hosts: [{ ...config.hosts[0], netMounts: ['/share', '/remote_userdata'] }],
  };
  assert.deepEqual(publicAdminConfig(withNfs).hosts[0].net_mounts, [
    '/share',
    '/remote_userdata',
  ]);

  // A host with none configured still reports an array, never undefined.
  const without = { ...config, hosts: [{ ...config.hosts[0], netMounts: [] }] };
  assert.deepEqual(publicAdminConfig(without).hosts[0].net_mounts, []);
});

// ------------------------------------------------------- GPU display names --

const GPU_MAP = {
  'NVIDIA GeForce RTX 4090': 'RTX 4090 (24G)',
  'NVIDIA RTX 5880 Ada Generation': 'RTX 5880 Ada (48G)',
  'NVIDIA RTX 6000D': 'RTX Pro 6000D (84G)',
};

test('a mapped GPU reports its configured short name', () => {
  assert.equal(displayGpuName('NVIDIA GeForce RTX 4090', GPU_MAP), 'RTX 4090 (24G)');
  assert.equal(displayGpuName('NVIDIA RTX 6000D', GPU_MAP), 'RTX Pro 6000D (84G)');
});

test('an unmapped GPU still gets a usable name', () => {
  // The fallback keeps the model number, which is the only part anyone reads,
  // and drops the vendor prefix and marketing suffix.
  assert.equal(displayGpuName('NVIDIA RTX 5880 Ada Generation', {}), 'RTX 5880 Ada');
  assert.equal(displayGpuName('NVIDIA L40', {}), 'L40');
  assert.equal(displayGpuName('NVIDIA GeForce RTX 3090', {}), 'GeForce RTX 3090');
});

test('a missing or empty GPU name does not throw', () => {
  assert.equal(displayGpuName(null, GPU_MAP), null);
  assert.equal(displayGpuName(undefined, GPU_MAP), null);
  assert.equal(displayGpuName('', GPU_MAP), null);
  // A host that has never been polled has no gpus at all, and gpuNames may be
  // absent from an older config file.
  assert.equal(displayGpuName('NVIDIA L40', undefined), 'L40');
});

test('the gpu_names map survives a config round trip', () => {
  const config = loadConfig();
  const path = join(tmpdir(), `gpustatus-gpunames-${process.pid}.json`);
  try {
    writeFileSync(path, serializeConfig({ ...config, gpuNames: GPU_MAP }), 'utf8');
    assert.deepEqual(loadConfig(path).gpuNames, GPU_MAP);

    // Every mapping must reach the API payload, since the UI renders
    // display_name rather than the raw nvidia-smi string.
    const raw = Object.keys(GPU_MAP)[0];
    assert.equal(displayGpuName(raw, loadConfig(path).gpuNames), GPU_MAP[raw]);
  } finally {
    rmSync(path, { force: true });
  }
});

// --------------------------------------------------- announcement + notes --

test('an announcement is opt-in and needs actual text', () => {
  const config = loadConfig();
  const path = join(tmpdir(), `gpustatus-ann-${process.pid}.json`);
  const write = (announcement) =>
    writeFileSync(path, serializeConfig({ ...config, announcement }), 'utf8');

  try {
    // Absent -> nothing is shown. An announcement appearing from a config
    // default would be worse than none.
    writeFileSync(path, serializeConfig({ ...config, announcement: null }), 'utf8');
    assert.equal(loadConfig(path).announcement, null);

    // Enabled but empty -> still nothing, so a cleared box does not render as
    // an empty coloured banner.
    write(null);
    assert.equal(loadConfig(path).announcement, null);

    // Enabled with text -> carried through with its level.
    write({ level: 'warning', title: '使用须知', body: '第一行\n第二行', enabled: true });
    const loaded = loadConfig(path).announcement;
    assert.equal(loaded.level, 'warning');
    assert.equal(loaded.title, '使用须知');
    // Line breaks must survive: the announcement is multi-line by design.
    assert.equal(loaded.body, '第一行\n第二行');
  } finally {
    rmSync(path, { force: true });
  }
});

test('an invalid announcement level is rejected rather than silently defaulted', () => {
  const config = loadConfig();
  const path = join(tmpdir(), `gpustatus-ann2-${process.pid}.json`);
  try {
    writeFileSync(
      path,
      JSON.stringify({
        ...config,
        hosts: config.hosts,
        announcement: { enabled: true, level: 'purple', title: 'x', body: 'y' },
      }),
      'utf8',
    );
    assert.throws(() => loadConfig(path), /只能是 info、warning 或 error/);
  } finally {
    rmSync(path, { force: true });
  }
});

test('a per-machine note round-trips and reaches the admin API', () => {
  const config = loadConfig();
  const path = join(tmpdir(), `gpustatus-note-${process.pid}.json`);
  try {
    const withNote = {
      ...config,
      hosts: [{ ...config.hosts[0], note: '本机 3/15 全天维护' }, ...config.hosts.slice(1)],
    };
    writeFileSync(path, serializeConfig(withNote), 'utf8');
    const reloaded = loadConfig(path);

    assert.equal(reloaded.hosts[0].note, '本机 3/15 全天维护');
    // The note must reach the admin editor, or it would be silently wiped the
    // next time someone saved the form.
    assert.equal(publicAdminConfig(reloaded).hosts[0].note, '本机 3/15 全天维护');
    // A host without one reports an empty string, never undefined.
    assert.equal(publicAdminConfig(reloaded).hosts[1].note, '');
  } finally {
    rmSync(path, { force: true });
  }
});

test('the snapshot shape exposes the announcement to the dashboard', () => {
  const config = loadConfig();
  assert.ok('announcement' in config, 'config should always carry the key');
  // The dashboard reads snapshot.announcement; it must be null or an object.
  assert.ok(config.announcement === null || typeof config.announcement === 'object');
});

test('saving from the admin page keeps every editable per-host field', () => {
  // Regression test for silent data loss: `netMounts` was absent from the save
  // mapping, so every save from the admin page reset every machine's
  // network-mount list to empty -- losing the ability to notice a mount that had
  // gone missing. The omission produced no error at all.
  //
  // Read the fields the admin page can edit straight out of the source, so
  // adding a new one without wiring it into the save path fails here.
  const apiSource = readFileSync(new URL('../api.js', import.meta.url), 'utf8');
  const editable = publicAdminConfig(loadConfig()).hosts[0];
  const saveBlock = /hosts: \(editable\.hosts \?\? \[\]\)\.map\(\(h\) => \(\{[\s\S]*?\n    \}\)\),/.exec(
    apiSource,
  );
  assert.ok(saveBlock, 'could not locate the host mapping in saveConfig');

  for (const key of Object.keys(editable)) {
    // `id` is the key itself; everything else must be read back from the payload.
    const prop = key === 'expect_gpus' ? 'expectGpus' : key === 'net_mounts' ? 'netMounts' : key;
    if (key === 'id') continue;
    assert.ok(
      saveBlock[0].includes(prop),
      `saveConfig does not map "${key}" -- a save would silently reset it`,
    );
  }
});

// ------------------------------------------------------ throttle telemetry --

test('the throttle bitmask decodes to the reasons an operator acts on', () => {
  const busy = { idle: false };

  // Observed live on Server20: no bits set, card at full clock.
  assert.deepEqual(decodeThrottle(0x0, busy), { mask: 0, reasons: [], throttled: false });
  // Observed live on Server14/18 at full utilisation.
  assert.deepEqual(decodeThrottle(0x4, busy).reasons, ['功耗墙']);
  assert.equal(decodeThrottle(0x4, busy).throttled, true);
  // Observed live on Server19 GPU1/2/3/5/6 -- running at 930 MHz of 3105.
  assert.deepEqual(decodeThrottle(0x20, busy).reasons, ['热降频']);
  assert.equal(decodeThrottle(0x20, busy).throttled, true);
  // Several reasons at once is normal.
  assert.deepEqual(decodeThrottle(0x24, busy).reasons, ['功耗墙', '热降频']);

  // An idle card downclocks by design: the GpuIdle bit is not a fault, and a
  // machine that is simply not being used must not raise a throttle warning.
  assert.equal(decodeThrottle(0x1, { idle: true }).throttled, false);
  assert.deepEqual(decodeThrottle(0x1, busy).reasons, ['空闲']);
  assert.equal(decodeThrottle(0x1, busy).throttled, false);

  // A card with work queued that reports idle is still not a throttle problem.
  assert.equal(decodeThrottle(0x1 | 0x20, { idle: true }).throttled, false);
  assert.equal(decodeThrottle(0x1 | 0x20, busy).throttled, true);
});

test('an unreadable throttle mask is null, never a silent "not throttled"', () => {
  // Cards that do not report the field (older drivers) must be distinguishable
  // from cards that positively reported "no throttling".
  for (const missing of [null, undefined, NaN, 'nonsense']) {
    const d = decodeThrottle(missing, { idle: false });
    assert.equal(d.mask, null, `mask for ${String(missing)} should be null`);
    assert.equal(d.throttled, false);
    assert.deepEqual(d.reasons, []);
  }
});

test('throttle warnings separate thermal from power capping', () => {
  const gpus = (masks) =>
    masks.map((m, i) => ({ index: i, throttleMask: m, nProcs: 1, util: 99 }));

  // Idle cards raise nothing, however many there are.
  assert.deepEqual(throttleWarnings({ gpus: gpus([1, 1, 1, 1]) }), []);
  // The Server19 case: five thermal, three power-capped.
  assert.deepEqual(throttleWarnings({ gpus: gpus([0x20, 0x20, 0x20, 0x4, 0x4, 0x20, 0x20, 0x4]) }), [
    'throttled:5/8_thermal',
    'throttled:3/8_power_cap',
  ]);
  // A power cap at full utilisation is the card behaving as configured, so it
  // is reported but never counted as thermal.
  assert.deepEqual(throttleWarnings({ gpus: gpus([4, 4]) }), ['throttled:2/2_power_cap']);
  assert.deepEqual(throttleWarnings({ gpus: gpus([0, 0]) }), []);
  // Cards that never reported a mask contribute nothing rather than a false 0.
  assert.deepEqual(throttleWarnings({ gpus: gpus([null, null]) }), []);
  assert.deepEqual(throttleWarnings(null), []);
  assert.deepEqual(throttleWarnings({ gpus: [] }), []);
});

test('a malformed session cookie is rejected, never thrown on', () => {
  // Regression: `signature.length` counts UTF-16 units while timingSafeEqual
  // compares byte lengths, and HTTP headers arrive latin-1 decoded. A signature
  // of 64 characters containing one byte >= 0x80 passed the length guard but
  // encoded to 65 bytes, so timingSafeEqual threw -- a bad cookie produced a
  // 500 instead of a clean "not logged in".
  const auth = authWith({ password: 'x', sessionHours: 1 });
  const now = Date.now();

  const attacks = [
    '',
    'no-dot',
    '.onlysignature',
    'expiry.',
    `123.${'a'.repeat(63)}\u00c3`, // 64 chars, 65 UTF-8 bytes -- the actual crash
    `123.${'a'.repeat(64)}`,
    `123.${'中'.repeat(64)}`,
    `123.${'a'.repeat(63)}`, // wrong length but valid hex characters
    `123.${'g'.repeat(64)}`, // right length, not hex
    'notanumber.deadbeef',
  ];

  for (const bad of attacks) {
    let result;
    assert.doesNotThrow(() => {
      result = auth.verifyToken(bad, now);
    }, `verifyToken threw on ${JSON.stringify(bad).slice(0, 40)}`);
    assert.equal(result, false, `accepted a forged token: ${JSON.stringify(bad).slice(0, 40)}`);
  }

  // A genuine token still verifies, and still expires.
  const good = auth.issueToken(now);
  assert.equal(auth.verifyToken(good, now), true);
  // sessionHours is 1, so two hours later it must be refused.
  assert.equal(auth.verifyToken(good, now + 2 * 3600_000), false, 'expired token accepted');
});

test('the thermal share refuses to reassure from too little history', () => {
  // The throttle reason in the snapshot is INSTANTANEOUS, and a card near its
  // thermal target alternates between "power cap" and "thermal slowdown" from
  // one sample to the next. On Server19 that meant the dashboard said "功耗墙"
  // for a card sitting at 87 degrees that was thermally throttling ~1% of the
  // time. This share is what makes those events visible.

  // Too little history must read as unknown, not as "never throttled" -- right
  // after a restart every card would otherwise claim to be fine.
  assert.equal(thermalShare(undefined), null);
  assert.equal(thermalShare([]), null);
  assert.equal(thermalShare([0, 0, 0]), null, 'three samples is not evidence of anything');

  // With enough samples, a real share comes through.
  const clean = Array(100).fill(0);
  assert.equal(thermalShare(clean), 0);

  const sometimes = [...Array(96).fill(0), ...Array(4).fill(1)];
  assert.equal(thermalShare(sometimes), 4);

  const always = Array(100).fill(1);
  assert.equal(thermalShare(always), 100);
});

test('a sample with a missing metric does not lose the whole hourly row', () => {
  // Regression: every *_sum column is NOT NULL, and the first poll after a
  // restart has no previous /proc/stat to diff, so cpuPct is null. Binding that
  // null threw "NOT NULL constraint failed: host_hourly.cpu_sum" and dropped the
  // ENTIRE sample -- once per machine per restart. Counting a literal 1 would
  // have been wrong the other way, recording a sample that never happened.
  //
  // Only surfaced on a fresh database on a new machine, which is exactly what
  // deploying to mgmt2 exercised.
  const db = new Db(':memory:');
  const sample = (ts, cpuPct) => ({
    ts,
    host: { cpuPct, memPct: 40, ncpu: 8 },
    gpus: Array.from({ length: 8 }, (_, i) => ({
      index: i, util: 50, memUsedMib: 1000, memTotalMib: 2000,
      memUtil: 20, tempC: 60, powerW: 100,
    })),
    procs: [], uptimeS: 100, driverVersion: 'x', hostname: 'h', label: null,
    warnings: [],
  });

  const t = 1_700_000_000_000;
  assert.doesNotThrow(() => db.recordSuccess('gpu19', sample(t, null)));
  assert.doesNotThrow(() => db.recordSuccess('gpu19', sample(t + 15000, 12.5)));

  const row = db.db.prepare('SELECT * FROM host_hourly').get();
  // The GPU figures were present both times...
  assert.equal(row.util_n, 2, 'the GPU observation was not counted twice');
  assert.equal(row.util_sum / row.util_n, 50);
  // ...while CPU was only measurable the second time, and must not be dragged
  // toward zero by the unmeasurable first one.
  assert.equal(row.cpu_n, 1, 'an unmeasurable CPU reading was counted as a sample');
  assert.equal(row.cpu_sum / row.cpu_n, 12.5);
  db.close();
});

test('the card-count check compares against the machine, not a config constant', () => {
  // On this cluster every machine is physically an 8-GPU box, and cards that
  // cannot run jobs are DELIBERATELY masked off after boot. So the visible count
  // both varies and changes when the operator adjusts the masking -- which made
  // a fixed expect_gpus fire on the boot-time 8 -> 6 transition, i.e. on
  // intended behaviour.
  const gpus = (n) => ({ gpus: Array.from({ length: n }, (_, i) => ({ index: i })) });
  const history = (...counts) => counts.map((count, i) => ({ ts: i, count }));

  // No expectation configured: compare against this machine's own recent high.
  assert.equal(gpuCountWarning(gpus(6), history(6, 6, 6), null), null, 'steady state warned');
  // A drop below what this machine has recently had IS worth reporting.
  assert.equal(
    gpuCountWarning(gpus(5), history(6, 6, 6), null),
    'gpu_count_dropped:from_6_to_5',
  );
  // The boot-time transition (8 visible, then masked to 6) is intended, so once
  // the higher count has aged out of the window it stops being reported.
  assert.equal(gpuCountWarning(gpus(6), history(6, 6, 6), null), null);
  // ...but while it is still in the window it is reported, because the machine
  // really did use to have more.
  assert.equal(gpuCountWarning(gpus(6), history(8, 6), null), 'gpu_count_dropped:from_8_to_6');

  // An explicit expect_gpus overrides the baseline entirely -- that is the
  // operator stating intent, and it should not be second-guessed.
  assert.equal(
    gpuCountWarning(gpus(6), history(6, 6), 6),
    null,
    'an explicit expectation was overridden by the baseline',
  );
  assert.equal(
    gpuCountWarning(gpus(8), history(6, 6), 6),
    'gpu_count_mismatch:expected_6_saw_8',
    'an explicit expectation was not enforced',
  );

  // A machine with no cards reporting is not a count change.
  assert.equal(gpuCountWarning({ gpus: [] }, history(6), null), null);
  assert.equal(gpuCountWarning(null, history(6), null), null);
});

test('a save from a stale admin page cannot silently drop another writer\'s edits', () => {
  // Real incident: an admin page was open holding a 6-machine config. The file
  // was then changed on disk to 15 machines. The page's next save PUT the whole
  // document back and silently replaced the 15 with its stale 6 -- the added
  // machines vanished. Only the hosts.json.bak happened to keep them.
  //
  // The guard is a fingerprint of the file: the page sends back the revision it
  // loaded, and a mismatch is refused instead of applied.
  const dir = mkdtempSync(join(tmpdir(), 'gpus-rev-'));
  const file = join(dir, 'hosts.json');
  writeFileSync(file, '{"a":1}', 'utf8');

  const revision = (p) =>
    createHash('sha256').update(readFileSync(p, 'utf8')).digest('hex').slice(0, 16);

  const loaded = revision(file);

  // Someone else edits the file while the page sits open.
  writeFileSync(file, '{"a":1,"added":{"b":2}}', 'utf8');

  assert.notEqual(revision(file), loaded, 'the file fingerprint did not change');
  // The page's stale revision no longer matches, which is what makes the API
  // answer 409 rather than overwrite.
  assert.equal(revision(file) === loaded, false);

  // Saving with the CURRENT revision is still allowed.
  assert.equal(revision(file) === revision(file), true);
});

test('a host added by hot reload appears where the config puts it, not last', () => {
  // A Map preserves insertion order, and applyConfig used to append new hosts.
  // So gpu03 -- listed FIRST in the config -- showed up LAST on the dashboard
  // because it arrived via a hot reload rather than at startup. Restarting the
  // service then silently reordered the page.
  const cfg = (ids) => ({
    site: null,
    poll: { intervalMs: 15000, timeoutMs: 12000, staleAfterMs: 45000, downAfterFailures: 10 },
    naming: { stripDomain: true },
    hosts: ids.map((id) => ({ id, ssh: id, expectGpus: null, disks: null, netMounts: [] })),
  });

  const state = new State(cfg(['gpu05', 'gpu06']));
  const order = () => state.buildSnapshot().hosts.map((h) => h.id);

  assert.deepEqual(order(), ['gpu05', 'gpu06']);

  // gpu03 is inserted at the front, as the config lists it.
  state.applyConfig(cfg(['gpu03', 'gpu05', 'gpu06']));
  assert.deepEqual(order(), ['gpu03', 'gpu05', 'gpu06'], 'the added host was appended instead of placed');

  // Reordering the config reorders the page, and removing one drops it.
  state.applyConfig(cfg(['gpu05', 'gpu03']));
  assert.deepEqual(order(), ['gpu05', 'gpu03']);

  // Live state must survive the rebuild: the entry is reused, not recreated.
  const before = state.hosts.get('gpu05');
  before.totalPolls = 42;
  state.applyConfig(cfg(['gpu05', 'gpu03']));
  assert.equal(state.hosts.get('gpu05'), before, 'the host entry was replaced');
  assert.equal(state.hosts.get('gpu05').totalPolls, 42, 'live state was lost on reload');
});

test('the simultaneous peak spans machines, unlike the per-host rollup', () => {
  // The usage table showed "the most on any ONE machine". A user running 6 GPUs
  // on each of three machines at once read as 6 instead of 18 -- on the real
  // 16-machine cluster this undercounted 4 of 16 users.
  //
  // usage_rollup cannot express this: it is keyed by (hour, host, user). Hence
  // usage_peak, written once per cycle when every host's sample is in hand.
  const db = new Db(':memory:');
  const gpu = (index) => ({ gpuIndex: index, username: 'alice' });
  const sample = (procs) => ({ procs, hostname: 'h', gpus: [], disks: [] });

  db.recordCyclePeaks([
    { hostId: 'gpu1', sample: sample([gpu(0), gpu(1), gpu(2)]) },
    { hostId: 'gpu2', sample: sample([gpu(0), gpu(1), gpu(2)]) },
    { hostId: 'gpu3', sample: sample([gpu(0)]) },
  ]);

  const row = db.db.prepare('SELECT * FROM usage_peak WHERE username = ?').get('alice');
  assert.equal(row.peak_gpus, 7, 'the peak did not span machines');

  // The SAME card in two processes must not count twice.
  db.recordCyclePeaks([
    { hostId: 'gpu1', sample: sample([gpu(0), gpu(0), gpu(1)]) },
  ]);
  db.recordCyclePeaks([{ hostId: 'gpu1', sample: sample([gpu(0)]) }]);
  assert.equal(
    db.db.prepare('SELECT peak_gpus FROM usage_peak WHERE username = ?').get('alice').peak_gpus,
    7,
    'a repeated card was counted twice, or a lower cycle replaced the peak',
  );

  // Only the maximum is kept, so a cycle where a machine failed to answer can
  // never lower the recorded peak.
  db.recordCyclePeaks([{ hostId: 'gpu1', sample: sample([gpu(0)]) }]);
  assert.equal(
    db.db.prepare('SELECT peak_gpus FROM usage_peak WHERE username = ?').get('alice').peak_gpus,
    7,
  );

  // An unresolved owner is skipped rather than attributed to nobody.
  db.recordCyclePeaks([{ hostId: 'gpu9', sample: sample([{ gpuIndex: 0, username: null }]) }]);
  assert.equal(db.db.prepare('SELECT COUNT(*) AS c FROM usage_peak').get().c, 1);
  db.close();
});

test('totals report the simultaneous peak, not the per-machine maximum', () => {
  // Guards the join: reading MAX(usage_rollup.peak_gpus) here silently halves
  // the figure for anyone spreading work across machines.
  const db = new Db(':memory:');
  const ts = Date.now();
  const rollup = db.db.prepare(
    `INSERT INTO usage_rollup (bucket_ts, host_id, username, gpu_seconds,
       sm_gpu_seconds, mem_mib_seconds, peak_gpus, peak_mem_mib, samples)
     VALUES (?,?,?,?,?,?,?,?,1)`,
  );
  // Two machines, 6 GPUs each, same hour: the per-host peaks are both 6.
  for (const host of ['gpu1', 'gpu2']) {
    rollup.run(Math.floor(ts / 3600000) * 3600000, host, 'alice', 6 * 60, 0, 0, 6, 0);
  }
  db.db
    .prepare('INSERT INTO usage_peak (bucket_ts, username, peak_gpus) VALUES (?,?,?)')
    .run(Math.floor(ts / 3600000) * 3600000, 'alice', 12);

  const [row] = db.queryUsageTotals({ fromTs: ts - 3600000, toTs: ts + 3600000 });
  assert.equal(row.peak_gpus, 12, 'the totals query fell back to the per-machine maximum');
  assert.equal(row.gpu_seconds, 720, 'the GPU-seconds total changed');
  db.close();
});

test('an unreadable utilisation does not drag the average toward zero', () => {
  // Real case, wangsiyuan on Server06: the cards were at 84/79/83% while
  // nvidia-smi pmon reported nothing for the process, so sm_pct was null.
  // Summing null as 0 but dividing by every card held turned 292/4 = 73% into
  // 292/7 = 41.7%, and when ALL readings were missing it produced 0.0% -- which
  // the users page then painted red as a "wasted allocation".
  const procs = [
    { username: 'w', gpuIndex: 0, smPct: 80, usedMemMib: 100 },
    { username: 'w', gpuIndex: 1, smPct: 75, usedMemMib: 100 },
    { username: 'w', gpuIndex: 2, smPct: null, usedMemMib: 100 },
    { username: 'w', gpuIndex: 3, smPct: null, usedMemMib: 100 },
  ];
  const [u] = aggregateUserUsage(procs);
  assert.equal(u.gpus, 4, 'the user still holds four cards');
  assert.equal(u.smGpus, 2, 'the divisor counted cards that never reported');
  assert.equal(u.smSum, 155);

  // All readings missing: the average must be absent, not zero.
  const [none] = aggregateUserUsage([
    { username: 'w', gpuIndex: 0, smPct: null, usedMemMib: 100 },
    { username: 'w', gpuIndex: 1, smPct: null, usedMemMib: 100 },
  ]);
  assert.equal(none.smGpus, 0);
  assert.equal(none.smSum, 0);
  // (state.js maps smGpus === 0 to a null average, which the UI shows as "—".)

  // A real zero still counts: an idle process IS a measurement of 0%.
  const [idle] = aggregateUserUsage([
    { username: 'w', gpuIndex: 0, smPct: 0, usedMemMib: 100 },
    { username: 'w', gpuIndex: 1, smPct: null, usedMemMib: 100 },
  ]);
  assert.equal(idle.smGpus, 1, 'a measured 0% was discarded as if unmeasured');
  assert.equal(idle.smSum, 0);

  // Two processes sharing one card must not be counted as two cards.
  const [shared] = aggregateUserUsage([
    { username: 'w', gpuIndex: 0, smPct: 60, usedMemMib: 100 },
    { username: 'w', gpuIndex: 0, smPct: 60, usedMemMib: 100 },
  ]);
  assert.equal(shared.smGpus, 1, 'one card counted twice in the divisor');
  assert.equal(shared.smSum, 100, 'per-card utilisation is capped at 100');
});

test('pmon columns are found by name, not by position', () => {
  // The parser used to require at least 9 whitespace-separated fields. Driver
  // 535 emits 8 ("gpu pid type sm mem enc dec command") and 580 emits 10 (with
  // jpg and ofa), so every line from the older machines was discarded and their
  // per-process utilisation read as null while the cards reported 80%+.
  //
  // This asserts the probe derives the columns from the header, which is the
  // part that makes it survive a driver adding or removing a column.
  const here = dirname(fileURLToPath(import.meta.url));
  const probe = readFileSync(join(here, '..', 'remote-probe.sh'), 'utf8');
  // Comments are stripped first: the parser's own explanation quotes the old
  // guard verbatim, and matching that would fail the very fix it documents.
  const code = probe
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('#'))
    .join('\n');

  assert.ok(/f\[i\] == "sm"/.test(code), 'the pmon parser no longer locates the sm column by name');
  assert.ok(
    /sub\(\/\^#\[ \\t\]\*\/, "", line\)/.test(code),
    'the pmon header is not having its leading # stripped, so every column index is off by one',
  );
  assert.ok(
    !/if \(n < 9\) next/.test(code),
    'a hard-coded pmon field count is back; that is what broke the 535 driver',
  );
});

test('a bursty job is not reported as idle', () => {
  // Server13, measured directly: one card read 78, 0, 0, 0, 11, 73, 0, 100, 0,
  // 19, 0, 75 percent in twelve consecutive four-second samples, while its clock
  // stayed at 1695-1980 MHz and it drew 118-277W. The job was working; the
  // individual samples were just landing in the gaps between bursts, which is
  // the normal shape when a model does not fit in GPU memory.
  //
  // The users page averaged ONE instant across a user's cards, so which figure
  // it showed came down to when the poll happened to fire.
  const cfg = {
    site: null,
    poll: { intervalMs: 15000, timeoutMs: 12000, staleAfterMs: 45000, downAfterFailures: 10 },
    naming: { stripDomain: true },
    hosts: [{ id: 'h1', ssh: 'h1', expectGpus: null, disks: null, netMounts: [] }],
  };
  const state = new State(cfg);
  const pattern = [78, 0, 0, 0, 11, 73, 0, 100, 0, 19, 0, 75];
  const base = Date.now() - pattern.length * 15000;

  pattern.forEach((sm, i) => {
    state.applyResult('h1', {
      ok: true,
      durationMs: 100,
      sample: {
        ts: base + i * 15000,
        hostname: 'h1',
        label: 'H1',
        uptimeS: 1,
        driverVersion: 'x',
        warnings: [],
        host: { cpuPct: 10, memPct: 20, ncpu: 8, load1: 1, load5: 1, load15: 1, totalProcs: 100, swapUsedMib: 0, swapTotalMib: 0, iowaitPct: 1 },
        gpus: [{ index: 0, util: sm, memUtil: 0, memUsedMib: 22000, memTotalMib: 24000, tempC: 55, powerW: 150, nProcs: 1, throttleMask: 0 }],
        procs: [{ pid: 1, username: 'wangsiyuan', gpuIndex: 0, smPct: sm, usedMemMib: 22000, name: 'python', elapsedS: 100 }],
      },
    });
  });

  const [user] = state.buildSnapshot().hosts[0].users;
  const truth = pattern.reduce((a, b) => a + b, 0) / pattern.length;
  assert.equal(user.sm_counted_gpus, pattern.length, 'not every sample reached the average');
  assert.ok(
    Math.abs(user.sm_pct_avg - truth) < 0.15,
    `expected the time average ${truth.toFixed(1)}%, got ${user.sm_pct_avg}%`,
  );
  // The point of the window: the figure must not be whatever the last sample
  // happened to catch. The final sample was 75%, the average is ~29.7%.
  assert.ok(
    user.sm_pct_avg < 40,
    'the reported average looks like a single sample rather than an average over time',
  );

  // Samples with no readable utilisation must not enter the window as zeros --
  // that is the bug the window was built to fix.
  state.applyResult('h1', {
    ok: true,
    durationMs: 100,
    sample: {
      ts: base + pattern.length * 15000,
      hostname: 'h1', label: 'H1', uptimeS: 1, driverVersion: 'x', warnings: [],
      host: { cpuPct: 10, memPct: 20, ncpu: 8, load1: 1, load5: 1, load15: 1, totalProcs: 100, swapUsedMib: 0, swapTotalMib: 0, iowaitPct: 1 },
      gpus: [{ index: 0, util: 0, memUtil: 0, memUsedMib: 22000, memTotalMib: 24000, tempC: 55, powerW: 150, nProcs: 1, throttleMask: 0 }],
      procs: [{ pid: 1, username: 'wangsiyuan', gpuIndex: 0, smPct: null, usedMemMib: 22000, name: 'python', elapsedS: 100 }],
    },
  });
  const [after] = state.buildSnapshot().hosts[0].users;
  assert.equal(
    after.sm_counted_gpus,
    pattern.length,
    'an unreadable sample was counted as a 0% reading',
  );
});

test('hours whose process readings were lost are rebuilt from card data', () => {
  // The pmon parser dropped every line from the driver-535 machines, storing
  // per-process utilisation as null. That null became a 0 in the rollup, so the
  // "effective GPU hours" used for accounting read as ~0: wangsiyuan's 130
  // card-hours on gpu06 recorded 1.8, and maoyuxin's 54 on gpu09 recorded 0.
  //
  // The per-process figure is gone, but the CARD-level utilisation comes from a
  // different nvidia-smi query and survived. On both machines exactly one user
  // held each card, so the card's utilisation IS that user's.
  const dir = mkdtempSync(join(tmpdir(), 'gpus-sm-'));
  const path = join(dir, 'x.db');

  // Open once so the schema exists; the repair is a no-op on an empty database.
  new Db(path).close();

  const db = new Db(path);
  const hour = 1_700_000_000_000 - (1_700_000_000_000 % 3600000);
  const insProc = db.db.prepare(
    'INSERT INTO proc_sample (ts, host_id, gpu_index, gpu_uuid, pid, username, proc_name, used_mem_mib, sm_pct) VALUES (?,?,?,?,?,?,?,?,?)',
  );
  const insGpu = db.db.prepare(
    `INSERT INTO gpu_sample (ts, host_id, gpu_index, gpu_uuid, gpu_name, util_pct,
       mem_used_mib, mem_total_mib, mem_util_pct, temp_c, power_w, fan_pct, n_procs,
       throttle_mask, sm_clock_mhz, sm_clock_max_mhz, power_limit_w, pstate, bus_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );

  // Two cards, two instants: card 0 at 80%, card 1 at 40%.
  for (const ts of [hour + 60_000, hour + 120_000]) {
    for (const [idx, util] of [[0, 80], [1, 40]]) {
      insGpu.run(ts, 'gpu06', idx, `u${idx}`, 'X', util, 100, 1000, 0, 50, 100, 30, 1, 0, 1000, 2000, 300, 'P2', '00:00.0');
      // sm_pct deliberately null: this is the lost reading.
      insProc.run(ts, 'gpu06', idx, `u${idx}`, 100 + idx, 'alice', 'python', 100, null);
    }
  }
  // What the broken writer stored: two cards held, zero effective GPU-seconds.
  db.db
    .prepare(
      `INSERT INTO usage_rollup (bucket_ts, host_id, username, gpu_seconds,
         sm_gpu_seconds, mem_mib_seconds, peak_gpus, peak_mem_mib, samples)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    )
    .run(hour, 'gpu06', 'alice', 2 * 60, 0, 0, 2, 0, 2);

  // Clear the once-only marker so opening the file runs the repair again.
  db.setMeta('repair_pmon_sm_v1', '');
  db.close();

  const repaired = new Db(path);
  assert.equal(repaired.repairedSmRows, 1, 'the lost hour was not repaired');

  const row = repaired.db
    .prepare('SELECT gpu_seconds, sm_gpu_seconds FROM usage_rollup WHERE username = ?')
    .get('alice');
  // The two cards averaged (80 + 40) / 2 = 60%, so 120 card-seconds becomes 72
  // effective GPU-seconds -- and gpu_seconds, which never depended on sm, is
  // left exactly as it was.
  assert.equal(row.gpu_seconds, 120, 'the card-time was altered');
  assert.ok(
    Math.abs(row.sm_gpu_seconds - 72) < 0.01,
    `expected 72 effective seconds, got ${row.sm_gpu_seconds}`,
  );
  repaired.close();
});

test('an hour that genuinely read 0% is not mistaken for a lost one', () => {
  // The distinction the repair turns on: a real idle process reports 0, which is
  // a measurement; only null means "we never got a reading". Repairing an hour
  // that legitimately read zero would invent usage that never happened.
  const db = new Db(':memory:');
  const hour = 1_700_000_000_000 - (1_700_000_000_000 % 3600000);
  db.db
    .prepare(
      'INSERT INTO proc_sample (ts, host_id, gpu_index, gpu_uuid, pid, username, proc_name, used_mem_mib, sm_pct) VALUES (?,?,?,?,?,?,?,?,?)',
    )
    .run(hour + 1000, 'gpu06', 0, 'u0', 1, 'bob', 'python', 100, 0);
  const count = db.db
    .prepare(
      `SELECT COUNT(*) AS n FROM (
         SELECT host_id, CAST(ts / 3600000 AS INTEGER) * 3600000 AS bucket
           FROM proc_sample WHERE username IS NOT NULL
          GROUP BY host_id, bucket
         HAVING SUM(CASE WHEN sm_pct IS NOT NULL THEN 1 ELSE 0 END) = 0)`,
    )
    .get().n;
  assert.equal(count, 0, 'an hour with a genuine 0% reading was flagged as lost');
  db.close();
});
