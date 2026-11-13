import { createHash } from 'node:crypto';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { migrateToLatest, migrationsFingerprint } from './migrate.js';

/**
 * Sealed template databases. Cloning one (`CREATE DATABASE x TEMPLATE t`) gives a fresh,
 * isolated database in ~50–150 ms — and the cost does not depend on how much seed data the
 * template holds (Postgres copies files), so "every test starts from a realistic fixture" is as
 * cheap as "every test starts empty".
 *
 *   app_template     empty DB + all migrations                     (ensureTemplate)
 *   fx_<fixture>     app_template + a fixture's seed function       (ensureFixtureTemplate)
 *
 * Each template stores its fingerprint as the DB comment and is rebuilt only when it changes
 * (migrations content; for fixtures also the seed code/version). An advisory lock serializes
 * rebuilds across processes. Used by the integration test harness (one DB per test) and by API
 * test mode (one DB per x-test-session, src/testing/sessions.ts).
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

type Admin = pg.Pool | pg.Client;

/**
 * Build `name` as a sealed template if its fingerprint differs: `populate(buildDb)` fills a
 * scratch database, which is then renamed into place and sealed.
 */
async function ensureSealed(
  admin: Admin,
  name: string,
  fingerprint: string,
  populate: (buildDb: string) => Promise<void>,
  log?: (msg: string) => void,
): Promise<boolean> {
  const conn = admin instanceof pg.Pool ? await admin.connect() : admin;
  try {
    await conn.query('select pg_advisory_lock($1)', [LOCK_KEY]);
    const { rows } = await conn.query<{ comment: string | null }>(
      `select shobj_description(oid, 'pg_database') as comment from pg_database where datname = $1`,
      [name],
    );
    if (rows[0]?.comment === `fp:${fingerprint}`) return false;
    const build = `${name}_build`.slice(0, 63);
    await conn.query(`drop database if exists ${quoteDb(build)} with (force)`);
    await populate(build);
    if (rows.length) {
      await conn.query(`alter database ${quoteDb(name)} with is_template false`);
      await conn.query(`drop database ${quoteDb(name)} with (force)`);
    }
    await conn.query(`alter database ${quoteDb(build)} rename to ${quoteDb(name)}`);
    // ALLOW_CONNECTIONS false: nobody can connect to a template, so cloning never fails with
    // "source database is being accessed by other users".
    await conn.query(`alter database ${quoteDb(name)} with is_template true allow_connections false`);
    await conn.query(`comment on database ${quoteDb(name)} is 'fp:${fingerprint}'`);
    log?.(`built template ${name} (fingerprint ${fingerprint})`);
    return true;
  } finally {
    await conn.query('select pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    if (admin instanceof pg.Pool) (conn as pg.PoolClient).release();
  }
}

async function withDb<T>(adminUrl: string, db: string, fn: (k: Kysely<any>) => Promise<T>): Promise<T> {
  const k = new Kysely<any>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: withDatabase(adminUrl, db), max: 2 }) }),
  });
  try {
    return await fn(k);
  } finally {
    await k.destroy();
  }
}

export async function ensureTemplate(
  admin: Admin,
  adminUrl: string,
  opts: { log?: (msg: string) => void } = {},
): Promise<{ name: string; rebuilt: boolean; fingerprint: string }> {
  const fingerprint = await migrationsFingerprint();
  const rebuilt = await ensureSealed(
    admin,
    TEMPLATE_DB,
    fingerprint,
    async (build) => {
      await admin.query(`create database ${quoteDb(build)}`);
      await withDb(adminUrl, build, (db) => migrateToLatest(db));
    },
    opts.log,
  );
  return { name: TEMPLATE_DB, rebuilt, fingerprint };
}

// --- fixtures -------------------------------------------------------------------------------------

/**
 * A named initial state. `seed` runs ONCE per fingerprint against a clone of the migrated
 * template; every session/test using the fixture then clones the result (no per-test seeding).
 * Bump `version` when the seed depends on something its source text doesn't show (e.g. a data file).
 */
export interface Fixture {
  description: string;
  version?: string;
  seed: (db: Kysely<any>) => Promise<void>;
}
export type FixtureRegistry = Record<string, Fixture>;

export const FIXTURE_NAME = /^[a-z][a-z0-9_]{0,39}$/;
export const fixtureTemplateName = (fixture: string) => `fx_${fixture}`;

export async function ensureFixtureTemplate(
  admin: Admin,
  adminUrl: string,
  name: string,
  fixture: Fixture,
  opts: { log?: (msg: string) => void } = {},
): Promise<string> {
  if (!FIXTURE_NAME.test(name)) throw new Error(`invalid fixture name "${name}" (use ${FIXTURE_NAME})`);
  const base = await ensureTemplate(admin, adminUrl, opts);
  const fingerprint = createHash('sha256')
    .update(base.fingerprint)
    .update('\0')
    .update(fixture.version ?? '')
    .update('\0')
    .update(fixture.seed.toString())
    .digest('hex')
    .slice(0, 16);
  const tpl = fixtureTemplateName(name);
  await ensureSealed(
    admin,
    tpl,
    fingerprint,
    async (build) => {
      await cloneTemplate(admin, build, TEMPLATE_DB);
      await withDb(adminUrl, build, (db) => fixture.seed(db));
    },
    opts.log,
  );
  return tpl;
}

export async function cloneTemplate(admin: Admin, name: string, template = TEMPLATE_DB): Promise<void> {
  await admin.query(`create database ${quoteDb(name)} template ${quoteDb(template)}`);
}

export async function dropDatabase(admin: Admin, name: string): Promise<void> {
  await admin.query(`drop database if exists ${quoteDb(name)} with (force)`);
}

/**
 * Instant "delete": kick connections and rename out of the live namespace (catalog-only, fast).
 * The caller drops `trash` later — DROP DATABASE forces a checkpoint and concurrent drops
 * serialize (measured: 40 parallel drops ≈ 22 s on a durable volume), so it must not sit on the
 * request path of a 300-test suite.
 */
export async function retireDatabase(admin: Admin, name: string, trash: string): Promise<void> {
  await admin.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()`, [name]);
  await admin.query(`alter database ${quoteDb(name)} rename to ${quoteDb(trash)}`);
}
