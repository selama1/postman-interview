#!/usr/bin/env node
/**
 * Demonstrate that the containerized service talks to the containerized database.
 *
 *   pnpm demo              steps 1-4 (about 30 s)
 *   pnpm demo --smoke      also step 5, the end-to-end smoke test (slower)
 *   pnpm demo --no-outage  skip step 4 (it stops and restarts the db container)
 *
 * Each step prints what it shows, the exact command (copy-paste ready in PowerShell), the
 * command's output, and PASS/FAIL with the reason and the fix. Exit code 0 = every step passed.
 * Step 4 always restarts the db container, even if the step fails or the script is interrupted.
 */
import { spawnSync } from 'node:child_process';

const argv = process.argv.slice(2);
const withSmoke = argv.includes('--smoke');
const withOutage = !argv.includes('--no-outage');
const API = process.env.API_URL ?? 'http://localhost:3480';
const win = process.platform === 'win32';
const dockerOnPath = spawnSync('docker --version', { stdio: 'ignore', shell: true }).status === 0;

const C = process.stdout.isTTY ? { b: '\x1b[1m', g: '\x1b[32m', r: '\x1b[31m', d: '\x1b[2m', n: '\x1b[0m' } : { b: '', g: '', r: '', d: '', n: '' };
const results = [];

/** Run a command line through the shell, exactly as printed. */
function sh(cmdline, { timeout = 120_000 } = {}) {
  const r = spawnSync(cmdline, { shell: true, encoding: 'utf8', timeout });
  return { ok: r.status === 0, status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trimEnd() };
}

function step(n, title, what, cmdline) {
  console.log(`\n${C.b}Step ${n}. ${title}${C.n}`);
  console.log(`  What it shows: ${what}`);
  console.log(`  Command:       ${C.b}${cmdline}${C.n}`);
}

function show(out) {
  const lines = out.split('\n');
  const shown = lines.length > 25 ? [...lines.slice(0, 10), `... (${lines.length - 20} lines) ...`, ...lines.slice(-10)] : lines;
  console.log(`${C.d}${shown.map((l) => `    | ${l}`).join('\n')}${C.n}`);
}

function verdict(n, ok, result, fix) {
  results.push({ n, ok, result });
  console.log(`  Result:        ${ok ? `${C.g}PASS${C.n}` : `${C.r}FAIL${C.n}`}  ${result}`);
  if (!ok && fix) console.log(`  Fix:           ${fix}`);
}

function json(s) {
  try { return JSON.parse(s); } catch { return null; }
}

const curlCmd = (path) => `curl.exe -s -w "\\nHTTP %{http_code}" ${API}${path}`;
function curl(path) {
  const r = sh(win ? curlCmd(path) : curlCmd(path).replace('curl.exe', 'curl'));
  const m = r.out.match(/\nHTTP (\d{3})$/);
  return { ...r, code: m ? Number(m[1]) : 0, body: m ? r.out.slice(0, m.index) : r.out };
}

// --- Step 1: both pieces run in containers ---------------------------------------------------
{
  const cmd = 'pnpm -s dc ps';
  step(1, 'Both pieces run in containers', 'docker compose lists the db (postgres) and api containers and their health', cmd);
  const r = sh(cmd);
  show(r.out);
  const healthy = (svc) => r.out.split('\n').some((l) => new RegExp(`-${svc}-1\\s`).test(l) && /\(healthy\)/.test(l));
  const ok = r.ok && healthy('db') && healthy('api');
  verdict(1, ok, ok ? 'db and api containers are up and healthy' : 'db or api is not up and healthy', 'pnpm stack:up');
}

// --- Step 2: the service queries the database -------------------------------------------------
{
  const cmd = win ? curlCmd('/health/db') : curlCmd('/health/db').replace('curl.exe', 'curl');
  step(2, 'The service talks to the database', 'the api runs a real query in Postgres; serverTime and serverVersion come from the database, not the service', cmd);
  const r = curl('/health/db');
  show(r.out);
  const body = json(r.body);
  const ok = r.code === 200 && body?.status === 'ok';
  verdict(2, ok,
    ok ? `HTTP 200 · Postgres ${body.serverVersion} · db clock ${body.serverTime} · query ${body.latencyMs} ms · ${body.migrations.executed} migrations, ${body.migrations.pending.length} pending`
      : `HTTP ${r.code || 'no response'}`,
    'pnpm stack:up; if it persists, pnpm logs');
}

// --- Step 3: the same fact seen from the database side ---------------------------------------
{
  const cmd = 'pnpm -s db:psql -c "select name, timestamp from kysely_migration order by name;"';
  step(3, 'Seen from the database side', 'psql inside the db container shows the migrations the service applied when it started, so the service has written to this database', cmd);
  const r = sh(cmd);
  show(r.out);
  const m = r.out.match(/\((\d+) rows?\)/);
  const ok = r.ok && m && Number(m[1]) > 0;
  verdict(3, ok, ok ? `${m[1]} migration rows written by the service` : 'no migration rows found', 'pnpm stack:up (the api applies migrations on start)');
}

// --- Step 4: database outage fails clearly and recovers ---------------------------------------
if (withOutage) {
  const stop = 'pnpm -s dc stop db';
  const start = 'pnpm -s dc up -d --wait db';
  const probe = win ? curlCmd('/health/db') : curlCmd('/health/db').replace('curl.exe', 'curl');
  step(4, 'A database outage fails clearly, then recovers', 'with db stopped the api answers 503 with code, detail and fix (no hang, no stack trace); after db starts it reconnects without restarting the api', `${stop}  ->  ${probe}  ->  ${start}  ->  ${probe}`);
  let down = null;
  let up = null;
  let restarted = false;
  const restart = () => {
    if (restarted) return;
    restarted = true;
    console.log(`  ${C.d}> ${start}${C.n}`);
    show(sh(start, { timeout: 180_000 }).out || '(db healthy)');
  };
  process.once('SIGINT', () => { restart(); process.exit(130); });
  try {
    console.log(`  ${C.d}> ${stop}${C.n}`);
    show(sh(stop).out || '(db stopped)');
    console.log(`  ${C.d}> ${probe}   (db down)${C.n}`);
    down = curl('/health/db');
    show(down.out);
  } finally {
    restart();
  }
  console.log(`  ${C.d}> ${probe}   (db back; retrying up to 30 s)${C.n}`);
  const deadline = Date.now() + 30_000;
  do {
    up = curl('/health/db');
    if (up.code === 200) break;
    spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},1000)']);
  } while (Date.now() < deadline);
  show(up.out);
  const err = json(down?.body ?? '');
  const failsClearly = down?.code === 503 && err?.code && err?.fix;
  const recovers = up?.code === 200;
  verdict(4, failsClearly && recovers,
    `db down -> HTTP ${down?.code} ${err?.code ?? ''}${err?.fix ? ' (with fix)' : ''}; db back -> HTTP ${up?.code}${recovers ? ', reconnected without an api restart' : ''}`,
    failsClearly ? 'the api did not reconnect within 30 s: pnpm logs' : 'the api did not answer a clear 503 while the db was down: pnpm logs');
}

// --- Step 5: end-to-end smoke test ------------------------------------------------------------
if (withSmoke) {
  const cmd = !dockerOnPath && win ? 'wsl -e sh scripts/smoke.sh --no-build' : 'sh scripts/smoke.sh --no-build';
  step(5, 'End-to-end smoke test', 'the full checklist against the running stack: docker, containers healthy, /health, /health/db, error shape, test-session creation', cmd);
  const r = sh(cmd, { timeout: 300_000 });
  show(r.out);
  const summary = r.out.split('\n').find((l) => / passed, \d+ failed/.test(l))?.trim() ?? '';
  verdict(5, r.ok, summary || `exit ${r.status}`, `run ${cmd} and follow its per-check diagnosis`);
}

// --- Summary -----------------------------------------------------------------------------------
const failed = results.filter((r) => !r.ok);
console.log(`\n${C.b}Summary${C.n}`);
for (const r of results) console.log(`  ${r.ok ? `${C.g}PASS${C.n}` : `${C.r}FAIL${C.n}`}  step ${r.n}: ${r.result}`);
console.log(failed.length ? `\n${C.r}${failed.length} step(s) failed.${C.n}` : `\n${C.g}The service and the database are connected and containerized.${C.n}`);
process.exitCode = failed.length ? 1 : 0;
