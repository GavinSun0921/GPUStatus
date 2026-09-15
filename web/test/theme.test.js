/**
 * Frontend invariants that are easy to break silently.
 *
 * These guard failures that produce no error at runtime: a hardcoded colour
 * simply looks wrong in one theme, and a mismatched storage key silently means
 * the wrong theme flashes on load.
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

test('both antd theme algorithms are wired up', () => {
  // Without this the light/dark switch would toggle its own label while the
  // page stayed on one algorithm -- a silent no-op.
  const app = read('src/App.tsx');
  assert.match(app, /darkAlgorithm/, 'App.tsx never selects antd darkAlgorithm');
  assert.match(app, /defaultAlgorithm/, 'App.tsx never selects antd defaultAlgorithm');
  assert.match(app, /ConfigProvider/, 'App.tsx does not use ConfigProvider');
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

test('severity colours are resolved from antd tokens, not literals', () => {
  // The single place colours are decided.
  const severity = read('src/severity.ts');
  assert.match(severity, /useToken\(\)/, 'severity.ts does not read antd tokens');
  for (const token of ['colorSuccess', 'colorWarning', 'colorError', 'colorPrimary']) {
    assert.match(severity, new RegExp(token), `severity.ts does not map ${token}`);
  }
});

test('the lab name is rendered in the header, not per machine', () => {
  // `site` identifies the installation, so it is shown once in the page header.
  // It previously appeared as a group tag on every machine card.
  const app = read('src/App.tsx');
  assert.match(app, /snapshot\?\.site/, 'App.tsx does not render the site name');
  assert.match(app, /document\.title/, 'browser title is not set');

  // The machine card must suppress a group that merely repeats the site name.
  const machine = read('src/components/Machine.tsx');
  assert.match(
    machine,
    /host\.group !== site/,
    'Machine.tsx would repeat the site name as a per-machine group tag',
  );
});
