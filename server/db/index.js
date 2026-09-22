/**
 * Persistence layer facade.
 *
 * Uses `better-sqlite3`, whose synchronous `prepare` / `run` / `get` / `all` API
 * is what Node's built-in `node:sqlite` was modelled on; the two are
 * interchangeable, and this one is stable rather than a release candidate.
 * All state lives in one portable .db file.
 *
 * The previous single-file layout mixed DDL, one-shot repairs, the write path
 * and the read queries in one 1200-line module. They are now split by
 * responsibility under `server/db/`; this class is the only public entry point
 * and keeps the same surface as the old `Db`.
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * better-sqlite3 rather than the built-in `node:sqlite`.
 *
 * Both were tried. `node:sqlite` needs no installation, which was the original
 * reason for choosing it, but Node's own documentation still lists it as
 * "Stability: 1.2 - Release candidate" rather than stable, and it forced a
 * Node >= 22.5 floor on the deployment machine. better-sqlite3 is the library
 * node:sqlite's API was modelled on -- `prepare` / `run` / `get` / `all` /
 * `exec` are identical, so the swap touched one import -- and it installs from
 * a prebuilt binary in well under a second, with no compiler.
 */
import Database from 'better-sqlite3';

import {
  backfillHostGpuNames,
  backfillHostHourly,
  backfillUsagePeak,
  repairLostProcessSm,
  repairTruncatedUsernames,
} from './repairs.js';
import * as q from './queries.js';
import { createStatements } from './statements.js';
import { addMissingColumns, createSchema, migrateIndexes } from './schema.js';
import * as w from './writes.js';

export { aggregateUserUsage, HOUR_MS, SCHEMA_VERSION, THROTTLE_BAD_BITS, n, s } from './helpers.js';
export { occupancyCost } from './queries.js';

export class Db {
  constructor(filePath, { intervalMs = 5000 } = {}) {
    if (filePath !== ':memory:') mkdirSync(dirname(filePath), { recursive: true });
    this.db = new Database(filePath);
    this.filePath = filePath;
    this.intervalMs = intervalMs;

    // WAL keeps the poller writing while the API reads. NORMAL synchronous mode
    // is the right durability/speed trade-off for monitoring data.
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec('PRAGMA foreign_keys = ON');

    createSchema(this.db);
    addMissingColumns(this.db);
    migrateIndexes(this.db);

    const { merged, ambiguous } = repairTruncatedUsernames(this.db);
    this.repairedUsernames = merged;
    if (ambiguous.length > 0) this.truncatedNameAmbiguities = ambiguous;

    backfillUsagePeak(this.db);
    this.repairedSmRows = repairLostProcessSm(
      this.db,
      (k) => this.getMeta(k),
      (k, v) => this.setMeta(k, v),
    );

    const backfilled = backfillHostHourly(this.db);
    if (backfilled > 0) this.backfilledHours = backfilled;
    backfillHostGpuNames(this.db);

    this.stmt = createStatements(this.db);
    this.prevTs = q.loadPrevTimestamps(this.db);
  }

  // ---------------------------------------------------------------- writes --

  registerHosts(hosts, now = Date.now()) {
    w.registerHosts(this.stmt, hosts, now);
  }

  markAttempt(hostId, ts) {
    w.markAttempt(this.stmt, hostId, ts);
  }

  recordEvent(ts, hostId, kind, message) {
    w.recordEvent(this.stmt, ts, hostId, kind, message);
  }

  recordFailure(hostId, ts, error) {
    w.recordFailure(this.stmt, hostId, ts, error);
  }

  recordSuccess(hostId, sample) {
    w.recordSuccess(this.db, this.stmt, this.prevTs, this.intervalMs, hostId, sample);
  }

  recordCyclePeaks(collected) {
    w.recordCyclePeaks(this.db, this.stmt, collected);
  }

  /** Drop raw samples past the retention window. Rollups are never pruned. */
  pruneRaw(retentionHours, now = Date.now()) {
    return w.pruneRaw(this.db, this.stmt, retentionHours, now);
  }

  // --------------------------------------------------------------- queries --

  queryUsage(opts) {
    return q.queryUsage(this.db, opts);
  }

  queryUsageTotals(opts) {
    return q.queryUsageTotals(this.db, opts);
  }

  queryUsageByUserHost(opts) {
    return q.queryUsageByUserHost(this.db, opts);
  }

  loadHostGpuNames() {
    return q.loadHostGpuNames(this.db);
  }

  queryHostHourly(hostId, fromTs, toTs) {
    return q.queryHostHourly(this.db, hostId, fromTs, toTs);
  }

  queryEvents(opts) {
    return q.queryEvents(this.db, opts);
  }

  queryRecentUsers(sinceTs) {
    return q.queryRecentUsers(this.db, sinceTs);
  }

  // ------------------------------------------------------------------ meta --

  getMeta(key) {
    return q.getMeta(this.db, key);
  }

  setMeta(key, value) {
    q.setMeta(this.db, key, value);
  }

  close() {
    this.db.close();
  }
}
