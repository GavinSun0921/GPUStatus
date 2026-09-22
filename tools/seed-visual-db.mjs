/**
 * Seed a small local DB so cost/usage UI can be verified without the 779MB history.
 * Not part of the product; used by the visual check.
 */
import { Db, occupancyCost } from '../server/db/index.js';
import { loadPrices, priceOfGpuName } from '../server/prices.js';

const db = new Db('/tmp/gpustatus-visual/gpustatus.db', { intervalMs: 15000 });
const models = {
  gpu14: 'NVIDIA GeForce RTX 3090',
  gpu16: 'NVIDIA GeForce RTX 4090',
  gpu18: 'NVIDIA L40',
  gpu19: 'NVIDIA RTX 5880 Ada Generation',
  gpu20: 'NVIDIA RTX 6000D',
};
db.registerHosts(
  Object.keys(models).map((id) => ({ id, ssh: id, label: null, group: null, expectGpus: 8 })),
);

const now = Date.now();
const sample = (id, user, cards, sm) => ({
  ts: now,
  host: {
    cpuPct: 40, memPct: 55, ncpu: 64, load1: 8, load5: 7, load15: 6, runningProcs: 200,
    memTotalMib: 512000, memUsedMib: 280000, memAvailMib: 230000, swapTotalMib: 0, swapUsedMib: 0,
    iowaitPct: 2,
  },
  gpus: Array.from({ length: cards }, (_, i) => ({
    index: i, uuid: `${id}-u${i}`, name: models[id], util: sm, memUsedMib: 20000, memTotalMib: 48000,
    memUtil: 40, tempC: 70, powerW: 200, fanPct: null, nProcs: 1, throttleMask: 0,
    smClockMhz: 1500, smClockMaxMhz: 2500, powerLimitW: 300, pstate: 'P0', busId: `0${i}:00.0`,
  })),
  procs: Array.from({ length: cards }, (_, i) => ({
    gpuIndex: i, gpuUuid: `${id}-u${i}`, pid: 1000 + i, username: user, name: 'python',
    usedMemMib: 20000, smPct: sm,
  })),
  uptimeS: 86400, driverVersion: '580.178.04', hostname: `server${id.slice(3)}`, label: null,
});

for (const [id, user, cards, sm] of [
  ['gpu14', 'zhangxuanyu', 4, 80],
  ['gpu16', 'maoyuxin', 8, 35],
  ['gpu18', 'heyuting', 2, 90],
  ['gpu19', 'luzhicheng', 8, 12],
  ['gpu20', 'jinboning', 6, 70],
]) {
  db.recordSuccess(id, sample(id, user, cards, sm));
}

const hour = Math.floor(now / 3600000) * 3600000;
const ins = db.db.prepare(
  `INSERT INTO usage_rollup (bucket_ts, host_id, username, gpu_seconds, sm_gpu_seconds,
     mem_mib_seconds, peak_gpus, peak_mem_mib, samples)
   VALUES (?,?,?,?,?,?,?,?,1)`,
);
for (const [h, u, g, s, m] of [
  ['gpu14', 'zhangxuanyu', 3600 * 200, 3600 * 170, 3600 * 80000],
  ['gpu16', 'maoyuxin', 3600 * 48, 3600 * 16, 3600 * 90000],
  ['gpu18', 'heyuting', 3600 * 60, 3600 * 55, 3600 * 20000],
  ['gpu19', 'luzhicheng', 3600 * 90, 3600 * 10, 3600 * 200000],
  ['gpu20', 'jinboning', 3600 * 30, 3600 * 24, 3600 * 150000],
]) {
  ins.run(hour, h, u, g, s, m, Math.max(1, Math.round(g / 3600 / 4)), m / 3600);
}
const peak = db.db.prepare('INSERT OR REPLACE INTO usage_peak (bucket_ts, username, peak_gpus) VALUES (?,?,?)');
for (const [u, p] of [['zhangxuanyu', 4], ['maoyuxin', 8], ['heyuting', 2], ['luzhicheng', 8], ['jinboning', 6]]) {
  peak.run(hour, u, p);
}

const names = db.loadHostGpuNames();
const book = loadPrices();
let cost = 0;
for (const r of db.queryUsageByUserHost({ fromTs: now - 30 * 86400000, toTs: now + 86400000 })) {
  const c = occupancyCost(r.gpu_seconds, r.sm_gpu_seconds, names.get(r.host_id), (n) => priceOfGpuName(n, book.rates));
  console.log(r.username, r.host_id, c);
  cost += c.cost_yuan ?? 0;
}
console.log('total cost', cost, 'models', Object.fromEntries(names));
db.close();
