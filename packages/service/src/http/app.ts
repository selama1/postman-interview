import { randomUUID } from 'node:crypto';
import Fastify, { LogController, type FastifyInstance, type FastifyPluginAsync, type FastifyServerOptions } from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import type pg from 'pg';
import type { Config } from '../config.js';
import type { Db } from '../db/kysely.js';
import { VERSION } from '../lib/version.js';
import { loggerOptions } from '../logger.js';
import { registerErrorHandling } from './errors.js';
import { registerRoutes } from './routes/index.js';

declare module 'fastify' {
  interface FastifyInstance {
    db: Db;
    pool: pg.Pool | undefined;
    config: Config;
  }
}

export interface BuildAppOptions {
  config: Config;
  db: Db;
  pool?: pg.Pool;
  /** Override logger (tests pass false or a level). Defaults to loggerOptions(config). */
  logger?: FastifyServerOptions['logger'];
  /** Extra plugins registered after the real routes (tests use this for fixture resources). */
  plugins?: Array<{ plugin: FastifyPluginAsync; prefix?: string }>;
}

const REQ_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export async function buildApp(opts: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? loggerOptions(opts.config),
    // Honour a caller-supplied x-request-id (lets clients/SDKs correlate), else generate one.
    genReqId: (req) => {
      const h = req.headers['x-request-id'];
      return typeof h === 'string' && REQ_ID.test(h) ? h : randomUUID();
    },
    logController: new LogController({ requestIdLogLabel: 'reqId' }),
    bodyLimit: 10 * 1024 * 1024,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.decorate('db', opts.db);
  app.decorate('pool', opts.pool);
  app.decorate('config', opts.config);

  app.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', req.id);
  });

  registerErrorHandling(app, { exposeInternal: opts.config.NODE_ENV !== 'production' });

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: { title: 'Planet Express API', version: VERSION },
    },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });
  app.get('/openapi.json', { schema: { hide: true } }, async () => app.swagger());

  await registerRoutes(app);
  for (const p of opts.plugins ?? []) await app.register(p.plugin, p.prefix ? { prefix: p.prefix } : {});

  return app;
}
