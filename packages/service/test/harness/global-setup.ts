import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { TestProject } from 'vitest/node';
import { migrateToLatest, migrationsFingerprint } from '../../src/db/migrate.js';
import { testEnv, withDatabase } from './env.js';

/**
 * Integration global setup — runs once per `vitest` invocation.
 *
 * 1. Fail loudly (reason + fix) if the test Postgres is unreachable. Never skip: a skipped live
 *    suite looks green and proves nothing.
 * 2. Ensure the sealed template `app_template` = empty DB with all migrations applied. Rebuilt only
 *    when the migrations' content fingerprint changes (stored as the DB comment).
 * 3. Sweep databases leaked by crashed runs (t_<epoch36>_... older than 1h).
 * 4. Provide a runId; per-test DBs are named t_<runId>_<n>; teardown drops this run's DBs.
 *
 * An advisory lock serializes template rebuilds across concurrent test runs (two sessions /
 * terminals running tests at once).
 */

declare module 'vitest' {
  export interface ProvidedContext {
    runId: string;
    templateDb: string;
    adminUrl: string;
  }
}

const LOCK_KEY = 74_210_001;

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
  const fp = await migrationsFingerprint();
  const runId = `${Math.floor(Date.now() / 1000).toString(36)}${Math.random().toString(36).slice(2, 5)}`;

  try {
    await admin.query('select pg_advisory_lock($1)', [LOCK_KEY]);

    // -- sweep leaked per-test databases (older than 1h)
    const cutoff = Math.floor(Date.now() / 1000) - 3600;
    const { rows: leaked } = await admin.query<{ datname: string }>(`select datname from pg_database where datname like 't\\_%'`);
    for (const { datname } of leaked) {
      const epoch = Number.parseInt(datname.split('_')[1]?.slice(0, 6) ?? '', 36);
      if (Number.isFinite(epoch) && epoch < cutoff) await admin.query(`drop database if exists "${datname}" with (force)`);
    }

    // -- template up to date?
    const { rows } = await admin.query<{ comment: string | null }>(
      `select shobj_description(oid, 'pg_database') as comment from pg_database where datname = $1`,
      [testEnv.templateDb],
    );
    const current = rows[0]?.comment ?? null;
    if (current !== `fp:${fp}`) {
      const build = `${testEnv.templateDb}_build`;
      await admin.query(`drop database if exists "${build}" with (force)`);
      await admin.query(`create database "${build}"`);
      const db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: withDatabase(testEnv.adminUrl, build), max: 1 }) }) });
      try {
        await migrateToLatest(db);
      } finally {
        await db.destroy();
      }
      if (rows.length) {
        await admin.query(`alter database "${testEnv.templateDb}" with is_template false`);
        await admin.query(`drop database "${testEnv.templateDb}" with (force)`);
      }
      await admin.query(`alter database "${build}" rename to "${testEnv.templateDb}"`);
      // ALLOW_CONNECTIONS false: nobody can connect to the template, so CREATE DATABASE ... TEMPLATE
      // never fails with "source database is being accessed by other users".
      await admin.query(`alter database "${testEnv.templateDb}" with is_template true allow_connections false`);
      await admin.query(`comment on database "${testEnv.templateDb}" is 'fp:${fp}'`);
      console.log(`[test-harness] rebuilt template ${testEnv.templateDb} (migrations fingerprint ${fp})`);
    }
  } finally {
    await admin.query('select pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    await admin.end();
  }

  project.provide('runId', runId);
  project.provide('templateDb', testEnv.templateDb);
  project.provide('adminUrl', testEnv.adminUrl);

  return async () => {
    const c = await connectAdmin();
    try {
      const { rows: mine } = await c.query<{ datname: string }>(`select datname from pg_database where datname like $1`, [`t\\_${runId}\\_%`]);
      for (const { datname } of mine) await c.query(`drop database if exists "${datname}" with (force)`);
    } finally {
      await c.end();
    }
  };
}
