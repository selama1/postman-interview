/**
 * API test mode (x-test-session): every session is an isolated, empty, migrated database and ANY
 * route that reads `req.db` honours it. The probe plugin below stands in for a real resource.
 */
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { sql } from 'kysely';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { TestClient } from '../harness/client.js';
import { openTestSession, useTarget } from '../harness/server.js';

// A resource-like route that writes and reads through req.db (the convention every route follows).
const probe: FastifyPluginAsyncZod = async (app) => {
  app.post('/', { schema: { body: z.object({ v: z.string() }) } }, async (req, reply) => {
    await sql`create table if not exists probe (v text)`.execute(req.db);
    await sql`insert into probe values (${req.body.v})`.execute(req.db);
    return reply.code(201).send({ ok: true });
  });
  app.get('/', async (req) => {
    const exists = await sql<{ t: string | null }>`select to_regclass('public.probe')::text as t`.execute(req.db);
    if (!exists.rows[0]?.t) return { values: [] };
    const { rows } = await sql<{ v: string }>`select v from probe order by v`.execute(req.db);
    return { values: rows.map((r) => r.v) };
  });
};
const plugins = [{ plugin: probe as never, prefix: '/probe' }];

describe('test mode enabled', () => {
  const t = useTarget({ plugins, env: { TEST_SESSIONS_ENABLED: 'true' } });

  it('POST /_test/sessions creates a fresh, migrated DB that requests are routed to', async () => {
    const s = await openTestSession(t.baseUrl);
    const res = await s.client.get('/health/db');
    expect(res).toHaveStatus(200);
    expect(res.body.database).toBe(s.testSession);
    expect(res.body.testSession).toBe(s.testSession);
    expect(res.body.migrations.pending).toEqual([]);
    expect(res.headers['x-test-session']).toBe(s.testSession);
  });

  it('sessions are isolated from each other and from the default database', async () => {
    const a = await openTestSession(t.baseUrl);
    const b = await openTestSession(t.baseUrl);
    expect(await a.client.post('/probe', { v: 'only-in-a' })).toHaveStatus(201);
    expect(await t.client.post('/probe', { v: 'only-in-default' })).toHaveStatus(201);
    expect((await a.client.get('/probe')).body.values).toEqual(['only-in-a']);
    expect((await b.client.get('/probe')).body.values).toEqual([]);
    expect((await t.client.get('/probe')).body.values).toEqual(['only-in-default']);
  });

  it('lists and deletes sessions; a deleted session is a 404 problem', async () => {
    const s = await openTestSession(t.baseUrl);
    const list = await t.client.get('/_test/sessions');
    expect(list.body.items.map((x: { id: string }) => x.id)).toContain(s.testSession);
    expect(await t.client.delete(`/_test/sessions/${s.testSession}`)).toHaveStatus(204);
    expect(await s.client.get('/health/db')).toBeProblem(404, 'TEST_SESSION_NOT_FOUND');
    expect(await t.client.delete(`/_test/sessions/${s.testSession}`)).toBeProblem(404, 'TEST_SESSION_NOT_FOUND');
  });

  it('unknown or malformed session ids are 404 problems (never fall through to real data)', async () => {
    const bogus = new TestClient(t.baseUrl, { headers: { 'x-test-session': 'ts_000000_000000000000' } });
    expect(await bogus.get('/probe')).toBeProblem(404, 'TEST_SESSION_NOT_FOUND');
    const evil = new TestClient(t.baseUrl, { headers: { 'x-test-session': 'app"; drop database app; --' } });
    expect(await evil.get('/probe')).toBeProblem(404, 'TEST_SESSION_NOT_FOUND');
  });
});

describe('test mode expiry', () => {
  const t = useTarget({ plugins, env: { TEST_SESSIONS_ENABLED: 'true', TEST_SESSION_TTL_MIN: '0.02' } });

  it('an expired session is refused', async () => {
    const s = await openTestSession(t.baseUrl);
    expect(await s.client.get('/probe')).toHaveStatus(200);
    await new Promise((r) => setTimeout(r, 2500));
    expect(await s.client.get('/probe')).toBeProblem(404, 'TEST_SESSION_NOT_FOUND');
  });
});

describe('test mode disabled (production default)', () => {
  const t = useTarget({ plugins, fresh: 'file' });

  it('a request carrying x-test-session is rejected, not served from the real DB', async () => {
    const c = new TestClient(t.baseUrl, { headers: { 'x-test-session': 'ts_000000_000000000000' } });
    expect(await c.get('/probe')).toBeProblem(400, 'TEST_MODE_DISABLED');
  });

  it('the session endpoints do not exist', async () => {
    expect(await t.client.post('/_test/sessions')).toBeProblem(404, 'ROUTE_NOT_FOUND');
  });
});
