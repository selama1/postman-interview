import type { FastifyInstance } from 'fastify';
import { healthRoutes } from './health.js';

/**
 * Route registry: one plugin per resource, registered here with its prefix.
 *   await app.register(shipmentRoutes, { prefix: '/shipments' });
 * Reference implementation of a full resource (zod schemas, keyset pagination, filters,
 * problem errors, Kysely repo): packages/service/test/fixtures/widgets.ts.
 */
export async function registerRoutes(app: FastifyInstance): Promise<void> {
  await app.register(healthRoutes);
}
