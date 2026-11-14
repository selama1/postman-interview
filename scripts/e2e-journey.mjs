#!/usr/bin/env node
/**
 * E2E journey against the running compose stack. Prints one PASS/FAIL/WARN line per check and
 * writes a markdown report to .e2e-reports/. Exit 0 ONLY when every CRITICAL check passes.
 *
 *   node scripts/e2e-journey.mjs [baseUrl]
 *
 * Grow this as features land: each user-visible flow gets a check here that walks it through the
 * deployed container exactly as a client would (the live session's SDK/CLI can be driven from here
 * too). Keep checks independent of pre-existing data: create what you read.
 */
import { mkdirSync, writeFileSync } from 'node:fs';

// Honour repo-root .env (ports / E2E_BASE_URL / COMPOSE_PROJECT_NAME overrides, e.g. in a practice worktree).
try {
  process.loadEnvFile('.env');
} catch {
  /* no .env: defaults */
}

const base = (process.argv[2] ?? process.env.E2E_BASE_URL ?? 'http://localhost:3480').replace(/\/$/, '');
const results = [];

function check(name, ok, detail = '', critical = true) {
  const status = ok ? 'PASS' : critical ? 'FAIL' : 'WARN';
  results.push({ name, status, detail, critical });
  console.log(`${status.padEnd(4)}  ${name}${detail ? `  — ${detail}` : ''}`);
  return ok;
}

async function call(method, path, body, headers = {}) {
  const t0 = performance.now();
  try {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, text, headers: res.headers, ms: Math.round(performance.now() - t0) };
  } catch (err) {
    return { status: 0, json: null, text: String(err.cause?.code ?? err.message), headers: new Headers(), ms: 0 };
  }
}

// ---- platform ------------------------------------------------------------------------------
const live = await call('GET', '/health');
check('service is reachable (GET /health 200)', live.status === 200, `status ${live.status} ${live.status ? '' : live.text}`);

const db = await call('GET', '/health/db');
check('service <-> DB round-trip (GET /health/db 200)', db.status === 200 && db.json?.status === 'ok', `status ${db.status}, ${db.json?.latencyMs ?? '?'} ms`);
check('all migrations applied on startup', Array.isArray(db.json?.migrations?.pending) && db.json.migrations.pending.length === 0, JSON.stringify(db.json?.migrations ?? {}));
check('DB latency under 100 ms', (db.json?.latencyMs ?? 1e9) < 100, `${db.json?.latencyMs} ms`, false);

const rid = `journey-${Date.now()}`;
const echo = await call('GET', '/health', null, { 'x-request-id': rid });
check('x-request-id is honoured and echoed', echo.headers.get('x-request-id') === rid);

const nf = await call('GET', `/no-such-route-${Date.now()}`);
check(
  'unknown route -> problem+json with reason and fix',
  nf.status === 404 && (nf.headers.get('content-type') ?? '').includes('problem+json') && !!nf.json?.detail && !!nf.json?.fix,
  `status ${nf.status} code ${nf.json?.code}`,
);

const oas = await call('GET', '/openapi.json');
check('OpenAPI document served', oas.status === 200 && /^3\./.test(oas.json?.openapi ?? ''), `${Object.keys(oas.json?.paths ?? {}).length} paths`);

// ---- API test mode (x-test-session) -----------------------------------------------------------
const ts = await call('POST', '/_test/sessions');
if (check('test mode: POST /_test/sessions -> 201', ts.status === 201 && !!ts.json?.id, `status ${ts.status}`, false)) {
  const sdb = await call('GET', '/health/db', null, { 'x-test-session': ts.json.id });
  check('test mode: requests with x-test-session run on the session DB', sdb.json?.database === ts.json.id && sdb.json?.migrations?.pending?.length === 0, `database ${sdb.json?.database}`);
  const del = await call('DELETE', `/_test/sessions/${ts.json.id}`);
  check('test mode: DELETE /_test/sessions/:id -> 204', del.status === 204);
  const blank = await call('GET', '/health/db', undefined, { 'x-test-session': '' });
  check('test mode: blank x-test-session -> 400, never the main DB', blank.status === 400 && blank.json?.code === 'TEST_SESSION_INVALID',
    `status ${blank.status} code ${blank.json?.code}`);
}

// ---- feature journeys go here --------------------------------------------------------------
// e.g. create a book -> list it with a filter -> page through -> fetch a report -> 404 path

// ---- report ---------------------------------------------------------------------------------
const failed = results.filter((r) => r.status === 'FAIL');
const warned = results.filter((r) => r.status === 'WARN');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
mkdirSync('.e2e-reports', { recursive: true });
const md = [
  `<!-- journey · ${base} · ${new Date().toISOString()} -->`,
  `# E2E journey — ${failed.length ? 'FAIL' : 'PASS'}`,
  '',
  `${results.length} checks · ${failed.length} failed · ${warned.length} warnings`,
  '',
  '| status | check | detail |',
  '|---|---|---|',
  ...results.map((r) => `| ${r.status} | ${r.name} | ${String(r.detail).replace(/\|/g, '\\|')} |`),
  '',
].join('\n');
writeFileSync(`.e2e-reports/journey-${stamp}.md`, md);
console.log(`\n${failed.length ? 'FAIL' : 'PASS'}: ${results.length - failed.length - warned.length}/${results.length} passed, ${warned.length} warning(s). Report: .e2e-reports/journey-${stamp}.md`);
process.exitCode = failed.length ? 1 : 0;
