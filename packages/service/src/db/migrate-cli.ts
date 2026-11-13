/**
 * pnpm migrate               -> latest
 * pnpm migrate:down          -> roll back one
 * pnpm migrate:make <name>   -> new timestamp-free numbered migration file
 * pnpm --filter service migrate status
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import { loadConfig } from '../config.js';
import { loggerOptions } from '../logger.js';
import { createDb } from './kysely.js';
import { createMigrator, MIGRATIONS_DIR, migrationStatus, throwOnError } from './migrate.js';

const [cmd = 'latest', arg] = process.argv.slice(2);

const TEMPLATE = `import { sql, type Kysely } from 'kysely';

// Migrations are frozen history: never edit one that has been applied anywhere shared.
// Use Kysely<any> — migrations must not depend on the current app types.
export async function up(db: Kysely<any>): Promise<void> {
  // await db.schema.createTable('thing')
  //   .addColumn('id', 'bigint', (c) => c.primaryKey().generatedAlwaysAsIdentity())
  //   .addColumn('name', 'text', (c) => c.notNull())
  //   .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql\`now()\`))
  //   .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql\`now()\`))
  //   .execute();
  // await sql\`CREATE TRIGGER thing_updated_at BEFORE UPDATE ON thing
  //   FOR EACH ROW EXECUTE FUNCTION set_updated_at()\`.execute(db);
  void sql;
}

export async function down(db: Kysely<any>): Promise<void> {
  // await db.schema.dropTable('thing').execute();
  void db;
}
`;

async function make(name: string | undefined) {
  if (!name || !/^[a-z0-9_]+$/.test(name)) {
    throw new Error('Usage: pnpm migrate:make <snake_case_name>  (lowercase letters, digits, underscores)');
  }
  const files = (await fs.readdir(MIGRATIONS_DIR)).filter((f) => /^\d{4}_/.test(f)).sort();
  const last = files.at(-1);
  const next = String((last ? Number.parseInt(last.slice(0, 4), 10) : -1) + 1).padStart(4, '0');
  const file = path.join(MIGRATIONS_DIR, `${next}_${name}.ts`);
  await fs.writeFile(file, TEMPLATE, 'utf8');
  console.log(`created ${path.relative(process.cwd(), file)}`);
}

async function main() {
  if (cmd === 'make') return make(arg);
  const config = loadConfig();
  const log = pino(loggerOptions(config));
  const { db } = createDb({ url: config.DATABASE_URL, logger: log });
  try {
    const migrator = createMigrator(db);
    if (cmd === 'latest') {
      const r = await migrator.migrateToLatest();
      for (const m of r.results ?? []) log.info(`${m.status}: ${m.migrationName}`);
      throwOnError(r);
      if (!r.results?.length) log.info('already at latest');
    } else if (cmd === 'down') {
      const r = await migrator.migrateDown();
      for (const m of r.results ?? []) log.info(`${m.status} (down): ${m.migrationName}`);
      throwOnError(r);
    } else if (cmd === 'status') {
      console.log(JSON.stringify(await migrationStatus(db), null, 2));
    } else {
      throw new Error(`Unknown command "${cmd}". Use: latest | down | status | make <name>`);
    }
  } finally {
    await db.destroy();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
