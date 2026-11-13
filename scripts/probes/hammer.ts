/**
 * Load / race probe: fire N requests with concurrency C and report latency percentiles and
 * status counts. For "what happens under concurrency / is this index worth it" questions.
 *
 *   pnpm probe:hammer /health/db -n 500 -c 50
 *   pnpm probe:hammer /widgets -X POST -d '{"name":"x","color":"red","weightG":1}' -n 20 -c 20
 *   pnpm probe:hammer "/shipments?status=delivered&limit=50" --base http://localhost:3480
 *
 * Disposable probes for one-off questions go next to this file as scripts/probes/<question>.ts.
 */
import { argValue } from '../data/util.js';

const path = process.argv[2];
if (!path || path.startsWith('-')) {
  console.error('Usage: pnpm probe:hammer <path> [-n total] [-c concurrency] [-X METHOD] [-d json] [--base url]');
  process.exit(2);
}
const base = (argValue('--base') ?? process.env.E2E_BASE_URL ?? 'http://localhost:3480').replace(/\/$/, '');
const total = Number(argValue('-n') ?? 200);
const conc = Number(argValue('-c') ?? 20);
const method = argValue('-X') ?? 'GET';
const body = argValue('-d');

const lat: number[] = [];
const statuses = new Map<string, number>();
let next = 0;

async function worker() {
  while (next < total) {
    next++;
    const t0 = performance.now();
    let key: string;
    try {
      const res = await fetch(base + path, {
        method,
        headers: body ? { 'content-type': 'application/json' } : {},
        body,
      });
      await res.arrayBuffer();
      key = String(res.status);
    } catch (e) {
      key = `ERR ${(e as Error & { cause?: { code?: string } }).cause?.code ?? (e as Error).message}`;
    }
    lat.push(performance.now() - t0);
    statuses.set(key, (statuses.get(key) ?? 0) + 1);
  }
}

const t0 = performance.now();
await Promise.all(Array.from({ length: conc }, worker));
const wall = performance.now() - t0;
lat.sort((a, b) => a - b);
const p = (x: number) => lat[Math.min(lat.length - 1, Math.floor((x / 100) * lat.length))]!.toFixed(1);
console.log(`${method} ${base}${path}  n=${total} c=${conc}`);
console.log(`throughput: ${((total / wall) * 1000).toFixed(0)} req/s   wall: ${wall.toFixed(0)} ms`);
console.log(`latency ms: p50 ${p(50)}  p95 ${p(95)}  p99 ${p(99)}  max ${lat.at(-1)!.toFixed(1)}`);
console.log(`statuses: ${[...statuses].map(([k, v]) => `${k}×${v}`).join('  ')}`);
