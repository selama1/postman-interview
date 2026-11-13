import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { inject } from 'vitest';
import type { Database } from '../../src/db/schema.js';
import { cloneTemplate, dropDatabase, ensureFixtureTemplate, type FixtureRegistry } from '../../src/db/template.js';
import { fixtures as defaultFixtures } from '../../src/testing/fixtures.js';
import { testEnv, withDatabase } from './env.js';

/**
 * A brand-new database cloned from the sealed, migrated template: empty tables, real commits,
 * real constraints. Isolated from every other test (parallel files are safe).
 * Cost: one CREATE DATABASE ... TEMPLATE (~30–150 ms on the tmpfs test server).
 */
export interface FreshDb {
  name: string;
  url: string;
  db: Kysely<Database>;
  pool: pg.Pool;
  /** Raw SQL against this DB (seeding, assertions on persisted state). */
  query: <R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params?: unknown[]) => Promise<R[]>;
  drop: () => Promise<void>;
}

let adminPool: pg.Pool | undefined;
let counter = 0;

function admin(): pg.Pool {
  adminPool ??= new pg.Pool({ connectionString: inject('adminUrl'), max: 2 });
  return adminPool;
}

const fixtureTemplates = new Map<string, Promise<string>>();

/** Sealed template for a named fixture: seeded once per fingerprint, cloned per test. */
function fixtureTemplate(name: string, registry: FixtureRegistry): Promise<string> {
  const fx = registry[name];
  if (!fx) throw new Error(`unknown fixture "${name}"; known: ${Object.keys(registry).join(', ') || '(none)'}. Define it in src/testing/fixtures.ts.`);
  let p = fixtureTemplates.get(name);
  if (!p) {
    p = ensureFixtureTemplate(admin(), inject('adminUrl'), name, fx);
    fixtureTemplates.set(name, p);
  }
  return p;
}

export interface FreshDbOptions {
  /** Start from a named fixture instead of an empty DB (same per-test cost). */
  fixture?: string | undefined;
  /** Fixture registry override (default src/testing/fixtures.ts). */
  fixtures?: FixtureRegistry | undefined;
}

export async function freshDb(opts: FreshDbOptions = {}): Promise<FreshDb> {
  const name = `t_${inject('runId')}_${process.pid}_${++counter}`;
  const template = opts.fixture ? await fixtureTemplate(opts.fixture, opts.fixtures ?? defaultFixtures) : inject('templateDb');
  await cloneTemplate(admin(), name, template);
  const url = withDatabase(inject('adminUrl'), name);
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  // Idle clients get terminated when the DB is force-dropped; don't let that crash the worker.
  pool.on('error', () => {});
  const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
  let dropped = false;
  return {
    name,
    url,
    db,
    pool,
    query: async (text, params) => (await pool.query(text, params as unknown[])).rows,
    drop: async () => {
      if (dropped) return;
      dropped = true;
      await db.destroy(); // ends the pool only if Kysely ever used it (its driver is lazy)...
      if (!pool.ended) await pool.end(); // ...so end it explicitly for raw db.query() users
      if (process.env.KEEP_TEST_DB === '1') {
        console.log(`[test-harness] KEEP_TEST_DB=1: kept ${name} -> psql "${url}"`);
        return;
      }
      await dropDatabase(admin(), name);
    },
  };
}

export { testEnv };
