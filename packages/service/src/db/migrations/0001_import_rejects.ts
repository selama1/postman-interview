import { sql, type Kysely } from 'kysely';

/**
 * Bookkeeping for `importFromStaging` (src/db/import.ts): one `import_runs` row per import and one
 * `import_rejects` row per source row that was NOT imported, with ALL its reasons and the full raw
 * staging row. Two tables (not one) because a run is one fact and a reject is many; the FK makes
 * "which run produced this reject" and "delete a run with its rejects" integrity, not convention.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('import_runs')
    .addColumn('import_id', 'text', (c) => c.primaryKey())
    .addColumn('source', 'text', (c) => c.notNull())
    .addColumn('target', 'text', (c) => c.notNull())
    .addColumn('on_duplicate', 'text', (c) => c.notNull().check(sql`on_duplicate in ('reject', 'skip', 'update')`))
    .addColumn('total', 'integer', (c) => c.notNull())
    .addColumn('inserted', 'integer', (c) => c.notNull())
    .addColumn('updated', 'integer', (c) => c.notNull())
    .addColumn('rejected', 'integer', (c) => c.notNull())
    .addColumn('skipped_duplicates', 'integer', (c) => c.notNull())
    .addColumn('started_at', sql`timestamptz(3)`, (c) => c.notNull())
    .addColumn('finished_at', sql`timestamptz(3)`, (c) => c.notNull())
    // Row accounting is an invariant of the importer; the DB refuses a run that does not add up.
    .addCheckConstraint(
      'import_runs_row_accounting',
      sql`inserted + updated + rejected + skipped_duplicates = total`,
    )
    .execute();

  await db.schema
    .createTable('import_rejects')
    .addColumn('id', 'bigint', (c) => c.primaryKey().generatedAlwaysAsIdentity())
    .addColumn('import_id', 'text', (c) => c.notNull().references('import_runs.import_id').onDelete('cascade'))
    .addColumn('source', 'text', (c) => c.notNull())
    .addColumn('target', 'text', (c) => c.notNull())
    .addColumn('source_row', 'bigint', (c) => c.notNull())
    .addColumn('reasons', sql`text[]`, (c) => c.notNull().check(sql`cardinality(reasons) > 0`))
    .addColumn('raw', 'jsonb', (c) => c.notNull())
    .addColumn('created_at', sql`timestamptz(3)`, (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  await sql`CREATE INDEX import_rejects_import_id_idx ON import_rejects (import_id, source_row)`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('import_rejects').execute();
  await db.schema.dropTable('import_runs').execute();
}
