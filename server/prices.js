/**
 * Standalone GPU rate card (`config/prices.json`).
 *
 * Deliberately NOT part of hosts.json: rates change on their own schedule
 * (semester, negotiated cloud quotes, new SKUs) and must not ride along with
 * machine edits or an admin-page save that rewrites the whole hosts document.
 *
 * Prices are applied at report time to the permanent occupied-GPU-hours
 * rollup. ONLY THE CURRENT RATES ARE EVER USED: this is an internal estimate
 * of research compute consumption, not real billing, so a rate change applies
 * to the whole history and old prices are discarded. Nothing cost-related is
 * stored in the database -- only the physical card-hours are. A model with no
 * entry stays unpriced rather than silently charging 0.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parseJsonc, PROJECT_ROOT } from './config.js';

export const DEFAULT_PRICES_PATH = resolve(PROJECT_ROOT, 'config/prices.json');
export const EXAMPLE_PRICES_PATH = resolve(PROJECT_ROOT, 'config/prices.example.json');

/**
 * Validate a rate-card document.
 *
 * @returns {{ rates: Record<string, number>, meta: { label?: string, note?: string }, path: string, usingExample: boolean }}
 */
export function loadPrices(pricesPath) {
  const preferred = pricesPath
    ? resolve(process.cwd(), pricesPath)
    : DEFAULT_PRICES_PATH;

  let path = preferred;
  let usingExample = false;
  if (!pricesPath && !existsSync(preferred) && existsSync(EXAMPLE_PRICES_PATH)) {
    path = EXAMPLE_PRICES_PATH;
    usingExample = true;
  }

  if (!existsSync(path)) {
    return { rates: {}, meta: {}, path: preferred, usingExample: false, missing: true };
  }

  let document;
  try {
    document = parseJsonc(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`Cannot parse ${path} as JSONC: ${err.message}`);
  }

  if (document === null || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error(`Price file ${path} must be a JSON object with a "rates" map`);
  }

  const rawRates = document.rates ?? document;
  if (rawRates === null || typeof rawRates !== 'object' || Array.isArray(rawRates)) {
    throw new Error(`Price file ${path}: "rates" must be an object of nvidia-smi name -> yuan/card-hour`);
  }

  const rates = {};
  for (const [rawName, value] of Object.entries(rawRates)) {
    // Allow a top-level document shape without "rates" to still pick up only
    // numeric leaves; anything else (label/note) is metadata, not a rate.
    if (rawName === 'label' || rawName === 'note' || rawName === 'currency' || rawName === 'unit') {
      continue;
    }
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) {
      throw new Error(
        `Price file ${path}: rates[${JSON.stringify(rawName)}] must be a number >= 0 (yuan per card-hour), got ${JSON.stringify(value)}`,
      );
    }
    rates[rawName] = n;
  }

  return {
    rates,
    meta: {
      label: document.label ? String(document.label) : undefined,
      note: document.note ? String(document.note) : undefined,
    },
    path,
    usingExample,
    missing: false,
  };
}

/** yuan / card-hour for a raw nvidia-smi name, or null when unlisted. */
export function priceOfGpuName(rawName, rates) {
  if (!rawName || !rates) return null;
  const p = rates[rawName];
  return typeof p === 'number' && Number.isFinite(p) ? p : null;
}
