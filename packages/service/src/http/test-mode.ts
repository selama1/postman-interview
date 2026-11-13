import type { FastifyInstance } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Db } from '../db/kysely.js';
import { TestSessionError, type TestSessionManager } from '../testing/sessions.js';
import { AppError } from './errors.js';

/**
 * Request-scoped database + API test mode.
 *
 * EVERY handler reads the database through `req.db` — never `app.db`. Normally `req.db === app.db`.
 * With `x-test-session: <id>` (and TEST_SESSIONS_ENABLED=true) it is that session's isolated
 * database, so every endpoint supports test mode by construction. A static test
 * (src/http/routes/req-db.static.test.ts) fails the build if a route uses `app.db`.
 *
 *   POST   /_test/sessions        -> 201 { id, createdAt, expiresAt }   fresh, migrated, empty DB
 *   GET    /_test/sessions        -> { items: [...] }
 *   DELETE /_test/sessions/:id    -> 204
 *   any request + `x-test-session: <id>` -> runs against that session's DB (header echoed back)
 *
 * Safety: if test mode is disabled, a request carrying the header is REJECTED (400), never served
 * from the real database.
 */
export const TEST_SESSION_HEADER = 'x-test-session';

declare module 'fastify' {
  interface FastifyRequest {
    /** The database for this request (test-session DB when x-test-session is set). */
    db: Db;
    testSession: string | undefined;
  }
}

export function registerRequestDb(app: FastifyInstance, sessions: TestSessionManager | undefined) {
  app.decorateRequest('db', null as unknown as Db);
  app.decorateRequest('testSession', undefined);

  app.addHook('onRequest', async (req, reply) => {
    const raw = req.headers[TEST_SESSION_HEADER];
    const id = Array.isArray(raw) ? raw[0] : raw;
    if (!id) {
      req.db = app.db;
      return;
    }
    if (!sessions) {
      throw new AppError(400, 'TEST_MODE_DISABLED', `${TEST_SESSION_HEADER} was sent but test mode is disabled on this server`,
        'Remove the header, or enable test mode (TEST_SESSIONS_ENABLED=true) on a non-production deployment.');
    }
    try {
      req.db = await sessions.resolve(id);
    } catch (err) {
      if (err instanceof TestSessionError) {
        throw new AppError(404, 'TEST_SESSION_NOT_FOUND', err.message, 'Create a session with POST /_test/sessions and send its id.');
      }
      throw err;
    }
    req.testSession = id;
    req.log = req.log.child({ testSession: id });
    reply.header(TEST_SESSION_HEADER, id);
  });
}

const Session = z.object({ id: z.string(), fixture: z.string().optional(), createdAt: z.string(), expiresAt: z.string() });
const CreateSession = z.object({ fixture: z.string().optional() }).nullish(); // bare POST (no body) arrives as null

export const testSessionRoutes =
  (sessions: TestSessionManager): FastifyPluginAsyncZod =>
  async (app) => {
    app.post(
      '/sessions',
      {
        schema: {
          tags: ['test-mode'],
          summary: 'Create an isolated test database (optionally from a named fixture)',
          body: CreateSession,
          response: { 201: Session },
        },
      },
      async (req, reply) => {
        try {
          return reply.code(201).send(await sessions.create({ fixture: req.body?.fixture }));
        } catch (err) {
          if (err instanceof TestSessionError && err.kind === 'unknown_fixture') {
            throw new AppError(400, 'UNKNOWN_FIXTURE', err.message, 'List fixtures with GET /_test/fixtures; define new ones in src/testing/fixtures.ts.');
          }
          if (err instanceof TestSessionError && err.kind === 'limit') {
            throw new AppError(429, 'TEST_SESSION_LIMIT', err.message, 'Delete finished sessions (DELETE /_test/sessions/:id) or wait for expiry.');
          }
          throw err;
        }
      },
    );

    app.get(
      '/fixtures',
      {
        schema: {
          tags: ['test-mode'],
          summary: 'List named fixtures',
          response: { 200: z.object({ items: z.array(z.object({ name: z.string(), description: z.string() })) }) },
        },
      },
      async () => ({ items: Object.entries(sessions.fixtures).map(([name, f]) => ({ name, description: f.description })) }),
    );

    app.get('/sessions', { schema: { tags: ['test-mode'], summary: 'List test sessions', response: { 200: z.object({ items: z.array(Session) }) } } }, async () => ({
      items: await sessions.list(),
    }));

    app.delete('/sessions/:id', { schema: { tags: ['test-mode'], summary: 'Delete a test session', params: z.object({ id: z.string() }) } }, async (req, reply) => {
      if (!(await sessions.drop(req.params.id))) {
        throw new AppError(404, 'TEST_SESSION_NOT_FOUND', `test session ${req.params.id} does not exist`, 'List sessions with GET /_test/sessions.');
      }
      return reply.code(204).send();
    });
  };
