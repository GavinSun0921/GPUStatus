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
