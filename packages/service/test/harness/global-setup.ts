import pg from 'pg';
import type { TestProject } from 'vitest/node';
import { dropDatabase, ensureTemplate, TEMPLATE_DB } from '../../src/db/template.js';
import { testEnv } from './env.js';

/**
 * Integration global setup — runs once per `vitest` invocation.
 *
 * 1. Fail loudly (reason + fix) if the test Postgres is unreachable. Never skip: a skipped live
 *    suite looks green and proves nothing.
 * 2. Ensure the sealed template (src/db/template.ts — shared with API test mode) is current.
 * 3. Sweep databases leaked by crashed runs (t_<epoch36>..., ts_<epoch36>... older than 1h).
 * 4. Provide a runId; per-test DBs are named t_<runId>_<pid>_<n>; teardown drops this run's DBs.
 */

declare module 'vitest' {
  export interface ProvidedContext {
    runId: string;
    templateDb: string;
    adminUrl: string;
  }
}

async function connectAdmin(): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: testEnv.adminUrl, connectionTimeoutMillis: 4000 });
  try {
    await client.connect();
  } catch (err) {
    const e = err as Error & { code?: string };
    throw new Error(
      `Integration tests need the live test database, but it is unreachable at ${redact(testEnv.adminUrl)} (${e.code ?? e.message}).\n` +
        'Fix: pnpm db:test:up    (= docker compose --profile test up -d --wait db-test)\n' +
        '     On Windows+WSL: if Docker was idle, WSL may have stopped — rerun the command above.',
      { cause: err },
    );
  }
  return client;
}

const redact = (url: string) => url.replace(/\/\/([^:@]+):[^@]*@/, '//$1:***@');

export default async function setup(project: TestProject) {
  const admin = await connectAdmin();
  const runId = `${Math.floor(Date.now() / 1000).toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  try {
    const cutoff = Math.floor(Date.now() / 1000) - 3600;
    const { rows: leaked } = await admin.query<{ datname: string }>(`select datname from pg_database where datname ~ '^ts?_'`);
    for (const { datname } of leaked) {
      const epoch = Number.parseInt(datname.split('_')[1]?.slice(0, 6) ?? '', 36);
      if (Number.isFinite(epoch) && epoch < cutoff) await dropDatabase(admin, datname);
    }
    const t = await ensureTemplate(admin, testEnv.adminUrl, { log: (m) => console.log(`[test-harness] ${m}`) });
    project.provide('templateDb', t.name);
  } finally {
    await admin.end();
  }
  project.provide('runId', runId);
  project.provide('adminUrl', testEnv.adminUrl);

  return async () => {
    const c = await connectAdmin();
    try {
      const { rows: mine } = await c.query<{ datname: string }>(`select datname from pg_database where datname like $1`, [`t\\_${runId}\\_%`]);
      for (const { datname } of mine) await dropDatabase(c, datname);
    } finally {
      await c.end();
    }
  };
}

export { TEMPLATE_DB };
