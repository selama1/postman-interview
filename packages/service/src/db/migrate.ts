import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Kysely } from 'kysely';
import { Migrator, type Migration, type MigrationProvider, type MigrationResultSet } from 'kysely/migration';

export const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

const isMigrationFile = (f: string) => /^\d{4}_[a-z0-9_]+\.(ts|js|mjs)$/.test(f) && !f.endsWith('.d.ts');

/**
 * Migrations are Kysely migration modules in src/db/migrations named `NNNN_description.ts`
 * (lexical order = apply order). They compile to dist/ with the app, so the container runs
 * exactly the migrations it was built with.
 *
 * Own provider instead of Kysely's FileMigrationProvider: that one calls import() with a raw
 * absolute path, which fails on Windows (needs a file:// URL) and bypasses vitest's loader.
 */
export class DirMigrationProvider implements MigrationProvider {
  constructor(private readonly dir: string = MIGRATIONS_DIR) {}
  async getMigrations(): Promise<Record<string, Migration>> {
    const files = (await fs.readdir(this.dir)).filter(isMigrationFile).sort();
    const out: Record<string, Migration> = {};
    for (const f of files) {
      const mod = (await import(pathToFileURL(path.join(this.dir, f)).href)) as Migration;
      out[f.replace(/\.(ts|js|mjs)$/, '')] = mod;
    }
    return out;
  }
}

/** Content hash of all migration files: the test harness rebuilds its template DB when it changes. */
export async function migrationsFingerprint(dir: string = MIGRATIONS_DIR): Promise<string> {
  const h = createHash('sha256');
  for (const f of (await fs.readdir(dir)).filter(isMigrationFile).sort()) {
    h.update(f).update('\0').update(await fs.readFile(path.join(dir, f))).update('\0');
  }
  return h.digest('hex').slice(0, 16);
}

// Kysely<any>: migrations must not depend on current app types.
export function createMigrator(db: Kysely<any>): Migrator {
  return new Migrator({ db, provider: new DirMigrationProvider() });
}

export async function migrateToLatest(db: Kysely<any>): Promise<MigrationResultSet> {
  const result = await createMigrator(db).migrateToLatest();
  throwOnError(result);
  return result;
}

export async function migrationStatus(db: Kysely<any>) {
  const all = await createMigrator(db).getMigrations();
  const executed = all.filter((m) => m.executedAt);
  return {
    executed: executed.length,
    pending: all.filter((m) => !m.executedAt).map((m) => m.name),
    latest: executed.at(-1)?.name ?? null,
  };
}

export function throwOnError(result: MigrationResultSet): void {
  const failed = result.results?.find((r) => r.status === 'Error');
  if (failed || result.error) {
    const cause = result.error instanceof Error ? result.error : new Error(String(result.error));
    const which = failed ? `Migration "${failed.migrationName}" failed` : 'Migration failed';
    throw new Error(`${which}: ${cause.message}\nFix: correct the migration (or roll back with \`pnpm migrate:down\`) and re-run.`, { cause });
  }
}
