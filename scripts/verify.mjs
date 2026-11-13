#!/usr/bin/env node
// Proves the service <-> database connection. Exit 0 = connected.
//   pnpm verify                         (default http://localhost:3480)
//   node scripts/verify.mjs http://host:port
// Note: sets process.exitCode instead of calling process.exit() — on Windows, exiting while
// fetch sockets are open trips a libuv assertion (exit 127).
// Honour repo-root .env (ports / E2E_BASE_URL / COMPOSE_PROJECT_NAME overrides, e.g. in a practice worktree).
try {
  process.loadEnvFile('.env');
} catch {
  /* no .env: defaults */
}

const base = (process.argv[2] ?? process.env.E2E_BASE_URL ?? 'http://localhost:3480').replace(/\/$/, '');

async function get(path) {
  const res = await fetch(base + path, { signal: AbortSignal.timeout(5000) });
  return { status: res.status, body: await res.json().catch(() => null) };
}

try {
  const live = await get('/health');
  const db = await get('/health/db');
  console.log(`GET ${base}/health     -> ${live.status} ${JSON.stringify(live.body)}`);
  console.log(`GET ${base}/health/db  -> ${db.status}`);
  console.log(JSON.stringify(db.body, null, 2));
  if (db.status === 200 && db.body?.status === 'ok') {
    console.log(
      `\nOK: service is connected to Postgres ${db.body.serverVersion} (database "${db.body.database}", ` +
        `${db.body.latencyMs} ms, ${db.body.migrations.executed} migration(s) applied).`,
    );
  } else {
    console.error(`\nFAIL: /health/db returned ${db.status}. ${db.body?.fix ?? ''}`);
    process.exitCode = 1;
  }
} catch (err) {
  console.error(
    `FAIL: cannot reach ${base} (${err.cause?.code ?? err.message}).\n` +
      'Fix: start the stack with `docker compose up -d --build --wait` and retry.',
  );
  process.exitCode = 1;
}
