import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { migrateToLatest, migrationsFingerprint } from './migrate.js';

/**
 * Sealed template database = empty DB with all migrations applied. Cloning it
 * (`CREATE DATABASE x TEMPLATE app_template`) gives a fresh, fully-migrated, isolated database in
 * ~50–150 ms. Used by:
 *   - the integration test harness (one DB per test), and
 *   - API test mode (one DB per `x-test-session`, src/testing/sessions.ts).
 *
 * The template is rebuilt only when the migrations' content fingerprint changes (stored as the
 * DB comment). An advisory lock serializes rebuilds across processes (test runs, service replicas).
 */
export const TEMPLATE_DB = 'app_template';
const LOCK_KEY = 74_210_001;

/** Replace the database name in a postgres URL. */
export function withDatabase(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

/** Identifiers we generate ourselves; validated before interpolation into DDL. */
export const SAFE_DB_NAME = /^[a-z][a-z0-9_]{0,62}$/;
export const quoteDb = (name: string) => {
  if (!SAFE_DB_NAME.test(name)) throw new Error(`refusing unsafe database name "${name}"`);
  return `"${name}"`;
};

export async function ensureTemplate(
  admin: pg.Pool | pg.Client,
  adminUrl: string,
  opts: { name?: string; log?: (msg: string) => void } = {},
): Promise<{ name: string; rebuilt: boolean; fingerprint: string }> {
  const name = opts.name ?? TEMPLATE_DB;
  const fp = await migrationsFingerprint();
  // A pooled client so the advisory lock and its unlock run on the same session.
  const conn = admin instanceof pg.Pool ? await admin.connect() : admin;
  try {
    await conn.query('select pg_advisory_lock($1)', [LOCK_KEY]);
    const { rows } = await conn.query<{ comment: string | null }>(
      `select shobj_description(oid, 'pg_database') as comment from pg_database where datname = $1`,
      [name],
    );
    if (rows[0]?.comment === `fp:${fp}`) return { name, rebuilt: false, fingerprint: fp };

    const build = `${name}_build`;
    await conn.query(`drop database if exists ${quoteDb(build)} with (force)`);
    await conn.query(`create database ${quoteDb(build)}`);
    const db = new Kysely<unknown>({
      dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: withDatabase(adminUrl, build), max: 1 }) }),
    });
    try {
      await migrateToLatest(db);
    } finally {
      await db.destroy();
    }
    if (rows.length) {
      await conn.query(`alter database ${quoteDb(name)} with is_template false`);
      await conn.query(`drop database ${quoteDb(name)} with (force)`);
    }
    await conn.query(`alter database ${quoteDb(build)} rename to ${quoteDb(name)}`);
    // ALLOW_CONNECTIONS false: nobody can connect to the template, so cloning never fails with
    // "source database is being accessed by other users".
    await conn.query(`alter database ${quoteDb(name)} with is_template true allow_connections false`);
    await conn.query(`comment on database ${quoteDb(name)} is 'fp:${fp}'`);
    opts.log?.(`rebuilt template ${name} (migrations fingerprint ${fp})`);
    return { name, rebuilt: true, fingerprint: fp };
  } finally {
    await conn.query('select pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    if (admin instanceof pg.Pool) (conn as pg.PoolClient).release();
  }
}

export async function cloneTemplate(admin: pg.Pool | pg.Client, name: string, template = TEMPLATE_DB): Promise<void> {
  await admin.query(`create database ${quoteDb(name)} template ${quoteDb(template)}`);
}

export async function dropDatabase(admin: pg.Pool | pg.Client, name: string): Promise<void> {
  await admin.query(`drop database if exists ${quoteDb(name)} with (force)`);
}
