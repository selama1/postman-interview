import { sql } from 'kysely';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { migrationStatus } from '../../db/migrate.js';
import { VERSION } from '../../lib/version.js';

const startedAt = Date.now();

/**
 * GET /health      liveness: the process is up (no DB call — safe for frequent probes)
 * GET /health/db   readiness + proof of the DB connection: runs a real query, reports the server
 *                  version, current database, migration state and pool stats. 503 + reason/fix
 *                  when the DB is unreachable.
 */
export const healthRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/health',
    {
      schema: {
        tags: ['health'],
        summary: 'Liveness',
        response: { 200: z.object({ status: z.literal('ok'), version: z.string(), uptimeS: z.number() }) },
      },
    },
    async () => ({ status: 'ok' as const, version: VERSION, uptimeS: Math.round((Date.now() - startedAt) / 1000) }),
  );

  app.get(
    '/health/db',
    {
      schema: {
        tags: ['health'],
        summary: 'Database connectivity (runs a real query)',
        response: {
          200: z.object({
            status: z.literal('ok'),
            latencyMs: z.number(),
            database: z.string(),
            serverVersion: z.string(),
            serverTime: z.string(),
            migrations: z.object({ executed: z.number(), pending: z.array(z.string()), latest: z.string().nullable() }),
            pool: z.object({ total: z.number(), idle: z.number(), waiting: z.number() }).optional(),
          }),
          503: z.object({ status: z.literal('error'), code: z.string(), detail: z.string(), fix: z.string(), requestId: z.string() }),
        },
      },
    },
    async (req, reply) => {
      const t0 = performance.now();
      try {
        const { rows } = await sql<{ database: string; server_version: string; now: Date }>`
          select current_database() as database, current_setting('server_version') as server_version, now() as now
        `.execute(app.db);
        const row = rows[0]!;
        const migrations = await migrationStatus(app.db);
        const pool = app.pool ? { total: app.pool.totalCount, idle: app.pool.idleCount, waiting: app.pool.waitingCount } : undefined;
        return {
          status: 'ok' as const,
          latencyMs: Math.round((performance.now() - t0) * 10) / 10,
          database: row.database,
          serverVersion: row.server_version,
          serverTime: new Date(row.now).toISOString(),
          migrations,
          ...(pool ? { pool } : {}),
        };
      } catch (err) {
        req.log.error({ err }, 'health/db failed');
        return reply.code(503).send({
          status: 'error' as const,
          code: 'DB_UNAVAILABLE',
          detail: `database check failed: ${(err as Error).message}`,
          fix: 'Check DATABASE_URL and that the db container is healthy: `docker compose ps db` / `docker compose logs db`.',
          requestId: String(req.id),
        });
      }
    },
  );
};
