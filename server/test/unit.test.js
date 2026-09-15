/**
 * Unit tests for the pure logic that is easy to get subtly wrong:
 * the status state machine, the usage accounting maths, CPU delta handling and
 * the JSONC config parser.
 *
 * Run with: npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseJsonc, loadConfig, deriveHostLabel, resolveHostLabel, serializeConfig } from '../config.js';
import { computeCpuPct, deriveSample, shellQuote } from '../collector.js';
import { aggregateUserUsage } from '../db.js';
import { State, decodeThrottle, displayGpuName, throttleWarnings } from '../state.js';
import { parseTime, publicAdminConfig } from '../api.js';
import { Auth, parseCookies } from '../auth.js';
import { createHash } from 'node:crypto';
import { writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// --------------------------------------------------------------- config -----

test('parseJsonc strips comments but not comment-like text inside strings', () => {
  const input = `{
    // a line comment
    "url": "http://example.com//path", // trailing comment
    /* block
       comment */
    "glob": "a/*b*/c",
    "list": [1, 2, 3,],
  }`;
  const parsed = parseJsonc(input);
  const value = JSON.parse(parsed);

  // A naive regex stripper would have mangled both of these.
  assert.equal(value.url, 'http://example.com//path');
  assert.equal(value.glob, 'a/*b*/c');
  assert.deepEqual(value.list, [1, 2, 3]);
});

test('parseJsonc preserves escaped quotes', () => {
  const value = JSON.parse(parseJsonc('{"s": "a\\"b // not a comment"}'));
  assert.equal(value.s, 'a"b // not a comment');
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

test('deriveSample warns on a GPU count mismatch instead of silently accepting', () => {
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
  assert.ok(sample.warnings.includes('gpu_count_mismatch:expected_8_saw_1'));
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
    assert.throws(() => loadConfig(path), /must be absolute/);
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
    assert.throws(() => loadConfig(path), /disk_exclude must be an array/);
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
    assert.throws(() => loadConfig(path), /net_mounts path must be absolute/);
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

  assert.deepEqual(
    Object.keys(view).sort(),
    ['admin', 'announcement', 'hosts', 'naming', 'poll', 'site'].sort(),
    'top-level admin config shape changed',
  );

  assert.deepEqual(
    Object.keys(view.hosts[0]).sort(),
    ['disks', 'expect_gpus', 'group', 'id', 'label', 'net_mounts', 'note', 'ssh'].sort(),
    'per-host admin config shape changed',
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
    assert.throws(() => loadConfig(path), /announcement\.level must be/);
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
