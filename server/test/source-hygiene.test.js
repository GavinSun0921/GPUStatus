/**
 * Source-level checks that must work even when the code does not parse.
 *
 * The SQL in this project lives inside JavaScript template literals. A backtick
 * in a `--` comment therefore terminates the literal early, and the compiler
 * then reports something entirely unrelated to the cause -- the first two times
 * this happened it surfaced as "Private field '#migrate' must be declared in an
 * enclosing class", which says nothing about a stray backtick in a comment.
 *
 * This file reads the sources as TEXT and imports nothing, so it still runs and
 * points at the offending line when one of them is broken.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = resolve(HERE, '..');

function sourceFiles() {
  return readdirSync(SERVER)
    .filter((f) => f.endsWith('.js') || f.endsWith('.ts'))
    .map((f) => join(SERVER, f));
}

test('no backtick inside a SQL comment in a template literal', () => {
  const problems = [];
  for (const file of sourceFiles()) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      // A `--` SQL comment line carrying a backtick. Inside a template literal
      // that backtick closes the string.
      if (/^\s*--/.test(line) && line.includes('`')) {
        problems.push(`${file.slice(SERVER.length + 1)}:${index + 1}  ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(
    problems,
    [],
    `a backtick in a SQL comment ends the surrounding template literal:\n  ${problems.join('\n  ')}`,
  );
});

test('template literals in server sources are balanced', () => {
  // A cheap structural check: an odd number of backticks in a file means one is
  // unterminated, whatever the compiler chose to complain about instead.
  for (const file of sourceFiles()) {
    const text = readFileSync(file, 'utf8');
    // Ignore escaped backticks; the project uses none, but be explicit.
    const count = (text.match(/(?<!\\)`/g) ?? []).length;
    assert.equal(
      count % 2,
      0,
      `${file.slice(SERVER.length + 1)} has an odd number of backticks (${count}) -- one is unterminated`,
    );
  }
});

test('ps invocations pin the USER column width', () => {
  // With several output columns `ps` applies its default widths rather than
  // sizing to the content, and USER defaults to 8 characters. `ps -o
  // pid=,user=,etime=` therefore returned `luzhich+` for `luzhicheng`, and that
  // truncated name reached the usage rollup -- splitting one person's GPU-hours
  // across two rows in the accounting table.
  //
  // A bare `-o user=` column auto-sizes, which is why this only appeared once a
  // second column was added. Any `user=` in a ps format list must carry an
  // explicit width.
  const probe = readFileSync(join(SERVER, 'remote-probe.sh'), 'utf8');
  const problems = [];
  for (const line of probe.split('\n')) {
    if (!/\bps\b/.test(line) || line.trimStart().startsWith('#')) continue;
    if (/user=(?![0-9])/.test(line)) problems.push(line.trim());
  }
  assert.deepEqual(
    problems,
    [],
    `ps -o user= without a width truncates to 8 characters:\n  ${problems.join('\n  ')}`,
  );
});
