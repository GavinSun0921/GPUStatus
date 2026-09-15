/**
 * Render smoke test.
 *
 * Fetches a REAL snapshot from the running backend and renders the data-bearing
 * components to static HTML, then asserts the values actually appear in the
 * output. Type-checking and contract checks prove the shapes line up; only
 * rendering proves the components do not throw on real data.
 *
 * Run against a live backend:
 *   npm run check:render
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { ConfigProvider, theme } from 'antd';
import zhCN from 'antd/locale/zh_CN';

import { Overview } from './components/Overview';
import { ProcTable } from './components/Machine';
import { UsersView } from './components/Reports';
import type { Gpu, Snapshot } from './types';

const API =
  // Minimal typed view of the Node global, declared locally so that this script
  // does not force @types/node onto the frontend dependency list.
  (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env
    .GPUSTATUS_API ?? 'http://127.0.0.1:8787';

const response = await fetch(`${API}/api/snapshot`);
if (!response.ok) throw new Error(`snapshot request failed: HTTP ${response.status}`);
const snapshot = (await response.json()) as Snapshot;
if (!snapshot.hosts?.length) throw new Error('snapshot contains no hosts');

const now = snapshot.server_now;

/** antd needs its ConfigProvider for tokens/locale; the algorithm is irrelevant to markup. */
const render = (node: React.ReactNode) =>
  renderToStaticMarkup(
    <ConfigProvider locale={zhCN} theme={{ algorithm: theme.defaultAlgorithm }}>
      {node}
    </ConfigProvider>,
  );

const html = render(
  <>
    <Overview snapshot={snapshot} now={now} />
    <UsersView snapshot={snapshot} />
  </>,
);

// --- assertions -------------------------------------------------------------
const failures: string[] = [];
const check = (condition: boolean, label: string) => {
  if (!condition) failures.push(label);
};
const countOf = (needle: string, haystack: string = html) => haystack.split(needle).length - 1;

for (const host of snapshot.hosts) {
  check(html.includes(host.label), `host label missing: ${host.label}`);
  check(html.includes(`id="host-${host.id}"`), `machine card missing: ${host.id}`);
  check(host.hostname === null || html.includes(host.hostname), `hostname missing: ${host.id}`);

  // Per-card index and model cells are counted once for the whole document
  // below, not per host: a document-wide count compared against a single
  // machine's card count would be meaningless.

  // The model must be visible per card. It once disappeared completely -- the
  // name was computed but the header rebuild dropped the only place that
  // rendered it, and nothing failed because no check looked for it.
  if (host.gpus.length > 0) {
    const model = host.gpus[0].display_name;
    check(
      model === null || html.includes(model),
      `GPU model "${model}" not rendered for ${host.id}`,
    );
  }
  for (const user of host.users) {
    check(html.includes(user.username), `username missing: ${user.username} on ${host.id}`);
  }
}

for (const user of snapshot.users) {
  check(html.includes(user.username), `global user row missing: ${user.username}`);
}

// One row per active user. A user silently dropping out of this table is the
// same class of bug as a GPU or a disk vanishing, so it is counted too.
check(
  countOf('user-row') === snapshot.users.length,
  `rendered ${countOf('user-row')} user rows, expected ${snapshot.users.length}`,
);

// One machine card per host and one row per physical card -- this is what
// catches a host or a card being silently dropped by the table.
const machines = countOf('id="host-');
const expectedMachines = snapshot.hosts.length;
check(machines === expectedMachines, `rendered ${machines} machine cards, expected ${expectedMachines}`);

const gpuRows = countOf('gpu-row');
const expectedGpus = snapshot.hosts.reduce((n, h) => n + h.gpus.length, 0);
check(gpuRows === expectedGpus, `rendered ${gpuRows} GPU rows, expected ${expectedGpus}`);

// One tile per SELECTED disk. A disk silently vanishing from the panel is a bug
// this project has already produced twice in other forms, so it is counted.
const expectedDisks = snapshot.hosts.reduce(
  (n, h) => n + h.disks.filter((d) => d.selected).length,
  0,
);
check(
  countOf('disk-tile') === expectedDisks,
  `rendered ${countOf('disk-tile')} disk tiles, expected ${expectedDisks}`,
);

// One block per network mount, on the machine that reports it. Every mount must
// be shown: a machine whose NFS directory silently vanished from the panel is
// exactly the failure this display exists to catch.
const expectedNetMounts = snapshot.hosts.reduce((n, h) => n + h.net_mounts.length, 0);
check(
  countOf('net-tile') === expectedNetMounts,
  `rendered ${countOf('net-tile')} net-mount blocks, expected ${expectedNetMounts}`,
);

// One index cell and one model cell per card -- independent of row count, so a
// column dropped from the table is caught even if the rows still render.
check(
  countOf('cell-index') === expectedGpus,
  `rendered ${countOf('cell-index')} GPU index cells, expected ${expectedGpus}`,
);
check(
  countOf('cell-model') === expectedGpus,
  `rendered ${countOf('cell-model')} GPU model cells, expected ${expectedGpus}`,
);

// A dedicated column, not a footnote under the index.
check(html.includes('型号'), 'GPU model column header missing');

check(!html.includes('undefined'), 'markup contains literal "undefined"');
check(!html.includes('NaN'), 'markup contains literal "NaN"');
check(!html.includes('[object Object]'), 'markup contains "[object Object]"');

// ---------------------------------------------------------------------------
// API contract check.
//
// The UI does `JSON.parse(...) as Snapshot`, so nothing validates the response
// at runtime and a field renamed or emitted in the wrong case makes components
// read `undefined` silently. That is exactly how the disk figures came to
// render as "— / —": the server emitted `totalMib` while the type declared
// `total_mib`. These key sets mirror web/src/types.ts and are compared against
// the live response, including nested objects.
// ---------------------------------------------------------------------------
const CONTRACT: Record<string, string[]> = {
  host: [
    'id', 'label', 'group', 'ssh', 'expect_gpus', 'note', 'status', 'status_since', 'age_ms',
    'last_ok', 'last_attempt', 'consecutive_failures', 'last_error', 'poll_duration_ms',
    'total_polls', 'total_failures', 'warnings', 'stale', 'hostname', 'kernel', 'driver_version',
    'uptime_s', 'clock_skew_ms', 'nvidia_error', 'cpu', 'mem', 'disks', 'disks_configured',
    'net_mounts', 'note', 'gpus', 'users',
  ],
  cpu: ['pct', 'iowait_pct', 'ncpu', 'load1', 'load5', 'load15', 'running_procs', 'total_procs'],
  mem: ['total_mib', 'used_mib', 'avail_mib', 'pct', 'swap_total_mib', 'swap_used_mib'],
  gpu: [
    'index', 'uuid', 'name', 'display_name', 'util', 'mem_used_mib', 'mem_total_mib',
    'mem_pct', 'temp_c', 'power_w', 'fan_pct', 'n_procs', 'procs',
  ],
  gpu_proc: ['pid', 'username', 'name', 'used_mem_mib', 'sm_pct'],
  host_user: ['username', 'gpu_count', 'gpus', 'mem_mib', 'proc_count', 'sm_pct_avg', 'sm_pct_sum', 'procs'],
  user_proc: ['pid', 'name', 'gpu_index', 'used_mem_mib', 'sm_pct'],
  disk: ['path', 'mount', 'missing', 'selected', 'total_mib', 'used_mib', 'avail_mib', 'use_pct'],
  net_mount: ['path', 'fstype', 'status', 'expected'],
  global_user: ['username', 'gpu_count', 'mem_mib', 'proc_count', 'sm_pct_sum', 'sm_pct_avg', 'hosts'],
  summary: [
    'hosts_total', 'hosts_ok', 'hosts_stale', 'hosts_down', 'hosts_unknown', 'hosts_warning',
    'gpus_total', 'gpus_allocated', 'gpus_mem_used_mib', 'gpus_mem_total_mib',
    'procs_total', 'users_active',
  ],
  config: ['interval_ms', 'stale_after_ms', 'down_after_failures'],
};

// Top-level snapshot keys.
check(typeof snapshot.site === 'string' || snapshot.site === null, 'snapshot.site missing');
check(
  snapshot.announcement === null || typeof snapshot.announcement === 'object',
  'snapshot.announcement missing',
);

// The lab name identifies the whole installation, so it belongs in the page
// header once -- not repeated as a tag on every machine card. This render covers
// only the machine list, so the name must not appear here at all.
if (snapshot.site) {
  const repeats = countOf(snapshot.site);
  check(
    repeats === 0,
    `site name "${snapshot.site}" appears ${repeats}x inside the machine list; ` +
      'it should only be in the page header',
  );
}

const first = snapshot.hosts[0];
const samples: Record<string, unknown> = {
  host: first,
  cpu: first.cpu,
  mem: first.mem,
  gpu: first.gpus[0],
  gpu_proc: first.gpus.find((g) => g.procs.length > 0)?.procs[0],
  host_user: first.users[0],
  user_proc: first.users.find((u) => u.procs.length > 0)?.procs[0],
  disk: first.disks[0],
  net_mount: first.net_mounts[0],
  global_user: snapshot.users[0],
  summary: snapshot.summary,
  config: snapshot.config,
};

let contractChecked = 0;
for (const [name, expected] of Object.entries(CONTRACT)) {
  const value = samples[name];
  if (value === undefined || value === null) {
    // Legitimately empty on this cluster (e.g. no processes anywhere), so it is
    // reported rather than counted as a failure.
    console.log(`  (skipped ${name}: no sample data)`);
    continue;
  }
  const actual = Object.keys(value as Record<string, unknown>).sort();
  const want = [...expected].sort();
  const missing = want.filter((k) => !actual.includes(k));
  const extra = actual.filter((k) => !want.includes(k));
  check(
    missing.length === 0 && extra.length === 0,
    `${name} shape drift: ${missing.length ? `missing [${missing}]` : ''}${
      missing.length && extra.length ? ' ' : ''
    }${extra.length ? `unexpected [${extra}]` : ''}`,
  );
  contractChecked += 1;
}

// --- report -----------------------------------------------------------------
console.log(`hosts rendered     : ${snapshot.hosts.length} (${machines} cards)`);
console.log(`GPU rows rendered  : ${gpuRows} (expected ${expectedGpus})`);
console.log(`index/model cells  : ${countOf('cell-index')} / ${countOf('cell-model')}`);
console.log(`disk tiles         : ${countOf('disk-tile')} (expected ${expectedDisks}, selected only)`);
console.log(`net-mount blocks   : ${countOf('net-tile')} (expected ${expectedNetMounts})`);
console.log(`user rows          : ${countOf('user-row')} (expected ${snapshot.users.length})`);
console.log(`users rendered     : ${snapshot.users.map((u) => u.username).join(', ')}`);
console.log(`api shapes checked : ${contractChecked}/${Object.keys(CONTRACT).length}`);
console.log(`html size          : ${(html.length / 1024).toFixed(1)} KiB`);

// ---------------------------------------------------------------------------
// Synthetic edge cases.
//
// Live clusters rarely contain all of these at the same moment, but they are
// exactly where a card table breaks: an idle card, a card shared by three
// users, and a process whose owner could not be resolved. A row-per-process
// layout would render 4 rows for these 3 cards; a row-per-card layout must
// render 3.
// ---------------------------------------------------------------------------
const template = snapshot.hosts[0];
const card = (
  index: number,
  overrides: Partial<Gpu>,
): Gpu => ({
  index,
  uuid: `synthetic-${index}`,
  name: 'NVIDIA GeForce RTX 4090',
  display_name: 'RTX 4090 (24G)',
  util: 0,
  mem_used_mib: 0,
  mem_total_mib: 24564,
  mem_pct: 0,
  temp_c: 30,
  power_w: 20,
  fan_pct: 30,
  n_procs: 0,
  procs: [],
  ...overrides,
});

const sharedCard = card(1, {
  util: 100,
  mem_used_mib: 20000,
  mem_pct: 81,
  temp_c: 71,
  power_w: 300,
  n_procs: 3,
  procs: [
    { pid: 111111, username: 'alice', name: 'python train.py', used_mem_mib: 8000, sm_pct: 45 },
    { pid: 222222, username: 'bob', name: 'python eval.py', used_mem_mib: 7000, sm_pct: 35 },
    { pid: 333333, username: 'carol', name: 'python infer.py', used_mem_mib: 5000, sm_pct: 20 },
  ],
});

const synthetic: Snapshot = {
  ...snapshot,
  summary: { ...snapshot.summary, hosts_total: 1, hosts_ok: 1, gpus_total: 3 },
  users: [],
  hosts: [
    {
      ...template,
      id: 'synthetic',
      label: 'Synthetic',
      hostname: 'synthetic.invalid',
      expect_gpus: 3,
      status: 'ok',
      warnings: [],
      users: [],
      gpus: [
        card(0, {}), // idle
        sharedCard, // three users on one card
        card(2, {
          // process exited between nvidia-smi queries: owner unresolved
          util: 12,
          mem_used_mib: 100,
          mem_pct: 0.4,
          n_procs: 1,
          procs: [{ pid: 444444, username: null, name: 'unknown', used_mem_mib: 100, sm_pct: null }],
        }),
      ],
    },
  ],
};

const edgeHtml = render(<Overview snapshot={synthetic} now={now} />);
// The full per-process breakdown lives in the expanded row, which a collapsed
// SSR render never produces, so the shared card's detail table is rendered
// directly. This is the case the user asked about: several users, one card.
const expandedHtml = render(<ProcTable gpu={sharedCard} />);

const edgeChecks: [boolean, string][] = [
  [edgeHtml.includes('空闲'), 'idle card does not render as 空闲'],
  // The real requirement: NO process may be elided. The UI used to render only
  // the first process and summarise the rest as a count, so on a card shared by
  // two people the second person's name appeared nowhere in the table.
  [
    ['alice', 'bob', 'carol'].every((u) => edgeHtml.includes(u)),
    'a card shared by three users does not show all three',
  ],
  [
    ['111111', '222222', '333333'].every((p) => edgeHtml.includes(p)),
    'a card shared by three processes does not show all three PIDs',
  ],
  [edgeHtml.includes('alice@111111'), 'process chip is not in user@pid form'],
  [edgeHtml.includes('未知用户'), 'unresolved process owner is not labelled'],
  [
    countOf('gpu-row', edgeHtml) === 3,
    `edge case rendered ${countOf('gpu-row', edgeHtml)} rows, expected 3 (one per card)`,
  ],
  [!edgeHtml.includes('undefined') && !edgeHtml.includes('NaN'), 'edge markup contains undefined/NaN'],
  // expanded detail
  [['alice', 'bob', 'carol'].every((u) => expandedHtml.includes(u)), 'expanded table is missing a user'],
  // The expanded table has a column titled PID, so the value is rendered bare;
  // only the inline row summary prefixes it with '#'.
  [
    ['111111', '222222', '333333'].every((p) => expandedHtml.includes(p)),
    'expanded table is missing a PID',
  ],
  [expandedHtml.includes('python train.py'), 'expanded table is missing the process name'],
];
for (const [ok, label] of edgeChecks) check(ok, label);

console.log(
  `edge cases         : ${edgeChecks.filter(([ok]) => ok).length}/${edgeChecks.length} passed` +
    ` (idle card / 3 users on one card / unresolved owner / expanded detail)`,
);

if (failures.length) {
  console.error(`\nFAILED (${failures.length}):`);
  for (const f of failures.slice(0, 20)) console.error(`  - ${f}`);
  (globalThis as unknown as { process: { exit(code: number): void } }).process.exit(1);
}
console.log('\nSSR render check PASSED');
