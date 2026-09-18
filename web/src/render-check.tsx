/**
 * Render smoke test.
 *
 * Fetches a REAL snapshot from the running backend, renders the data-bearing
 * components into a jsdom document, and asserts against the resulting DOM.
 * Type-checking and contract checks prove the shapes line up; only rendering
 * proves the components do not throw on real data.
 *
 * Was named ssr-check when it rendered to a static HTML string and asserted on
 * that string with substring counts; see the note by the jsdom setup for why
 * that was replaced.
 *
 * Run against a live backend:
 *   npm run check:render
 */

import { JSDOM } from 'jsdom';
import { SnapshotSchema } from '../../shared/schema';
import type { Gpu, Snapshot } from './types';

// A real DOM, installed BEFORE React and antd are imported (hence the dynamic
// imports below: ESM hoists static ones, which would run antd before `document`
// exists).
//
// This replaced rendering to a static HTML string and asserting on it with
// substring counts. Counting occurrences of "gpu-row" in markup is not the same
// as counting rows: adding a second class `gpu-row-expandable` made every row
// count twice (48 rows reported as 95), and a class named `cell-model-REMOVED`
// still matched "cell-model". Both happened. Element queries do not have that
// failure mode, and they are what @testing-library exists to provide.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
// defineProperty, not assignment: Node 24 defines `navigator` as a getter-only
// global, so a plain `globalThis.navigator = ...` throws.
const install = (name: string, value: unknown) =>
  Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });

// antd's responsive observer and rc-* reach for these on `window`, and jsdom
// does not implement matchMedia at all.
const matchMediaStub = (query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false,
});
Object.defineProperty(dom.window, 'matchMedia', { value: matchMediaStub, writable: true });

// Everything antd and recharts touch, taken straight off the jsdom window.
for (const name of [
  'window', 'document', 'navigator', 'location', 'history',
  'HTMLElement', 'HTMLDivElement', 'HTMLInputElement', 'SVGElement', 'Element', 'Node',
  'Event', 'MouseEvent', 'KeyboardEvent', 'CustomEvent', 'DOMRect', 'DOMParser',
  'getComputedStyle', 'ResizeObserver', 'MutationObserver', 'IntersectionObserver',
  'matchMedia',
] as const) {
  const value = (dom.window as unknown as Record<string, unknown>)[name];
  if (value === undefined) continue;
  install(name, typeof value === 'function' && name === 'getComputedStyle'
    ? value.bind(dom.window)
    : value);
}
install('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0));
install('cancelAnimationFrame', (id: number) => clearTimeout(id));

// jsdom implements neither observer. antd's table and the chart container
// construct them on mount; a no-op that simply never fires is enough, since
// this check asserts what is rendered, not how it is measured.
class NoopObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}
install('ResizeObserver', NoopObserver);
install('IntersectionObserver', NoopObserver);

const { render } = await import('@testing-library/react');
const { ConfigProvider, theme } = await import('antd');
const zhCN = (await import('antd/locale/zh_CN')).default;
const { Overview } = await import('./components/Overview');
const { ProcTable, CardTelemetry } = await import('./components/Machine');
const { MachineInfo } = await import('./components/MachineInfo');
const { UserProcTable, UsersView } = await import('./components/Reports');

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

/** antd needs its ConfigProvider for tokens/locale. */
const renderView = (node: React.ReactNode, algorithm = theme.defaultAlgorithm) =>
  render(<ConfigProvider locale={zhCN} theme={{ algorithm }}>{node}</ConfigProvider>).container;

const view = renderView(
  <>
    <Overview snapshot={snapshot} now={now} />
    <UsersView snapshot={snapshot} />
  </>,
);

/**
 * The inline colour applied to a table cell whose text is `needle`.
 *
 * Colours live in a style attribute, so they are invisible to every text- and
 * markup-based check. This is the only way to catch a ramp wired up backwards.
 */
function cellColour(container: HTMLElement, needle: string): string {
  for (const el of container.querySelectorAll<HTMLElement>('span, td')) {
    if ((el.textContent ?? '').trim() !== needle) continue;
    const own = el.style?.color;
    if (own) return own;
    const child = el.querySelector<HTMLElement>('[style*="color"]');
    if (child) return child.style.color;
  }
  return '';
}

// --- assertions -------------------------------------------------------------
const failures: string[] = [];
const check = (condition: boolean, label: string) => {
  if (!condition) failures.push(label);
};

/** Visible text only: an attribute value is not something the operator can read. */
const text = view.textContent ?? '';
/** Raw markup, for the checks that must catch a leaked value in ANY position. */
const html = view.innerHTML;
/**
 * Count ELEMENTS carrying a class -- not occurrences of a substring.
 *
 * `countOf('gpu-row')` returns one per row even when the element also carries
 * `row-clickable`, which is the bug substring counting produced.
 */
const countOf = (className: string, root: Element | Document = view) =>
  root.querySelectorAll(`.${className}`).length;
/** Occurrences in visible text, for "this string must appear exactly once". */
const countText = (needle: string, haystack: string = text) =>
  haystack.split(needle).length - 1;

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
const machines = view.querySelectorAll('[id^="host-"]').length;
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
  `rendered ${countOf('cell-index')} index cells, expected ${expectedGpus}`,
);
check(
  countOf('cell-model') === expectedGpus,
  `rendered ${countOf('cell-model')} GPU model cells, expected ${expectedGpus}`,
);

// The machine detail panel is collapsed by default, so it is absent from the
// markup above by design -- render it explicitly here.
//
// Asserted by label because the failure mode is a field quietly dropping out of
// the panel, which the type system cannot see (an optional field that stops
// being rendered still compiles).
const detailView = renderView(<MachineInfo host={snapshot.hosts[0]} />);
const detailText = detailView.textContent ?? '';
for (const label of [
  '主机名',
  'SSH 目标',
  '内核',
  '显卡驱动',
  'PCIe 链路',
  '采集成功',
  '上次采集耗时',
  '时钟偏差',
  '负载 1/5/15',
  'IO 等待',
]) {
  check(detailText.includes(label), `machine detail is missing "${label}"`);
}

// And the per-card telemetry, shown when a card row is expanded.
const telemetryView = renderView(<CardTelemetry gpu={snapshot.hosts[0].gpus[0]} />);
const telemetryText = telemetryView.textContent ?? '';
for (const label of ['SM 时钟', '显存带宽', '风扇', 'P-State', 'PCIe', '降频原因']) {
  check(telemetryText.includes(label), `card telemetry is missing "${label}"`);
}

// The cooling meter is the at-a-glance answer to "which machine's cooling is
// struggling", so it must be present on every card and must not be a percentage
// of some invented maximum.
// (The first version of this check read `countOf('散热') === 0 || include(...)`,
// which short-circuited to always true -- `countOf` counts CLASSES, and there is
// no `散热` class, so the assertion could never fail. Keep it to text.)
check(html.includes('散热'), 'the machine card is missing its cooling meter');
check(
  html.includes('距降频') || html.includes('近期热降频') || html.includes('已达降频温度'),
  'the cooling meter renders no headroom or throttle state',
);

// Every machine must offer its detail toggle, and the chart must NOT be in the
// initial markup -- it is collapsed by default and fetched on demand, so a
// chart appearing here would mean the lazy behaviour had been lost.
check(
  countOf('detail-toggle') === snapshot.hosts.length,
  `rendered ${countOf('detail-toggle')} detail toggles, expected ${snapshot.hosts.length}`,
);

// A dedicated column, not a footnote under the index.
check(html.includes('型号'), 'GPU model column header missing');

check(!html.includes('undefined'), 'markup contains literal "undefined"');
check(!html.includes('NaN'), 'markup contains literal "NaN"');
check(!html.includes('[object Object]'), 'markup contains "[object Object]"');

// A `//` line sitting in JSX *children* is literal text, not a comment, and is
// rendered on the page. TypeScript accepts it, the tests pass, and the only
// symptom is visible garbage in the UI -- which is exactly how a 5-line comment
// ended up printed inside every GPU model cell. Strip the tags and look for a
// line that starts with a comment marker (a URL's `https://` never starts one).
const textContent = html.replace(/<[^>]*>/g, '\n');
check(
  !/\n[ \t]*\/\//.test(textContent),
  'a JSX line comment leaked into the page as visible text',
);

// ---------------------------------------------------------------------------
// Theme behaviour.
//
// This replaces two tests that grepped App.tsx for the strings `darkAlgorithm`
// and `colorSuccess`: that only proved the text existed, and broke on any
// refactor that moved the code without changing behaviour. Rendering the same
// tree under both algorithms and comparing the output proves the thing that
// actually matters -- that theme tokens reach the components.
{
  // antd v6 publishes its tokens as CSS custom properties in an injected
  // <style> tag -- NOT as inline styles, which is why computing a colour from
  // an element returns `var(--ant-color-text)` and tells you nothing. Reading
  // the variable itself is the observable signal.
  //
  // Styles accumulate in document.head across renders, so the LAST occurrence
  // of a variable belongs to the most recent render.
  const lastVar = (name: string) => {
    const css = [...dom.window.document.querySelectorAll('style')]
      .map((el) => el.textContent ?? '')
      .join('');
    const all = [...css.matchAll(new RegExp(`--${name}:\\s*([^;]+)`, 'g'))];
    return all.length ? all[all.length - 1][1].trim() : null;
  };
  /** Perceived brightness, 0 (black) to 1 (white). */
  const brightness = (colour: string | null) => {
    const hex = colour && /^#([0-9a-f]{6})$/i.exec(colour.trim());
    if (!hex) return null;
    const n = parseInt(hex[1], 16);
    return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
  };

  renderView(<Overview snapshot={snapshot} now={now} />, theme.defaultAlgorithm);
  const lightBg = lastVar('ant-color-bg-container');
  renderView(<Overview snapshot={snapshot} now={now} />, theme.darkAlgorithm);
  const darkBg = lastVar('ant-color-bg-container');

  check(lightBg !== null && darkBg !== null, 'antd published no background token to inspect');
  check(lightBg !== darkBg, `both themes publish the same background (${lightBg})`);

  const lightLum = brightness(lightBg);
  const darkLum = brightness(darkBg);
  check(
    lightLum !== null && darkLum !== null && darkLum < lightLum,
    `the "dark" theme is not darker than the light one (${darkBg} vs ${lightBg})`,
  );
}

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
// The API contract is no longer listed field-by-field here.
//
// A hand-maintained table of ~60 field names per shape was one of THREE copies
// of the same information (with `web/src/types.ts` and `server/state.js`), and
// it had already drifted -- `note` appeared twice in `host`. It existed because
// nothing validated the response at runtime.
//
// `shared/schema.ts` now defines the shape once and validates it, on every SSE
// push, in `web/src/api.ts`. So this check asserts the thing that file cannot:
// that a REAL snapshot from a RUNNING backend satisfies that schema.
// The lab name identifies the whole installation, so it belongs in the page
// header once -- not repeated as a tag on every machine card. This render covers
// only the machine list, so the name must not appear here at all.
//
// (This was collateral damage when the CONTRACT table above was deleted: it sat
// between the table and the report section, and removing a block by index range
// took it too.)
if (snapshot.site) {
  const repeats = countText(snapshot.site);
  check(
    repeats === 0,
    `site name "${snapshot.site}" appears ${repeats}x inside the machine list; ` +
      'it should only be in the page header',
  );
}

const validation = SnapshotSchema.safeParse(snapshot);
check(
  validation.success,
  validation.success
    ? ''
    : `live snapshot violates the contract: ${validation.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ')}`,
);

// --- report -----------------------------------------------------------------
console.log(`hosts rendered     : ${snapshot.hosts.length} (${machines} cards)`);
console.log(`GPU rows rendered  : ${gpuRows} (expected ${expectedGpus})`);
console.log(`index/model cells  : ${countOf('cell-index')} / ${countOf('cell-model')}`);
console.log(`disk tiles         : ${countOf('disk-tile')} (expected ${expectedDisks}, selected only)`);
console.log(`net-mount blocks   : ${countOf('net-tile')} (expected ${expectedNetMounts})`);
console.log(`user rows          : ${countOf('user-row')} (expected ${snapshot.users.length})`);
console.log(`detail toggles     : ${countOf('detail-toggle')} (one per machine, charts collapsed)`);
console.log(`users rendered     : ${snapshot.users.map((u) => u.username).join(', ')}`);
console.log(`api contract       : ${validation.success ? 'valid' : 'VIOLATED'} (validated by shared/schema.ts)`);
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
  mem_util_pct: 20,
  pcie_gen: 4,
  pcie_width: 16,
  pcie_gen_max: 4,
  pcie_width_max: 16,
  n_procs: 0,
  procs: [],
  throttle_mask: 0,
  throttle_reasons: [],
  throttled: false,
  thermal_recent_pct: null,
  sm_clock_mhz: 2500,
  sm_clock_max_mhz: 2520,
  power_limit_w: 450,
  pstate: 'P0',
  bus_id: `0${index}:00.0`,
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
    { pid: 111111, username: 'alice', name: 'python train.py', elapsed_s: 3600, used_mem_mib: 8000, sm_pct: 45 },
    { pid: 222222, username: 'bob', name: 'python eval.py', elapsed_s: 7200, used_mem_mib: 7000, sm_pct: 35 },
    { pid: 333333, username: 'carol', name: 'python infer.py', elapsed_s: 10800, used_mem_mib: 5000, sm_pct: 20 },
  ],
});

const synthetic: Snapshot = {
  ...snapshot,
  summary: { ...snapshot.summary, hosts_total: 1, hosts_ok: 1, gpus_total: 4 },
  // Two users at opposite ends of the utilisation range. The whole point of
  // this pair is the COLOURS, which no other check can see: they are inline
  // styles, so the markup is byte-identical whichever ramp is used -- which is
  // exactly how 97% came to be painted red on the live dashboard.
  users: [
    {
      username: 'busy', gpu_count: 4, mem_mib: 40000, proc_count: 4,
      sm_pct_avg: 96.5, sm_pct_sum: 386,
      hosts: [{ id: 'synthetic', label: 'Synthetic', gpu_count: 4, gpus: [0, 1, 2, 3] }],
    },
    {
      username: 'idle', gpu_count: 4, mem_mib: 40000, proc_count: 4,
      sm_pct_avg: 2.5, sm_pct_sum: 10,
      hosts: [{ id: 'synthetic', label: 'Synthetic', gpu_count: 4, gpus: [0, 1, 2, 3] }],
    },
  ],
  hosts: [
    {
      ...template,
      id: 'synthetic',
      label: 'Synthetic',
      hostname: 'synthetic.invalid',
      expect_gpus: 4,
      status: 'ok',
      // The exact code Server19 produced when five of its eight cards were in
      // thermal slowdown. It must reach the card as Chinese, not as a raw code.
      warnings: ['throttled:5/8_thermal'],
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
          procs: [{ pid: 444444, username: null, name: 'unknown', elapsed_s: null, used_mem_mib: 100, sm_pct: null }],
        }),
        card(3, {
          // thermally throttled at 100% utilisation -- the case the whole
          // health-telemetry change exists for, and the one an operator cannot
          // spot from utilisation or temperature alone
          util: 100,
          mem_used_mib: 40000,
          mem_pct: 83,
          temp_c: 87,
          power_w: 260,
          n_procs: 1,
          procs: [
            { pid: 555555, username: 'dave', name: 'python train.py', elapsed_s: 86400, used_mem_mib: 40000, sm_pct: 98 },
          ],
          throttle_mask: 0x20,
          throttle_reasons: ['热降频'],
          throttled: true,
          thermal_recent_pct: 12.5,
          sm_clock_mhz: 765,
          sm_clock_max_mhz: 3105,
        }),
      ],
    },
  ],
};

const edgeView = renderView(<Overview snapshot={synthetic} now={now} />);
const edgeText = edgeView.textContent ?? '';
const edgeHtml = edgeView.innerHTML;
// The full per-process breakdown lives in the expanded row, which a collapsed
// SSR render never produces, so the shared card's detail table is rendered
// directly. This is the case the user asked about: several users, one card.
const expandedView = renderView(<ProcTable gpu={sharedCard} />);
const expandedText = expandedView.textContent ?? '';

// The user page's per-process breakdown, likewise rendered directly: it lives in
// an expanded row, which a collapsed render never produces.
const userProcView = renderView(
  <UserProcTable
    rows={[
      { hostId: 'h1', hostLabel: 'Server19', pid: 4242, name: 'train.py', gpu_index: 3, elapsed_s: 273_600, used_mem_mib: 40_000, sm_pct: 91 },
    ]}
  />,
);
const userProcText = userProcView.textContent ?? '';

// The users table, rendered from the synthetic snapshot so two users sit at
// opposite ends of the utilisation range.
const userView = renderView(<UsersView snapshot={synthetic} />);
const busyColour = cellColour(userView, '96.5%');
const idleColour = cellColour(userView, '2.5%');

const edgeChecks: [boolean, string][] = [
  // Colours are inline styles, so nothing else on this page can see them. The
  // users table used to paint 97% red and 25% green -- backwards, because it
  // went through the severity ramp, which answers "is this about to break?"
  // rather than "is this allocation being used?".
  [
    !busyColour,
    `a 96.5% allocation is coloured (${busyColour}) -- a busy GPU is the goal, not a fault`,
  ],
  [
    Boolean(idleColour),
    'a 2.5% allocation is not coloured -- holding GPUs without using them is the thing to flag',
  ],
  [
    !idleColour || busyColour !== idleColour,
    'the busy and idle rows share a colour, so the ramp is not distinguishing them',
  ],
  [edgeText.includes('空闲'), 'idle card does not render as 空闲'],
  // The real requirement: NO process may be elided. The UI used to render only
  // the first process and summarise the rest as a count, so on a card shared by
  // two people the second person's name appeared nowhere in the table.
  [
    ['alice', 'bob', 'carol'].every((u) => edgeText.includes(u)),
    'a card shared by three users does not show all three',
  ],
  [
    ['111111', '222222', '333333'].every((p) => edgeText.includes(p)),
    'a card shared by three processes does not show all three PIDs',
  ],
  [edgeText.includes('alice@111111'), 'process chip is not in user@pid form'],
  // The throttled card must be marked. Without this the card reads as a healthy
  // 100%-utilisation GPU, which is exactly the failure mode that hid Server19's
  // thermal throttling.
  [countOf('throttle-tag', edgeView) === 1, 'throttled card is not marked'],
  // warningLabel() must translate the code; a raw "throttled:5/8_thermal" on
  // screen would be unreadable to the person on duty.
  [edgeText.includes('5/8 张卡热降频'), 'throttle warning is not rendered in Chinese'],
  [!edgeText.includes('throttled:5/8_thermal'), 'raw throttle code leaked into the UI'],
  [edgeText.includes('降频'), 'throttle tag has no text'],
  [edgeText.includes('未知用户'), 'unresolved process owner is not labelled'],
  [
    countOf('gpu-row', edgeView) === 4,
    `edge case rendered ${countOf('gpu-row', edgeView)} rows, expected 3 (one per card)`,
  ],
  [!edgeHtml.includes('undefined') && !edgeHtml.includes('NaN'), 'edge markup contains undefined/NaN'],
  // The user page's process table must say how long each job has been running.
  // A job holding a card for days is the usual reason a GPU looks busy while
  // nobody gets anything out of it -- and without this the table showed what was
  // running but not for how long, so a stuck job looked like a fresh one.
  [userProcText.includes('已运行'), 'user process table is missing the 已运行 column'],
  // 273600s = 3d4h. Asserting the RENDERED duration, not just the header: a
  // column whose cells are blank passes a header-only check.
  [userProcText.includes('3d'), 'the 已运行 column renders no duration'],
  [userProcText.includes('Server19'), 'user process table lost its host column'],

  // expanded detail
  [['alice', 'bob', 'carol'].every((u) => expandedText.includes(u)), 'expanded table is missing a user'],
  // The expanded table has a column titled PID, so the value is rendered bare;
  // only the inline row summary prefixes it with '#'.
  [
    ['111111', '222222', '333333'].every((p) => expandedText.includes(p)),
    'expanded table is missing a PID',
  ],
  [expandedText.includes('python train.py'), 'expanded table is missing the process name'],
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
console.log('\nrender check PASSED');
