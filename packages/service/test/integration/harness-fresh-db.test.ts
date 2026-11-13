import { describe, expect, it } from 'vitest';
import { useTarget } from '../harness/server.js';

/**
 * Harness invariant: every integration test starts on its OWN empty, fully-migrated database.
 * If this file fails, no other integration result can be trusted.
 */
describe('fresh database per test', () => {
  const t = useTarget();
  const seen: string[] = [];

  it('is migrated (baseline objects exist) and every table is empty', async () => {
    const db = t.db!;
    seen.push(db.name);
    const [fn] = await db.query(`select count(*)::int as n from pg_proc where proname = 'set_updated_at'`);
    expect(fn!.n).toBe(1);
    const [schema] = await db.query(`select count(*)::int as n from pg_namespace where nspname = 'staging'`);
    expect(schema!.n).toBe(1);
    // Resource tables (migrations, e.g. from `pnpm gen:resource`) exist, but a fresh DB holds no rows in any of them.
    const user = await db.query<{ table_name: string }>(
      `select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' and table_name not like 'kysely_%'`,
    );
    for (const { table_name } of user) {
      const [c] = await db.query(`select count(*)::int as n from "${table_name}"`);
      expect(c!.n, `table ${table_name} should be empty in a fresh database`).toBe(0);
    }
  });

  it('writes in one test are invisible to the next', async () => {
    const db = t.db!;
    seen.push(db.name);
    await db.query('create table leak_probe (x int)');
    await db.query('insert into leak_probe values (1)');
    expect(await db.query('select * from leak_probe')).toHaveLength(1);
  });

  it('...proven here: a different database without the previous table', async () => {
    const db = t.db!;
    seen.push(db.name);
    const rows = await db.query(`select to_regclass('public.leak_probe') as t`);
    expect(rows[0]!.t).toBeNull();
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('the app under test is connected to that same database', async () => {
    const res = await t.client.get('/health/db');
    expect(res).toHaveStatus(200);
    expect(res.body.database).toBe(t.db!.name);
    expect(res.body.migrations.pending).toEqual([]);
  });
});
