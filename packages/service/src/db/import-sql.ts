import { randomBytes } from 'node:crypto';
import { sql, type RawBuilder, type Transaction } from 'kysely';
import { ImportError, type ImportPlan, type PlannedColumn } from './import-plan.js';
import type { ImportReport } from './import.js';
import type { Database } from './schema.js';

/**
 * The set-based engine behind `importFromStaging`. One pass, no row loop:
 *
 *   W   work table  (source_row, b<i> raw, t<i> normalized text, v<i> typed value) per mapped column
 *   RS  one row per (source row, failed rule): column, reason template, reason text, ord
 *   BAD source rows with at least one non-duplicate reason
 *   DUP source rows that duplicate a key (within the source, or already in the target)
 *   REJ source_row -> all its reasons
 *
 * then ONE `insert ... select` into the target, ONE insert into import_rejects, one into
 * import_runs. Identifiers are validated (import-plan.ts) and quoted with `sql.id`; literals use
 * `sql.lit`; the only raw SQL is developer-authored (`check.sql`, `default`) and constants here.
 * Must run inside a transaction (temp tables are `on commit drop`).
 */

const id = (name: string) => sql.id(...name.split('.'));
const w = (col: string) => sql.ref(`w.${col}`);
const join = (xs: RawBuilder<unknown>[], sep = ', ') => sql.join(xs, sql.raw(sep));

// Slot numbers keep the reasons of one column in a stable order: required, cast, oneOf, check, ref.
const ORD_DUPLICATE = 100_000;

/** Normalized text of base value `x` (non-null, non-blank). */
function normalized(rule: PlannedColumn['rule'], x: RawBuilder<unknown>): RawBuilder<unknown> {
  switch (rule.normalize) {
    case undefined:
      return x;
    case 'trim':
      return sql`btrim(${x})`;
    case 'lower':
      return sql`lower(btrim(${x}))`;
    case 'upper':
      return sql`upper(btrim(${x}))`;
    case 'number': {
      // Strip a trailing unit ("USD", "%", "km/h") and all whitespace; thousands commas only when the
      // value is a well-formed grouped number ("1,234.5"), so "12,5" stays invalid instead of
      // silently becoming 125. If stripping leaves nothing ("USD", "N/A") keep the original so the
      // cast fails and the row is rejected rather than treated as blank.
      const stripped = sql`coalesce(nullif(regexp_replace(regexp_replace(btrim(${x}), '[[:alpha:]%°/]+$', ''), '[[:space:]]', '', 'g'), ''), btrim(${x}))`;
      return sql`(case when ${stripped} ~ '^[+-]?[0-9]{1,3}(,[0-9]{3})+(\\.[0-9]+)?$' then replace(${stripped}, ',', '') else ${stripped} end)`;
    }
  }
}

/** SQL boolean: can normalized text `t` be cast to the rule's type? Never raises. */
function castable(rule: PlannedColumn['rule'], t: RawBuilder<unknown>): RawBuilder<unknown> {
  const type = sql.lit(rule.type);
  switch (rule.type) {
    case 'text':
      return sql`true`;
    case 'boolean':
    case 'jsonb':
      return sql`pg_input_is_valid(${t}, ${type})`;
    default:
      // Needs a digit: rejects 'NaN', 'Infinity', and the date specials 'now', 'today', 'epoch'
      // that Postgres would otherwise accept and silently turn into the import date.
      return sql`(${t} ~ '[0-9]' and pg_input_is_valid(${t}, ${type}))`;
  }
}

const typeName = (rule: PlannedColumn['rule']) => sql.raw(rule.type);

function workTableSql(plan: ImportPlan, W: RawBuilder<unknown>): RawBuilder<unknown> {
  const base = plan.columns.map(
    (c) => sql`case when btrim(s.${sql.id(c.rule.from)}::text) = '' then null else s.${sql.id(c.rule.from)}::text end as ${sql.id(`b${c.index}`)}`,
  );
  const norm = plan.columns.map((c) => sql`${normalized(c.rule, sql.ref(`m.b${c.index}`))} as ${sql.id(`t${c.index}`)}`);
  const typed = plan.columns.map((c) => {
    const t = sql.ref(`n.t${c.index}`);
    const dflt = c.rule.default !== undefined ? sql`(${sql.raw(c.rule.default)})::${typeName(c.rule)}` : sql`null`;
    return sql`case when ${t} is null then ${dflt} when ${castable(c.rule, t)} then ${t}::${typeName(c.rule)} end as ${sql.id(`v${c.index}`)}`;
  });
  const carry = plan.columns.flatMap((c) => [sql.ref(`n.b${c.index}`), sql.ref(`n.t${c.index}`)]);
  const carryM = plan.columns.map((c) => sql.ref(`m.b${c.index}`));
  return sql`
    create temp table ${W} on commit drop as
    select n.source_row, ${join(carry)}, ${join(typed)}
    from (
      select m.source_row, ${join(carryM)}, ${join(norm)}
      from (
        select s."_row"::bigint as source_row, ${join(base)}
        from ${id(plan.source)} s
      ) m
    ) n`;
}

/** One `select ... from W where <failed>` per rule; the union is the reasons table. */
function reasonsSql(plan: ImportPlan, W: RawBuilder<unknown>, RS: RawBuilder<unknown>): RawBuilder<unknown> {
  const parts: RawBuilder<unknown>[] = [
    sql`select null::bigint as source_row, 0 as ord, ''::text as col, ''::text as tpl, ''::text as reason where false`,
  ];
  const add = (ord: number, col: string, tpl: string, reason: RawBuilder<unknown>, failed: RawBuilder<unknown>) =>
    parts.push(
      sql`select w.source_row, ${sql.lit(ord)}::int as ord, ${sql.lit(col)}::text as col, ${sql.lit(tpl)}::text as tpl, ${reason} as reason from ${W} w where ${failed}`,
    );
  for (const c of plan.columns) {
    const { rule, target, index: i } = c;
    const b = w(`b${i}`);
    const t = w(`t${i}`);
    const v = w(`v${i}`);
    const at = (slot: number) => i * 10 + slot;
    if (rule.required) add(at(1), target, 'required', sql`${sql.lit(`${target}: required`)}`, sql`${t} is null`);
    if (rule.type !== 'text') {
      add(at(2), target, `is not a valid ${rule.type}`, sql`${sql.lit(`${target}: "`)} || ${b} || ${sql.lit(`" is not a valid ${rule.type}`)}`, sql`${t} is not null and not ${castable(rule, t)}`);
    }
    if (rule.oneOf) {
      const tpl = `not in (${rule.oneOf.join('|')})`;
      add(at(3), target, tpl, sql`${sql.lit(`${target}: "`)} || ${b} || ${sql.lit(`" ${tpl}`)}`, sql`${t} is not null and not (${t} = any (array[${join(rule.oneOf.map((x) => sql.lit(x)))}]::text[]))`);
    }
    if (rule.check) {
      const expr = sql.raw(rule.check.sql.replace(/\$v\b/g, `w."v${i}"`));
      add(at(4), target, rule.check.reason, sql`${sql.lit(`${target}: ${rule.check.reason} (got "`)} || coalesce(${b}, '') || '")'`, sql`${v} is not null and ((${expr}) is not true)`);
    }
    if (rule.ref) {
      const ref = rule.ref;
      add(at(5), target, `no matching ${ref.table}.${ref.column}`, sql`${sql.lit(`${target}: no ${ref.table}.${ref.column} = `)} || ${b}`, sql`${v} is not null and not exists (select 1 from ${id(ref.table)} r where r.${sql.id(ref.column)} = ${v})`);
    }
  }
  return sql`create temp table ${RS} on commit drop as ${sql.join(parts, sql` union all `)}`;
}

/** Counts and per-reason summary come out of the same tables the writes use. */
export async function executeImport(trx: Transaction<Database>, plan: ImportPlan): Promise<ImportReport> {
  const sfx = randomBytes(4).toString('hex');
  const W = sql.id(`_imp_w_${sfx}`);
  const RS = sql.id(`_imp_rs_${sfx}`);
  const BAD = sql.id(`_imp_bad_${sfx}`);
  const DUP = sql.id(`_imp_dup_${sfx}`);
  const REJ = sql.id(`_imp_rej_${sfx}`);
  const startedAt = new Date();

  // Date parsing depends on DateStyle (01/02/2026: Jan 2 or Feb 1?). Pin it for this transaction,
  // restore it after, so an enclosing caller transaction is not affected.
  const prev = (await sql<{ v: string }>`select current_setting('DateStyle') as v`.execute(trx)).rows[0]!.v;
  await sql`select set_config('DateStyle', ${`ISO, ${plan.dateOrder}`}, true)`.execute(trx);

  await workTableSql(plan, W).execute(trx);
  const acct = (await sql<{ total: number; distinct_rows: number }>`select count(*)::int as total, count(distinct source_row)::int as distinct_rows from ${W}`.execute(trx)).rows[0]!;
  if (acct.total !== acct.distinct_rows) {
    throw new ImportError('IMPORT_FAILED', `${plan.source} has duplicate "_row" values (${acct.total} rows, ${acct.distinct_rows} distinct), so rows cannot be reported by number`, `make "_row" unique (it is the primary key when loaded with scripts/data/load.ts); nothing was written`);
  }
  await reasonsSql(plan, W, RS).execute(trx);
  await sql`create temp table ${BAD} on commit drop as select distinct source_row from ${RS}`.execute(trx);

  // ---- duplicates on the natural key -------------------------------------------------------
  const keyLabel = plan.key.map((k) => k.target).join(', ');
  if (plan.key.length === 0) {
    await sql`create temp table ${DUP} (source_row bigint, kind text, ref_row bigint) on commit drop`.execute(trx);
  } else {
    const known = join(plan.key.map((k) => sql`${w(`v${k.index}`)} is not null`), ' and ');
    const partition = join(plan.key.map((k) => w(`v${k.index}`)));
    const sameAsTarget = join(plan.key.map((k) => sql`t.${sql.id(k.target)} = ${w(`v${k.index}`)}`), ' and ');
    // First occurrence wins, preferring a row that passes every other rule, so the winner is a row
    // that actually lands; later ones are the duplicates and name the winner.
    await sql`
      create temp table ${DUP} on commit drop as
      select x.source_row, 'within'::text as kind, x.winner as ref_row from (
        select w.source_row,
          first_value(w.source_row) over (partition by ${partition} order by (b.source_row is not null), w.source_row) as winner
        from ${W} w left join ${BAD} b on b.source_row = w.source_row
        where ${known}
      ) x where x.source_row <> x.winner
      union all
      select w.source_row, 'existing'::text, null::bigint from ${W} w
      where ${known} and exists (select 1 from ${id(plan.target)} t where ${sameAsTarget})`.execute(trx);
    // reject: both kinds are reasons. update: only within-source ones (ambiguous which row to apply).
    // skip: neither (counted as skipped_duplicates unless the row has other problems).
    if (plan.onDuplicate !== 'skip') {
      await sql`insert into ${RS}
        select d.source_row, ${sql.lit(ORD_DUPLICATE)}::int, ${sql.lit(keyLabel)}::text, 'duplicate of an earlier source row',
          'duplicate of source row ' || d.ref_row || ${sql.lit(` on (${keyLabel})`)}
        from ${DUP} d where d.kind = 'within'`.execute(trx);
    }
    if (plan.onDuplicate === 'reject') {
      await sql`insert into ${RS}
        select d.source_row, ${sql.lit(ORD_DUPLICATE + 1)}::int, ${sql.lit(keyLabel)}::text, ${sql.lit(`already exists in ${plan.target}`)},
          ${sql.lit(`already exists in ${plan.target} on (${keyLabel})`)}
        from ${DUP} d where d.kind = 'existing'`.execute(trx);
    }
  }

  await sql`create temp table ${REJ} on commit drop as
    select source_row, array_agg(reason order by ord, reason) as reasons from ${RS} group by source_row`.execute(trx);

  // ---- writes ------------------------------------------------------------------------------
  const skipFilter = plan.onDuplicate === 'skip' ? sql`and not exists (select 1 from ${DUP} d where d.source_row = w.source_row)` : sql``;
  const nonKey = plan.columns.filter((c) => !plan.key.includes(c));
  const onConflict =
    plan.onDuplicate === 'update'
      ? sql`on conflict (${join(plan.key.map((k) => sql.id(k.target)))}) do update set ${join(nonKey.map((c) => sql`${sql.id(c.target)} = excluded.${sql.id(c.target)}`))}`
      : sql``;
  // xmax = 0 is true for a freshly inserted row and false for one rewritten by ON CONFLICT DO UPDATE.
  const written = (
    await sql<{ inserted: number; updated: number }>`
      with ins as (
        insert into ${id(plan.target)} (${join(plan.columns.map((c) => sql.id(c.target)))})
        select ${join(plan.columns.map((c) => w(`v${c.index}`)))}
        from ${W} w
        where not exists (select 1 from ${REJ} r where r.source_row = w.source_row) ${skipFilter}
        order by w.source_row
        ${onConflict}
        returning (xmax = 0) as is_insert
      )
      select (count(*) filter (where is_insert))::int as inserted, (count(*) filter (where not is_insert))::int as updated from ins`.execute(trx)
  ).rows[0]!;

  const skippedDuplicates =
    plan.onDuplicate === 'skip'
      ? (await sql<{ n: number }>`select count(distinct d.source_row)::int as n from ${DUP} d where not exists (select 1 from ${REJ} r where r.source_row = d.source_row)`.execute(trx)).rows[0]!.n
      : 0;
  const rejected = (await sql<{ n: number }>`select count(*)::int as n from ${REJ}`.execute(trx)).rows[0]!.n;

  await sql`insert into import_runs (import_id, source, target, on_duplicate, total, inserted, updated, rejected, skipped_duplicates, started_at, finished_at)
    values (${plan.importId}, ${plan.source}, ${plan.target}, ${plan.onDuplicate}, ${acct.total}, ${written.inserted}, ${written.updated}, ${rejected}, ${skippedDuplicates}, ${startedAt}, clock_timestamp())`.execute(trx);
  await sql`insert into import_rejects (import_id, source, target, source_row, reasons, raw)
    select ${plan.importId}, ${plan.source}, ${plan.target}, r.source_row, r.reasons, to_jsonb(s)
    from ${REJ} r join ${id(plan.source)} s on s."_row" = r.source_row
    order by r.source_row`.execute(trx);

  const byReason = (
    await sql<{ column: string; reason: string; count: number; sample_rows: string[] }>`
      select col as "column", tpl as reason, count(*)::int as count, (array_agg(source_row order by source_row))[1:5] as sample_rows
      from ${RS} group by col, tpl order by count(*) desc, col, tpl`.execute(trx)
  ).rows.map((r) => ({ column: r.column, reason: r.reason, count: r.count, sampleRows: r.sample_rows.map(Number) }));

  for (const t of [W, RS, BAD, DUP, REJ]) await sql`drop table ${t}`.execute(trx);
  await sql`select set_config('DateStyle', ${prev}, true)`.execute(trx);

  return {
    importId: plan.importId,
    source: plan.source,
    target: plan.target,
    total: acct.total,
    inserted: written.inserted,
    updated: written.updated,
    rejected,
    skippedDuplicates,
    byReason,
  };
}
