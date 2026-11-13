import type { ColumnType, Generated } from 'kysely';

/**
 * Kysely table types. One interface per table, keyed by table name in `Database`.
 *
 * Conventions (see docs/llms.txt § Database):
 * - Generated<T>     columns the DB fills (serial/identity, defaults like now()).
 * - ColumnType<S,I,U> when select/insert/update types differ.
 * - Postgres `numeric`/`bigint` come back from `pg` as strings — type them `string` (or parse
 *   explicitly in the mapper), never silently `number`. (Exception: kysely.ts parses int8 to
 *   number globally, so bigint columns are typed `number` here.)
 * - Optional: regenerate from the live dev DB with `pnpm --filter service db:types` (kysely-codegen)
 *   when a dataset has many columns; then hand-tune.
 *
 * Business tables arrive with the data; only the import bookkeeping tables exist in the scaffold.
 */

/** One row per `importFromStaging` run (src/db/import.ts). */
export interface ImportRunsTable {
  import_id: string;
  source: string;
  target: string;
  on_duplicate: 'reject' | 'skip' | 'update';
  total: number;
  inserted: number;
  updated: number;
  rejected: number;
  skipped_duplicates: number;
  started_at: ColumnType<Date, Date | string, Date | string>;
  finished_at: ColumnType<Date, Date | string, Date | string>;
}

/** One row per source row that was not imported: its source row number, ALL reasons, the raw row. */
export interface ImportRejectsTable {
  id: Generated<number>;
  import_id: string;
  source: string;
  target: string;
  source_row: number;
  reasons: string[];
  raw: ColumnType<Record<string, string | null>, string, string>;
  created_at: Generated<Date>;
}

export interface Database {
  import_runs: ImportRunsTable;
  import_rejects: ImportRejectsTable;
}
