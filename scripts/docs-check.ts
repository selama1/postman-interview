/**
 * Docs drift gate: every HTTP route the app registers must be documented in docs/llms.txt
 * (§ API surface). Builds the real app (no DB connection is opened) and diffs its OpenAPI paths
 * against the doc. Run by `pnpm docs:check`; the `feature` skill runs it before committing.
 *
 * Fail output names each undocumented route and the fix.
 */
import { readFileSync } from 'node:fs';
import { loadConfig } from '../packages/service/src/config.js';
import { createDb } from '../packages/service/src/db/kysely.js';
import { buildApp } from '../packages/service/src/http/app.js';

const config = loadConfig({ ...process.env, DATABASE_URL: 'postgres://x:x@127.0.0.1:1/x', LOG_LEVEL: 'silent' });
const { db } = createDb({ url: config.DATABASE_URL });
const app = await buildApp({ config, db, logger: false });
await app.ready();
const spec = app.swagger() as { paths?: Record<string, Record<string, unknown>> };
const routes = Object.entries(spec.paths ?? {}).flatMap(([p, ops]) =>
  Object.keys(ops).filter((m) => m !== 'parameters').map((m) => `${m.toUpperCase()} ${p.replace(/\{(\w+)\}/g, ':$1')}`),
);
await app.close();
await db.destroy();

const doc = readFileSync('docs/llms.txt', 'utf8');
const missing = routes.filter((r) => !doc.includes(r));
if (missing.length) {
  console.error(`docs-check: ${missing.length} route(s) not documented in docs/llms.txt § API surface:`);
  for (const r of missing) console.error(`  - ${r}`);
  console.error('Fix: add a line per route to the "API surface" section of docs/llms.txt (method, path, one-line purpose).');
  process.exitCode = 1;
} else {
  console.log(`docs-check: all ${routes.length} routes documented.`);
}
