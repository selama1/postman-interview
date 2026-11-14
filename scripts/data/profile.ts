/**
 * Profile a table so schema decisions come from facts, not guesses.
 *
 *   pnpm data:profile staging.books
 *   pnpm data:profile public.authors --sample 5
 *
 * Per column: non-null / null / empty counts, distinct count, candidate-key flag, inferred type
 * (fraction of values parsing as int, decimal, bool, date, timestamp, uuid, email), length range,
 * top values, and anomaly flags (mixed types, leading/trailing spaces, case-variant duplicates,
 * placeholder nulls like 'N/A'). Across tables in the same schema: candidate foreign keys
 * (columns whose distinct values are all contained in another table's candidate key).
 *
 * Writes the markdown report to stdout and data/out/profile-<schema>.<table>.md.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import pg from 'pg';
import { argValue, databaseUrl, quoteIdent as q } from './util.js';

const target = process.argv[2];
if (!target || target.startsWith('--')) {
  console.error('Usage: pnpm data:profile <schema.table> [--sample N]');
  process.exit(2);
}
const [schema, table] = target.includes('.') ? (target.split('.') as [string, string]) : ['staging', target];
const topN = Number(argValue('--sample') ?? 5);

const PATTERNS: Record<string, string> = {
  int: `^[-+]?\\d+$`,
  decimal: `^[-+]?(\\d+\\.?\\d*|\\.\\d+)([eE][-+]?\\d+)?$`,
  bool: `^(true|false|t|f|yes|no|y|n|0|1)$`,
  date: `^\\d{4}-\\d{2}-\\d{2}$`,
  timestamp: `^\\d{4}-\\d{2}-\\d{2}[ T]\\d{2}:\\d{2}(:\\d{2}(\\.\\d+)?)?(Z|[+-]\\d{2}(:?\\d{2})?)?$`,
  usdate: `^\\d{1,2}/\\d{1,2}/\\d{2,4}$`,
  uuid: `^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`,
  email: `^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$`,
};
const PLACEHOLDERS = `('n/a','na','null','none','-','?','unknown','tbd','')`;

async function main() {
  const c = new pg.Client({ connectionString: databaseUrl() });
  await c.connect();
  try {
    const { rows: colRows } = await c.query<{ column_name: string; data_type: string }>(
      `select column_name, data_type from information_schema.columns where table_schema=$1 and table_name=$2 and column_name <> '_row' order by ordinal_position`,
      [schema, table],
    );
    if (!colRows.length) throw new Error(`No such table ${schema}.${table} (or no columns). Fix: pnpm data:load <file> first; list tables with \\dt ${schema}.*`);
    const rel = `${q(schema)}.${q(table)}`;
    const [{ n: total }] = (await c.query<{ n: number }>(`select count(*)::int as n from ${rel}`)).rows as [{ n: number }];

    const out: string[] = [`# Profile: ${schema}.${table}`, '', `Rows: **${total}** · Columns: **${colRows.length}**`, ''];
    const summary: string[] = ['| column | db type | nulls | empty/placeholder | distinct | key? | inferred | len | flags |', '|---|---|---|---|---|---|---|---|---|'];
    const details: string[] = [];
    const keyCols: string[] = [];

    for (const { column_name: col, data_type } of colRows) {
      const ci = q(col);
      const txt = `${ci}::text`;
      const typeChecks = Object.entries(PATTERNS)
        .map(([k, re]) => `count(*) filter (where btrim(${txt}) ~* '${re}')::int as "${k}"`)
        .join(', ');
      const { rows } = await c.query(`
        select count(${ci})::int as nonnull,
               count(*) filter (where ${ci} is null)::int as nulls,
               count(*) filter (where lower(btrim(${txt})) in ${PLACEHOLDERS})::int as placeholders,
               count(distinct ${ci})::int as distinct,
               count(distinct lower(btrim(${txt})))::int as distinct_norm,
               count(*) filter (where ${txt} <> btrim(${txt}))::int as padded,
               min(length(${txt}))::int as minlen, max(length(${txt}))::int as maxlen,
               ${typeChecks}
        from ${rel}`);
      const s = rows[0] as Record<string, number>;
      const meaningful = s.nonnull! - s.placeholders!;
      const inferred = meaningful > 0
        ? Object.keys(PATTERNS)
            .map((k) => ({ k, frac: s[k]! / meaningful }))
            .filter((x) => x.frac >= 0.98)
            .map((x) => x.k)
        : [];
      // most specific first
      const order = ['bool', 'int', 'decimal', 'uuid', 'date', 'timestamp', 'usdate', 'email'];
      const dateLike = (s.date! + s.timestamp! + s.usdate!) / Math.max(meaningful, 1);
      const best =
        order.find((k) => inferred.includes(k)) ??
        (dateLike >= 0.9 ? 'MIXED dates' : Object.keys(PATTERNS).some((k) => s[k]! / Math.max(meaningful, 1) > 0.5) ? 'MIXED' : 'text');
      const isKey = s.nulls === 0 && s.placeholders === 0 && s.distinct === total && total > 0;
      if (isKey) keyCols.push(col);
      const flags: string[] = [];
      if (best === 'MIXED') flags.push('mixed types');
      if (best === 'MIXED dates') flags.push('mixed date formats — normalise before casting');
      if (s.padded) flags.push(`${s.padded} padded`);
      if (s.distinct_norm! < s.distinct!) flags.push(`${s.distinct! - s.distinct_norm!} case/space variants`);
      if (s.placeholders) flags.push('placeholder nulls');
      if (s.distinct === 1 && total > 1) flags.push('constant');
      if (inferred.includes('usdate')) flags.push('ambiguous M/D dates');
      summary.push(`| ${col} | ${data_type} | ${s.nulls} | ${s.placeholders} | ${s.distinct} | ${isKey ? 'YES' : ''} | ${best} | ${s.minlen ?? ''}–${s.maxlen ?? ''} | ${flags.join('; ')} |`);

      const { rows: top } = await c.query(`select ${txt} as v, count(*)::int as n from ${rel} group by 1 order by 2 desc, 1 limit ${topN}`);
      const nonMatching = best in PATTERNS
        ? (await c.query(`select ${txt} as v, count(*)::int as n from ${rel} where ${ci} is not null and lower(btrim(${txt})) not in ${PLACEHOLDERS} and btrim(${txt}) !~* '${PATTERNS[best]!}' group by 1 order by 2 desc limit 5`)).rows
        : [];
      details.push(
        `### ${col}`,
        `top: ${top.map((r) => `\`${String(r.v).slice(0, 40)}\`×${r.n}`).join(', ')}`,
        ...(nonMatching.length ? [`not ${best}: ${nonMatching.map((r) => `\`${String(r.v).slice(0, 40)}\`×${r.n}`).join(', ')}`] : []),
        '',
      );
    }

    // candidate FKs within the schema: values of col ⊆ candidate key of another table
    const fks: string[] = [];
    const { rows: others } = await c.query<{ table_name: string }>(
      `select table_name from information_schema.tables where table_schema=$1 and table_name<>$2`,
      [schema, table],
    );
    for (const { table_name: other } of others) {
      const { rows: ocols } = await c.query<{ column_name: string }>(
        `select column_name from information_schema.columns where table_schema=$1 and table_name=$2 and column_name<>'_row'`,
        [schema, other],
      );
      const orel = `${q(schema)}.${q(other)}`;
      for (const { column_name: oc } of ocols) {
        const okey = await c.query(`select count(*) = count(distinct ${q(oc)}) and count(${q(oc)}) = count(*) as k from ${orel}`);
        if (!okey.rows[0]?.k) continue;
        for (const { column_name: col } of colRows) {
          if (!/(_id|_code|_key|id)$/i.test(col) && col !== oc) continue;
          const { rows } = await c.query(
            `select count(distinct a.${q(col)})::int as n, count(distinct a.${q(col)}) filter (where b.${q(oc)} is null)::int as orphans
             from ${rel} a left join ${orel} b on btrim(a.${q(col)}::text) = btrim(b.${q(oc)}::text) where a.${q(col)} is not null`,
          );
          const r = rows[0] as { n: number; orphans: number };
          if (r.n > 0 && r.orphans / r.n < 0.05) fks.push(`- \`${table}.${col}\` → \`${other}.${oc}\` (${r.n} distinct, ${r.orphans} orphan values)`);
        }
      }
    }

    out.push('## Columns', '', ...summary, '', `Candidate keys: ${keyCols.length ? keyCols.map((k) => `\`${k}\``).join(', ') : '(none — consider a composite or a surrogate id)'}`, '');
    out.push('## Candidate foreign keys', '', ...(fks.length ? fks : ['(none found in this schema)']), '');
    out.push('## Details', '', ...details);
    out.push(
      '## Next',
      '- Decide types per column from `inferred` + flags; record decisions in docs/decisions.md.',
      '- Migration: create the real table with constraints, then `insert into ... select <casts/cleanup> from staging...`.',
      '- Rows failing casts: keep them out with a WHERE and report them (by `_row`) instead of crashing the import.',
    );
    const md = out.join('\n');
    console.log(md);
    mkdirSync('data/out', { recursive: true });
    writeFileSync(`data/out/profile-${schema}.${table}.md`, md);
    console.error(`\n(report saved to data/out/profile-${schema}.${table}.md)`);
  } finally {
    await c.end();
  }
}

main().catch((e: unknown) => {
  console.error((e as Error).message);
  process.exitCode = 1;
});
