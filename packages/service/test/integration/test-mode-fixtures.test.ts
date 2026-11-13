/**
 * Fixtures: named initial states. Seeded ONCE into a sealed template, then cloned per session /
 * per test — so a regression suite of hundreds of tests can start every test from realistic data
 * at the cost of an empty clone. Also: many concurrent sessions stay isolated and delete fast.
 */
import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import type { FixtureRegistry } from '../../src/db/template.js';
import { openTestSession, useTarget } from '../harness/server.js';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

const fixtures: FixtureRegistry = {
  three_rows: {
    description: 'probe table with rows a, b, c',
    seed: async (db) => {
      await sql`create table probe (v text primary key)`.execute(db);
      await sql`insert into probe values ('a'), ('b'), ('c')`.execute(db);
    },
  },
};

const probe: FastifyPluginAsyncZod = async (app) => {
  app.get('/', async (req) => ({ values: (await sql<{ v: string }>`select v from probe order by v`.execute(req.db)).rows.map((r) => r.v) }));
  app.post('/', { schema: { body: z.object({ v: z.string() }) } }, async (req, reply) => {
    await sql`insert into probe values (${req.body.v})`.execute(req.db);
    return reply.code(201).send({});
  });
};
const plugins = [{ plugin: probe as never, prefix: '/probe' }];

describe('integration harness: useTarget({ fixture })', () => {
  const t = useTarget({ fixture: 'three_rows', fixtures, plugins });

  it('every test starts from the fixture state (1/2)', async () => {
    expect((await t.client.get('/probe')).body.values).toEqual(['a', 'b', 'c']);
    expect(await t.client.post('/probe', { v: 'mutated' })).toHaveStatus(201);
  });

  it('every test starts from the fixture state (2/2): previous mutation is gone', async () => {
    expect((await t.client.get('/probe')).body.values).toEqual(['a', 'b', 'c']);
    const rows = await t.db!.query<{ n: number }>('select count(*)::int as n from probe');
    expect(rows[0]!.n).toBe(3);
  });
});

describe('API test mode: sessions from fixtures', () => {
  const t = useTarget({ plugins, fixtures, env: { TEST_SESSIONS_ENABLED: 'true' }, setup: async (db) => {
    await db.query(`create table probe (v text primary key)`); // the default DB has the table, empty
  } });

  it('GET /_test/fixtures lists fixtures; unknown fixture is a 400 problem', async () => {
    const list = await t.client.get('/_test/fixtures');
    expect(list.body.items).toEqual([{ name: 'three_rows', description: 'probe table with rows a, b, c' }]);
    expect(await t.client.post('/_test/sessions', { fixture: 'nope' })).toBeProblem(400, 'UNKNOWN_FIXTURE');
  });

  it('30 concurrent sessions from one fixture: each starts identical, mutations never cross, deletes are fast', async () => {
    const sessions = await Promise.all(Array.from({ length: 30 }, () => openTestSession(t.baseUrl, 'three_rows')));
    expect(new Set(sessions.map((s) => s.testSession)).size).toBe(30);

    await Promise.all(sessions.map((s, i) => s.client.post('/probe', { v: `only-${i}` })));
    const seen = await Promise.all(sessions.map((s) => s.client.get('/probe')));
    seen.forEach((res, i) => expect(res.body.values).toEqual(['a', 'b', 'c', `only-${i}`]));
    expect((await t.client.get('/probe')).body.values).toEqual([]); // default DB untouched

    const t0 = performance.now();
    const dels = await Promise.all(sessions.map((s) => t.client.delete(`/_test/sessions/${s.testSession}`)));
    const ms = performance.now() - t0;
    dels.forEach((d) => expect(d).toHaveStatus(204));
    expect(ms, `deleting 30 sessions took ${Math.round(ms)} ms`).toBeLessThan(3000);
    expect(await sessions[0]!.client.get('/probe')).toBeProblem(404, 'TEST_SESSION_NOT_FOUND');
  });
});
