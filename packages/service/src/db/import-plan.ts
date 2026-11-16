import { sql } from 'kysely';
import type { ColumnRule, ColumnType, ImportSpec } from './import.js';
import type { Executor } from './tx.js';

/**
 * Spec validation + catalog introspection for `importFromStaging`. Everything here is read-only:
 * a bad spec fails BEFORE any data is touched, with every problem listed (name, what exists, fix).
 */

export type ImportErrorCode =
  | 'IMPORT_SPEC_INVALID' // the spec is wrong: nothing was run
  | 'IMPORT_ID_TAKEN' // importId already recorded in import_runs
  | 'IMPORT_FAILED'; // the database refused the batch: transaction rolled back, nothing written

/** Every import failure states the reason (`detail`) and the fix (CLAUDE.md §4). */
export class ImportError extends Error {
  constructor(
    readonly code: ImportErrorCode,
    readonly detail: string,
    readonly fix: string,
    options?: { cause?: unknown },
  ) {
    super(`${code}: ${detail}\nFix: ${fix}`, options);
    this.name = 'ImportError';
  }
}

export interface PlannedColumn {
  /** Target column name. */
  target: string;
  /** Position in the spec; names the work-table columns b<i>/t<i>/v<i>. */
  index: number;
  rule: ColumnRule;
}

export interface ImportPlan {
  importId: string;
  source: string;
  target: string;
  onDuplicate: 'reject' | 'skip' | 'update';
  dateOrder: 'MDY' | 'DMY' | 'YMD';
  columns: PlannedColumn[];
  /** Natural key, as planned columns (same order as `spec.key`). Empty = no duplicate detection. */
  key: PlannedColumn[];
  /** Cross-column rules, `$<target>` already resolved to work-table columns `w."v<i>"`. */
  rowChecks: Array<{ expr: string; reason: string }>;
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const COLUMN_TYPES: readonly ColumnType[] = ['text', 'integer', 'bigint', 'numeric', 'boolean', 'date', 'timestamptz', 'jsonb'];
const NORMALIZERS = ['trim', 'lower', 'upper', 'number'] as const;

/** Which Postgres column types (pg_type.typname) a rule type may be written into without a lossy cast. */
const TARGET_TYPES: Record<string, readonly ColumnType[]> = {
  text: ['text'],
  varchar: ['text'],
  bpchar: ['text'],
  int2: ['integer'],
  int4: ['integer'],
  int8: ['integer', 'bigint'],
  numeric: ['integer', 'bigint', 'numeric'],
  float4: ['numeric'],
  float8: ['numeric'],
  bool: ['boolean'],
  date: ['date'],
  timestamptz: ['timestamptz'],
  jsonb: ['jsonb'],
  json: ['jsonb'],
};

const isIdent = (s: unknown): s is string => typeof s === 'string' && IDENT.test(s);
/** `table` or `schema.table`, each part a strict identifier. */
const isQualified = (s: unknown): s is string => typeof s === 'string' && s.split('.').length <= 2 && s.split('.').every((p) => IDENT.test(p));

interface TableInfo {
  exists: boolean;
  /** column name -> pg_type.typname */
  columns: Map<string, string>;
  /** other tables in the same schema, for "did you mean" lists */
  siblings: string[];
}

async function describeTable(db: Executor, name: string): Promise<TableInfo> {
  const parts = name.split('.');
  const quoted = parts.map((p) => `"${p}"`).join('.');
  const cols = await sql<{ name: string; type: string }>`
    select a.attname::text as name, t.typname::text as type
    from pg_attribute a join pg_type t on t.oid = a.atttypid
    where a.attrelid = to_regclass(${quoted}::text) and a.attnum > 0 and not a.attisdropped
    order by a.attnum`.execute(db);
  const schema = parts.length === 2 ? parts[0]! : null;
  const sib = await sql<{ relname: string }>`
    select c.relname::text as relname
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = coalesce(${schema}::text, current_schema()) and c.relkind in ('r', 'p', 'v', 'm')
    order by 1`.execute(db);
  return {
    exists: cols.rows.length > 0,
    columns: new Map(cols.rows.map((r) => [r.name, r.type])),
    siblings: sib.rows.map((r) => r.relname),
  };
}

/** Column sets of the target's plain unique indexes/constraints (what ON CONFLICT can infer). */
async function uniqueColumnSets(db: Executor, target: string): Promise<string[][]> {
  const quoted = target.split('.').map((p) => `"${p}"`).join('.');
  const r = await sql<{ cols: string[] }>`
    select array(
      select a.attname::text
      from unnest(i.indkey::int2[]) with ordinality k(attnum, ord)
      join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
      order by k.ord
    ) as cols
    from pg_index i
    where i.indrelid = to_regclass(${quoted}::text) and i.indisunique and i.indisvalid
      and i.indpred is null and i.indexprs is null`.execute(db);
  return r.rows.map((x) => x.cols);
}

const list = (xs: Iterable<string>) => [...xs].join(', ') || '(none)';

function defaultImportId(target: string): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const rand = Math.random().toString(16).slice(2, 6).padEnd(4, '0');
  return `${target.replace(/\W+/g, '_')}-${stamp}-${rand}`;
}

/** Validate the spec (pure checks, then catalog checks) and resolve it into a plan. Throws ImportError. */
export async function planImport(db: Executor, spec: ImportSpec): Promise<ImportPlan> {
  const problems: Array<{ detail: string; fix: string }> = [];
  const bad = (detail: string, fix: string) => problems.push({ detail, fix });

  // ---- pure checks -------------------------------------------------------------------------
  if (!isQualified(spec.source)) {
    bad(`source ${JSON.stringify(spec.source)} is not a table name`, `use "schema.table" or "table" with letters, digits and underscores only, e.g. source: 'staging.books'`);
  }
  if (!isQualified(spec.target)) {
    bad(`target ${JSON.stringify(spec.target)} is not a table name`, `use "schema.table" or "table" with letters, digits and underscores only, e.g. target: 'books'`);
  }
  const entries = Object.entries(spec.columns ?? {});
  if (entries.length === 0) bad('columns is empty', `map at least one target column, e.g. columns: { isbn: { from: 'isbn', type: 'text', required: true } }`);
  const onDuplicate = spec.onDuplicate ?? 'reject';
  if (!['reject', 'skip', 'update'].includes(onDuplicate)) {
    bad(`onDuplicate ${JSON.stringify(spec.onDuplicate)} is not valid`, `use 'reject' (default), 'skip' or 'update'`);
  }
  const dateOrder = spec.dateOrder ?? 'MDY';
  if (!['MDY', 'DMY', 'YMD'].includes(dateOrder)) {
    bad(`dateOrder ${JSON.stringify(spec.dateOrder)} is not valid`, `use 'MDY' (default: 01/02/2026 = 2 Jan), 'DMY' (= 1 Feb) or 'YMD'`);
  }
  if (spec.importId !== undefined && (typeof spec.importId !== 'string' || spec.importId.length === 0 || spec.importId.length > 200)) {
    bad('importId must be a non-empty string of at most 200 characters', 'omit importId to get a generated one');
  }
  for (const [col, rule] of entries) {
    const at = `columns.${col}`;
    if (!isIdent(col)) bad(`${at}: target column name is not a plain identifier`, 'use letters, digits and underscores only');
    if (!isIdent(rule.from)) bad(`${at}.from ${JSON.stringify(rule.from)} is not a plain identifier`, 'name a staging column (letters, digits, underscores)');
    if (!COLUMN_TYPES.includes(rule.type)) bad(`${at}.type ${JSON.stringify(rule.type)} is not supported`, `use one of: ${COLUMN_TYPES.join(', ')}`);
    if (rule.normalize !== undefined && !NORMALIZERS.includes(rule.normalize)) {
      bad(`${at}.normalize ${JSON.stringify(rule.normalize)} is not supported`, `use one of: ${NORMALIZERS.join(', ')}`);
    }
    if (rule.normalize === 'number' && !['integer', 'bigint', 'numeric'].includes(rule.type)) {
      bad(`${at}: normalize 'number' only applies to integer, bigint and numeric (type is '${rule.type}')`, `drop normalize or change type`);
    }
    if (rule.required && rule.default !== undefined) {
      bad(`${at}: required and default together are contradictory (a default means blank is allowed)`, `remove one of them`);
    }
    if (rule.oneOf !== undefined && (!Array.isArray(rule.oneOf) || rule.oneOf.length === 0)) {
      bad(`${at}.oneOf is empty (it would reject every row)`, `list the allowed values or remove oneOf`);
    }
    if (rule.check !== undefined && (typeof rule.check.sql !== 'string' || !/\$v\b/.test(rule.check.sql) || !rule.check.reason)) {
      bad(`${at}.check needs { sql, reason } and sql must reference the value as $v`, `e.g. check: { sql: '$v > 0', reason: 'must be positive' }`);
    }
    if (rule.ref !== undefined && !(isQualified(rule.ref.table) && isIdent(rule.ref.column))) {
      bad(`${at}.ref ${JSON.stringify(rule.ref)} has an invalid identifier`, `e.g. ref: { table: 'authors', column: 'id' }`);
    }
    if (rule.default !== undefined && (typeof rule.default !== 'string' || rule.default.trim() === '')) {
      bad(`${at}.default must be a non-empty SQL literal string`, `e.g. default: "'draft'" or default: '0'`);
    }
  }
  const key = spec.key ?? [];
  if (spec.key !== undefined && spec.key.length === 0) bad('key is an empty array', 'omit key or list the natural-key target columns');
  for (const k of key) {
    if (!(k in (spec.columns ?? {}))) {
      bad(`key column "${k}" is not one of the mapped columns`, `add "${k}" to columns (keys are compared on the cast value); mapped: ${list(Object.keys(spec.columns ?? {}))}`);
    }
  }
  if (onDuplicate !== 'reject' && key.length === 0) {
    bad(`onDuplicate '${onDuplicate}' needs a key to decide what a duplicate is`, `set key: [<target columns>], or leave onDuplicate unset`);
  }
  if (onDuplicate === 'update' && key.length > 0 && entries.every(([c]) => key.includes(c))) {
    bad(`onDuplicate 'update' has nothing to update: every mapped column is in the key`, `map at least one non-key column or use 'skip'`);
  }
  const mapped = Object.keys(spec.columns ?? {});
  for (const [n, rc] of (spec.rowChecks ?? []).entries()) {
    const refs = typeof rc?.sql === 'string' ? [...rc.sql.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]!) : [];
    if (!refs.length || !rc.reason) {
      bad(`rowChecks[${n}] needs { sql, reason } and sql must reference mapped columns as $<column>`, `e.g. rowChecks: [{ sql: '$delivered_at >= $shipped_at', reason: 'delivered before shipped' }]`);
      continue;
    }
    for (const r of refs.filter((r) => !mapped.includes(r))) {
      bad(`rowChecks[${n}] references $${r}, which is not a mapped column`, `use one of: ${list(mapped)}`);
    }
  }
  if (problems.length) throwProblems(problems);

  // ---- catalog checks (read-only) ---------------------------------------------------------
  const src = await describeTable(db, spec.source);
  if (!src.exists) {
    bad(`source table ${spec.source} does not exist`, `load it first (pnpm data:load <file>); tables in that schema: ${list(src.siblings)}`);
  } else if (!src.columns.has('_row')) {
    bad(`source ${spec.source} has no "_row" column (1-based source row number)`, `load it with scripts/data/load.ts, or add "_row bigint primary key"; columns: ${list(src.columns.keys())}`);
  }
  const tgt = await describeTable(db, spec.target);
  if (!tgt.exists) bad(`target table ${spec.target} does not exist`, `create it with a migration first; tables in that schema: ${list(tgt.siblings)}`);

  for (const [col, rule] of entries) {
    const at = `columns.${col}`;
    if (src.exists && !src.columns.has(rule.from)) {
      bad(`${at}.from: staging column "${rule.from}" not in ${spec.source}; available: ${list(src.columns.keys())}`, `use one of the available staging column names`);
    }
    if (tgt.exists) {
      const typ = tgt.columns.get(col);
      if (!typ) {
        bad(`target column "${col}" not in ${spec.target}; available: ${list(tgt.columns.keys())}`, `rename the key under columns to an existing target column, or add the column by migration`);
      } else {
        const ok = TARGET_TYPES[typ];
        if (!ok) {
          bad(`${at}: target column ${spec.target}.${col} has type ${typ}, which the importer cannot write safely`, `supported target types: ${Object.keys(TARGET_TYPES).join(', ')}; import into a supported column and convert in SQL afterwards`);
        } else if (!ok.includes(rule.type)) {
          bad(`${at}: rule type '${rule.type}' does not match ${spec.target}.${col} (${typ}); inserting would convert silently`, `set type to one of: ${ok.join(', ')}`);
        }
      }
    }
    if (rule.ref) {
      const ref = await describeTable(db, rule.ref.table);
      if (!ref.exists) bad(`${at}.ref: table ${rule.ref.table} does not exist`, `tables in that schema: ${list(ref.siblings)}; import parent tables first`);
      else if (!ref.columns.has(rule.ref.column)) bad(`${at}.ref: column "${rule.ref.column}" not in ${rule.ref.table}; available: ${list(ref.columns.keys())}`, `use an existing column`);
    }
  }
  if (problems.length) throwProblems(problems);

  if (onDuplicate === 'update') {
    const want = [...key].sort().join(',');
    const sets = await uniqueColumnSets(db, spec.target);
    if (!sets.some((s) => [...s].sort().join(',') === want)) {
      bad(`onDuplicate 'update' upserts with ON CONFLICT, but ${spec.target} has no plain unique index/constraint on exactly (${key.join(', ')}); found: ${sets.map((s) => `(${s.join(', ')})`).join(' ') || '(none)'}`, `add UNIQUE (${key.join(', ')}) by migration, or change key to match an existing unique constraint`);
      throwProblems(problems);
    }
  }

  const importId = spec.importId ?? defaultImportId(spec.target);
  const taken = await sql<{ n: number }>`select count(*)::int as n from import_runs where import_id = ${importId}`.execute(db);
  if (taken.rows[0]!.n > 0) {
    throw new ImportError('IMPORT_ID_TAKEN', `importId "${importId}" already exists in import_runs`, `pick another importId, or omit it to get a generated one; to re-run under the same id: delete from import_runs where import_id = '${importId.replace(/'/g, "''")}' (cascades to its rejects)`);
  }

  const columns = entries.map(([target, rule], index) => ({ target, index, rule }));
  return {
    importId,
    source: spec.source,
    target: spec.target,
    onDuplicate,
    dateOrder,
    columns,
    key: key.map((k) => columns.find((c) => c.target === k)!),
    rowChecks: (spec.rowChecks ?? []).map((rc) => ({
      reason: rc.reason,
      expr: rc.sql.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, name: string) => `w."v${columns.find((c) => c.target === name)!.index}"`),
    })),
  };
}

function throwProblems(problems: Array<{ detail: string; fix: string }>): never {
  const detail = problems.length === 1 ? problems[0]!.detail : `${problems.length} problems in the import spec:\n- ${problems.map((p) => p.detail).join('\n- ')}`;
  const fix = problems.length === 1 ? problems[0]!.fix : problems.map((p) => p.fix).join('; ');
  throw new ImportError('IMPORT_SPEC_INVALID', detail, fix);
}
