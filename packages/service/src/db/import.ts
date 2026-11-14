import type { Kysely, Transaction } from 'kysely';
import { ImportError, planImport } from './import-plan.js';
import { executeImport } from './import-sql.js';
import type { Database } from './schema.js';
import { withTransaction, type Executor } from './tx.js';

export { ImportError, type ImportErrorCode } from './import-plan.js';

export type ColumnType = 'text' | 'integer' | 'bigint' | 'numeric' | 'boolean' | 'date' | 'timestamptz' | 'jsonb';

/**
 * How one target column is filled from one staging column. Blank / whitespace-only staging values
 * are NULL for every rule. A value that cannot be cast is a reject reason, never a silent NULL.
 */
export interface ColumnRule {
  /** Staging column to read (all staging columns are TEXT). */
  from: string;
  /** Cast target. Must match the target column's type family (checked before any data is touched). */
  type: ColumnType;
  /** Blank is a reject reason (`<col>: required`). Mutually exclusive with `default`. */
  required?: boolean;
  /**
   * Applied to the text BEFORE casting and before `oneOf`:
   * - `'trim'` / `'lower'` / `'upper'`
   * - `'number'` (integer/bigint/numeric only): strips whitespace and a trailing unit suffix
   *   (`"1,234.5 USD"` -> 1234.5, `"12 %"` -> 12). Commas are thousands separators ONLY in grouped
   *   form (`1,234.5`); `"12,5"` stays invalid (is it 12.5 or 125?) and is rejected, not guessed.
   */
  normalize?: 'trim' | 'lower' | 'upper' | 'number';
  /** Allowed values, compared to the normalized text (so pair with `normalize: 'lower'`). */
  oneOf?: string[];
  /**
   * Extra rule over the cast value, referenced as `$v` (a typed, non-NULL value), e.g.
   * `{ sql: '$v > 0 and $v < 5000', reason: 'must be between 0 and 5000' }`.
   * SECURITY: `sql` is spliced into the statement verbatim. It is developer-authored code
   * (like a migration), NEVER pass request or file content here.
   */
  check?: { sql: string; reason: string };
  /** The cast value must exist in `table.column` (import parent tables first). */
  ref?: { table: string; column: string };
  /**
   * SQL expression used when the value is blank and not `required`, e.g. `"'draft'"`, `'0'`.
   * SECURITY: developer-authored, spliced verbatim, like `check.sql`.
   */
  default?: string;
}

/**
 * What to import and how. See `importFromStaging` for a complete example.
 * Identifiers (source, target, column names, ref table/column) are validated against a strict
 * identifier pattern and quoted; a bad one throws `IMPORT_SPEC_INVALID` before any data is touched.
 */
export interface ImportSpec {
  /** Staging table, `'staging.books'` (needs the `_row` column that scripts/data/load.ts adds). */
  source: string;
  /** Real table, `'books'` or `'schema.table'`. Columns not in `columns` keep their DB defaults. */
  target: string;
  /** Target column -> rule. Only these columns are written. */
  columns: Record<string, ColumnRule>;
  /** Natural key: target columns (all must be in `columns`), compared on the cast value. NULL parts never match. */
  key?: string[];
  /**
   * What a key duplicate means (default `'reject'`):
   * - `'reject'`: later in-source duplicates and rows already in the target go to import_rejects.
   * - `'skip'`: the same rows are counted in `skippedDuplicates` (not rejects, no reason rows).
   * - `'update'`: rows already in the target are upserted (needs a UNIQUE on exactly `key`);
   *   in-source duplicates are still rejected (which one to apply is ambiguous).
   * In-source: the first row that passes every other rule wins (else the first row); the rest are the duplicates.
   */
  onDuplicate?: 'reject' | 'skip' | 'update';
  /** Id of this run in import_runs / import_rejects. Default: `<target>-<utc timestamp>-<rand>`. Must be unused. */
  importId?: string;
  /**
   * How slash/dash dates are read by Postgres (default `'MDY'`: `01/02/2026` = 2 Jan). Day-first
   * sources MUST set `'DMY'`. ISO `2026-02-01` is unambiguous either way. Decide per dataset and
   * record it in docs/decisions.md.
   */
  dateOrder?: 'MDY' | 'DMY' | 'YMD';
}

export interface ReasonSummary {
  /** Target column the reason is about (for key duplicates: the key columns, comma-joined). */
  column: string;
  /** Reason template without the offending value, e.g. `is not a valid numeric`. */
  reason: string;
  /** Rows with this reason (a row with several reasons counts once under each). */
  count: number;
  /** Up to 5 source row numbers (`_row`), ascending. */
  sampleRows: number[];
}

/** Every source row is exactly one of inserted / updated / rejected / skippedDuplicates. */
export interface ImportReport {
  importId: string;
  source: string;
  target: string;
  total: number;
  inserted: number;
  updated: number;
  rejected: number;
  skippedDuplicates: number;
  /** Sorted by count descending. Inspect: `select source_row, reasons, raw from import_rejects where import_id = $1 order by source_row`. */
  byReason: ReasonSummary[];
}

/**
 * Set-based import of a staging table (all-TEXT columns + `_row`) into a typed table. Every source
 * row either lands in the target or in `import_rejects` with its source row number, ALL its
 * failure reasons and the full raw row. Nothing is silently dropped, coerced or defaulted.
 * One transaction: either everything (rows, rejects, the `import_runs` row) is written or nothing.
 * Handles ~50k rows in about a second (it is a handful of statements, not a row loop).
 *
 * @example
 * ```ts
 * const report = await importFromStaging(db, {
 *   source: 'staging.books',
 *   target: 'books',
 *   key: ['isbn'],                     // natural key; onDuplicate defaults to 'reject'
 *   dateOrder: 'DMY',                  // the file is day-first
 *   columns: {
 *     isbn:          { from: 'isbn',          type: 'text', required: true, normalize: 'upper' },
 *     author_id:     { from: 'author_id',     type: 'bigint', required: true,
 *                      ref: { table: 'authors', column: 'id' } },
 *     price_usd:     { from: 'price',         type: 'numeric', normalize: 'number',   // "1,234.5 USD"
 *                      check: { sql: '$v > 0', reason: 'must be positive' } },
 *     status:        { from: 'status',        type: 'text', normalize: 'lower',
 *                      oneOf: ['draft', 'in_review', 'published', 'out_of_print'], default: "'draft'" },
 *     published_on:  { from: 'published',     type: 'date' },
 *   },
 * });
 * // report.total === report.inserted + report.updated + report.rejected + report.skippedDuplicates
 * // report.byReason[0] -> { column: 'price_usd', reason: 'is not a valid numeric', count: 12, sampleRows: [3, 9, ...] }
 * ```
 *
 * Reason texts (one array entry per failed rule, in `import_rejects.reasons`):
 * `price_usd: "12,5USD" is not a valid numeric` · `status: "printed" not in (draft|in_review|published|out_of_print)` ·
 * `author_id: no authors.id = 99` · `isbn: required` · `price_usd: must be positive (got "-3")` ·
 * `duplicate of source row 17 on (isbn)` · `already exists in books on (isbn)`.
 *
 * Executor: pass the db (the import opens its own transaction) or a transaction (it joins yours;
 * if the database refuses the batch your transaction is aborted too, as with any failed statement).
 *
 * Errors (`ImportError`, each with `code`, `detail`, `fix`): `IMPORT_SPEC_INVALID` (lists every
 * problem with the available names; nothing ran), `IMPORT_ID_TAKEN`, `IMPORT_FAILED` (the target
 * refused the batch, e.g. a constraint no rule covers: everything was rolled back).
 */
export async function importFromStaging(db: Executor, spec: ImportSpec): Promise<ImportReport> {
  try {
    const run = async (trx: Transaction<Database>) => executeImport(trx, await planImport(trx, spec));
    // A Kysely Transaction reports isTransaction; join it instead of nesting.
    return db.isTransaction ? await run(db as Transaction<Database>) : await withTransaction(db as Kysely<Database>, run);
  } catch (err) {
    throw err instanceof ImportError ? err : refused(err, spec);
  }
}

interface PgErrorLike {
  code?: string;
  message?: string;
  detail?: string;
  constraint?: string;
  column?: string;
  table?: string;
}

/** Translate a Postgres refusal into the reason AND the fix; the transaction already rolled back. */
function refused(err: unknown, spec: ImportSpec): unknown {
  const e = err as PgErrorLike;
  if (typeof e?.code !== 'string' || e.code.length !== 5) return err;
  const where = [e.constraint && `constraint ${e.constraint}`, e.table && `table ${e.table}`, e.column && `column ${e.column}`].filter(Boolean).join(', ');
  const detail = `${spec.target} refused the batch (${e.code}${where ? `, ${where}` : ''}): ${e.message ?? 'unknown error'}${e.detail ? ` ${e.detail}` : ''}. The whole import was rolled back; nothing was written`;
  const fix =
    e.code === '23505'
      ? `a unique constraint not covered by the spec was violated: add its columns to key (with onDuplicate 'reject' | 'skip'), or dedupe the staging data`
      : e.code === '23514'
        ? `a CHECK constraint the spec does not mirror was violated: add a check: { sql, reason } rule for that column so such rows are rejected with a reason`
        : e.code === '23502'
          ? `a NOT NULL column received NULL: mark the mapped column required: true, or give it a default`
          : e.code === '23503'
            ? `a foreign key was violated: add a ref: { table, column } rule for that column`
            : e.code.startsWith('22')
              ? `a value does not fit the target column (range / length / format): add a check rule bounding it, or widen the column by migration`
              : `read the message above; fix the spec or the target schema, then re-run`;
  return new ImportError('IMPORT_FAILED', detail, fix, { cause: err });
}
