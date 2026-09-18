/**
 * Frontend invariants that are easy to break silently.
 *
 * Only two things live here, and both compare ARTEFACTS that must agree rather
 * than grepping source for expected strings:
 *
 *   1. the pre-paint theme script and the React hook share a storage key
 *   2. colours come from antd tokens, so one theme switch updates everything
 *
 * Three tests were removed from this file because they asserted that certain
 * TEXT existed in a source file -- `App.tsx` contains `darkAlgorithm`,
 * `severity.ts` contains `colorSuccess`, `Machine.tsx` contains
 * `host.group !== site`. Those pass or fail on refactoring rather than on
 * behaviour, and they duplicate what the render check now proves for real by
 * rendering under both theme algorithms and reading the tokens antd publishes.
 *
 * Run with: npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(HERE, '..');
const read = (p) => readFileSync(join(WEB, p), 'utf8');

/** Every hand-written source file that could contain a colour. */
function sourceFiles() {
  const components = readdirSync(join(WEB, 'src/components')).map((f) => `src/components/${f}`);
  return ['src/App.tsx', 'src/severity.ts', 'src/format.ts', 'src/styles.css', ...components];
}

test('the pre-paint theme script and theme.ts agree on the storage key', () => {
  // index.html applies the theme before first paint to avoid a flash of the
  // wrong colours; the React hook then takes over. If the two keys diverge the
  // saved choice is ignored on load and the page flashes -- with no error.
  const htmlKey = /localStorage\.getItem\('([^']+)'\)/.exec(read('index.html'))?.[1];
  const tsKey = /THEME_STORAGE_KEY = '([^']+)'/.exec(read('src/theme.ts'))?.[1];

  assert.ok(htmlKey, 'index.html does not read a theme key');
  assert.ok(tsKey, 'theme.ts does not declare THEME_STORAGE_KEY');
  assert.equal(htmlKey, tsKey);

  // The pre-paint script must also resolve "auto" from the OS preference,
  // otherwise a first-time visitor always starts light.
  assert.match(read('index.html'), /prefers-color-scheme:\s*dark/);
  assert.match(read('index.html'), /dataset\.theme/);
});

test('no hardcoded colours outside the theme layer', () => {
  // Colour must come from antd tokens (severity.ts) so that switching theme
  // updates everything. A literal like #f0f0f0 looks correct in light mode and
  // wrong in dark mode, and nothing reports it.
  const offenders = [];
  const pattern = /#[0-9a-fA-F]{3,8}\b|\brgba?\(/g;

  for (const file of sourceFiles()) {
    const text = read(file);
    for (const match of text.matchAll(pattern)) {
      const line = text.slice(0, match.index).split('\n').length;
      offenders.push(`${file}:${line} ${match[0]}`);
    }
  }

  assert.deepEqual(offenders, [], `hardcoded colours found:\n  ${offenders.join('\n  ')}`);
});

test('the severity ramp is reserved for things that are actually wrong', () => {
  // Colour on this dashboard has to mean "something is wrong", or people stop
  // reading it. The severity ramp (green -> amber -> red) therefore belongs only
  // to readings whose bad state breaks something:
  //
  //   disk usage       a full disk stops jobs writing checkpoints
  //   system memory    exhaustion triggers the OOM killer
  //   temperature      at the throttle point performance is silently lost
  //
  // It must NOT be applied to load, however high: a card at 100% utilisation
  // with full memory is a card running the job it was given. Every GPU that is
  // busy looked like an alarm until this was separated out.
  const machine = read('src/components/Machine.tsx');

  // Load metrics go through the neutral activity colour.
  assert.match(
    machine,
    /strokeColor=\{activityColor\(util, colors\)\}/,
    'GPU utilisation does not use the neutral activity colour',
  );
  assert.match(
    machine,
    /strokeColor=\{activityColor\(gpu\.mem_pct, colors\)\}/,
    'GPU memory does not use the neutral activity colour',
  );
  assert.ok(
    !/severity\(gpu\.mem_pct\)/.test(machine),
    'GPU memory is painted with the severity ramp -- a full card is expected, not a fault',
  );

  // The two that must keep it.
  assert.match(
    machine,
    /severity\(disk\.use_pct\)/,
    'disk usage no longer uses the severity ramp',
  );
});

// ------------------------------------------------- utilisation colouring ----
//
// The severity ramp answers "is this resource about to break?" and points the
// only way that makes sense: high = red. Utilisation is the opposite question.
// Feeding it through `severity` painted 97% red and 25% green on the users page,
// i.e. it treated a busy GPU as the problem, when the problem on a shared
// cluster is holding cards and not using them.
//
// The render check cannot see this class of bug: the colours are inline styles
// on a <span>, so the markup is identical whichever ramp is used. So the
// function is imported and its bands asserted directly.

const eff = await import('../src/severity.ts');
const COLOURS = { ok: 'ok', warn: 'WARN', danger: 'DANGER', accent: 'accent', muted: 'muted' };

test('a busy allocation is never flagged', () => {
  // These are the values the real cluster reports for its heaviest users, and
  // every one of them used to render red.
  for (const pct of [97.3, 93.1, 90.8, 89.8, 87.7, 62.3, 53]) {
    assert.equal(
      eff.efficiencyColor(pct, COLOURS),
      undefined,
      `${pct}% was coloured -- being busy is the desired state`,
    );
  }
});

test('an idle allocation is flagged, in proportion', () => {
  // The real case: 7 GPUs held at 0%.
  assert.equal(eff.efficiencyColor(0, COLOURS), 'DANGER');
  assert.equal(eff.efficiencyColor(9.9, COLOURS), 'DANGER');
  // 6 GPUs at 25% -- worth a look, not an alarm.
  assert.equal(eff.efficiencyColor(25.3, COLOURS), 'WARN');
  assert.equal(eff.efficiencyColor(29.9, COLOURS), 'WARN');
  // The boundary itself is not flagged.
  assert.equal(eff.efficiencyColor(30, COLOURS), undefined);
});

test('efficiency and severity point in opposite directions', () => {
  // Stated as a property so the two cannot quietly converge again.
  const severity = eff.severity(95);
  assert.equal(severity, 'danger', 'severity no longer flags high values');
  assert.equal(
    eff.efficiencyColor(95, COLOURS),
    undefined,
    'a 95% allocation is being flagged as a problem',
  );
  assert.equal(
    eff.efficiencyColor(2, COLOURS),
    'DANGER',
    'a 2% allocation is not being flagged',
  );
});

test('an unknown utilisation is not a colour', () => {
  // "No data" must not render as the reassuring end of the ramp.
  assert.equal(eff.efficiencyColor(null, COLOURS), undefined);
  assert.equal(eff.efficiencyColor(undefined, COLOURS), undefined);
  assert.equal(eff.efficiencyColor(Number.NaN, COLOURS), undefined);
});
