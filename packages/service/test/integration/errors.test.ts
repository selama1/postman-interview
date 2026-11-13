import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { sql } from 'kysely';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { useTarget } from '../harness/server.js';

/** Central error mapping: Postgres SQLSTATEs and thrown errors become correct problem+json. */
const boom: FastifyPluginAsyncZod = async (app) => {
  app.get('/:kind', { schema: { params: z.object({ kind: z.string() }) } }, async (req) => {
    switch (req.params.kind) {
      case 'bad-cast':
        return sql`select 'abc'::int`.execute(req.db);
      case 'timeout':
        return sql`select pg_sleep(2)`.execute(req.db);
      case 'div-zero':
        return sql`select 1/0`.execute(req.db);
      case 'throw':
        throw new Error('kaboom');
      default:
        return { ok: true };
    }
  });
};

describe('error mapping', () => {
  const t = useTarget({
    fresh: 'file',
    plugins: [{ plugin: boom as never, prefix: '/boom' }],
    env: { DB_STATEMENT_TIMEOUT_MS: '200' },
  });

  it('unknown route -> 404 ROUTE_NOT_FOUND problem', async () => {
    expect(await t.client.get('/nope')).toBeProblem(404, 'ROUTE_NOT_FOUND');
  });
  it('invalid text representation (22P02) -> 400 INVALID_INPUT', async () => {
    expect(await t.client.get('/boom/bad-cast')).toBeProblem(400, 'INVALID_INPUT');
  });
  it('statement timeout (57014) -> 503 QUERY_TIMEOUT', async () => {
    expect(await t.client.get('/boom/timeout')).toBeProblem(503, 'QUERY_TIMEOUT');
  });
  it('unmapped DB error -> 500 INTERNAL with requestId, not a crash', async () => {
    expect(await t.client.get('/boom/div-zero')).toBeProblem(500, 'INTERNAL');
  });
  it('thrown Error -> 500 INTERNAL', async () => {
    expect(await t.client.get('/boom/throw')).toBeProblem(500, 'INTERNAL');
  });
});
