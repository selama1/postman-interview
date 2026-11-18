/**
 * One-command data recon: load every raw file into staging (lossless, same loader as data:load) and
 * print ONE compact summary of everything that would affect an import. Data-agnostic: heuristics only,
 * no knowledge of any dataset's columns or values.
 *
 *   pnpm data:recon data/raw                  (every .csv .tsv .json .ndjson .jsonl in the dir)
 *   pnpm data:recon a.csv b.json c.ndjson
 *   DATABASE_URL=... pnpm data:recon ...      (defaults to .env / compose dev DB)
 *
 * Per table (set-based SQL, one query per column + one for the key): blank/placeholder values, mixed value
 * shapes (ISO, slash dates, epoch, numbers, numbers with unit/currency), slash-date order evidence,
 * case/whitespace variants, padding, encoding damage, duplicate candidate keys. Across tables: likely
 * references with orphan counts. Writes the same markdown to data/out/recon.md. Then:
 *   pnpm data:profile staging.<table>   for the per-column detail of anything flagged here.
 *
 * Loads use --replace semantics: staging.<basename> is dropped and recreated.
 */
import { mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { LoadError, SUPPORTED_EXTENSIONS, loadFile, tableNameFor, type LoadResult } from './loader.js';
import { databaseUrl, quoteIdent as q } from './util.js';

// ---------------------------------------------------------------- patterns (Postgres regex, no single quotes)
const PLACEHOLDERS = ['n/a', 'na', 'null', 'none', 'nil', '-', '--', '?', 'unknown', 'tbd', '#n/a', 'nan', 'undefined'];
const PH = `(${PLACEHOLDERS.map((p) => `'${p}'`).join(',')})`;
const ISO = String.raw`^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2}([.,]\d+)?)?\s?(Z|[+-]\d{2}(:?\d{2})?)?)?$`;
const SLASH = String.raw`^\d{1,2}/\d{1,2}/\d{2,4}([ T].*)?$`;
const EPOCH = String.raw`^\d{9,13}$`;
const NUM = String.raw`^[-+]?(\d+(\.\d+)?|\.\d+)$`;
const FMT = [
  String.raw`^([$€£¥]|[A-Za-z]{3}\s)\s?[-+]?\d[\d,]*(\.\d+)?$`, // $1,234.50  USD 12
  String.raw`^[-+]?\d[\d,]*(\.\d+)?\s?([A-Za-z%]{1,6}|[$€£¥])(/[A-Za-z]+)?$`, // 12 kg  1,234.50 USD  5%
  String.raw`^[-+]?\d{1,3}(,\d{3})+(\.\d+)?$`, // 1,234.50
].join('|');
const MOJIBAKE = String.raw`[ÃÂ][\u0080-¿]|â€`;

const SHAPES = ['iso', 'slash', 'epoch_s', 'epoch_ms', 'number', 'formatted', 'text'] as const;
type Shape = (typeof SHAPES)[number];
const SHAPE_LABEL: Record<Shape, string> = {
  iso: 'ISO timestamp/date',
  slash: 'slash date',
  epoch_s: 'epoch seconds',
  epoch_ms: 'epoch ms',
  number: 'plain number',
  formatted: 'number with unit/currency/separators',
  text: 'other text',
};

// ---------------------------------------------------------------- types
interface FileEntry { file: string; table: string }
interface ColStat {
  name: string;
  n: number; nulls: number; empties: number; placeholders: number; padded: number;
  distinctRaw: number; distinctNorm: number; distinctReal: number; realN: number;
  replChar: number; mojibake: number; mojibakeEx: string | null;
  shape: Record<Shape, { n: number; ex: string | null }>;
  refMin: number | null; refMax: number | null;
  epYears: { epoch_s: [number | null, number | null]; epoch_ms: [number | null, number | null] };
  dm: number; md: number; amb: number; slashBad: number; slash2digit: number;
  neg: number; zero: number; negEx: string | null;
  dmEx: string | null; mdEx: string | null; slashBadEx: string | null;
}
interface TableInfo {
  table: string; file: string; load?: LoadResult; error?: LoadError;
  columns: string[]; key: string; stats: ColStat[];
  findings: string[]; decisions: Decision[];
  /** quoted staging relation, e.g. staging."orders" */
  rel: string; rows: number;
}

/** where a probe writes its lines */
interface Decision { table: string; kind: string; col: string; detail: string }
interface Sink { table: string; findings: string[]; decisions: Decision[] }

// ---------------------------------------------------------------- small helpers
const fmt = (n: number) => n.toLocaleString('en-US');
const code = (s: string | null | undefined, max = 40) => `\`${String(s ?? '').replace(/`/g, "'").replace(/\s/g, ' ').slice(0, max)}\``;
const nonblank = (x: string) => `(${x} is not null and btrim(${x}) <> '' and lower(btrim(${x})) not in ${PH})`;
const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(a === b ? 0 : 1)}%` : '0%');
const num = (r: Record<string, unknown>, k: string) => Number(r[k] ?? 0);
const str = (r: Record<string, unknown>, k: string) => (r[k] == null ? null : String(r[k]));
const isKeyName = (c: string) => /^(id|code)$|_(id|code)$/i.test(c);

class ReconError extends Error {
  constructor(message: string, readonly fix: string) {
    super(message);
  }
}

// ---------------------------------------------------------------- file discovery
function discover(args: string[]): FileEntry[] {
  const files: string[] = [];
  const exts = SUPPORTED_EXTENSIONS as readonly string[];
  for (const a of args) {
    let st;
    try {
      st = statSync(a);
    } catch {
      throw new ReconError(`${a} does not exist.`, 'Pass a directory or file paths, e.g. pnpm data:recon data/raw');
    }
    if (st.isDirectory()) {
      for (const f of readdirSync(a).sort()) if (exts.includes(path.extname(f).toLowerCase())) files.push(path.join(a, f));
    } else if (exts.includes(path.extname(a).toLowerCase())) {
      files.push(a);
    } else {
      throw new ReconError(`${a} has an unsupported extension.`, `Supported: ${SUPPORTED_EXTENSIONS.join(' ')}`);
    }
  }
  if (!files.length) throw new ReconError(`No data files found in: ${args.join(', ')}`, `Put ${SUPPORTED_EXTENSIONS.join(' ')} files there, or pass them explicitly.`);
  const entries = files.map((file) => ({ file, table: tableNameFor(file) }));
  const seen = new Map<string, string>();
  for (const e of entries) {
    const prev = seen.get(e.table);
    if (prev) throw new ReconError(`${prev} and ${e.file} both map to staging.${e.table}.`, 'Rename one file (the staging table is its basename without extension).');
    seen.set(e.table, e.file);
  }
  return entries;
}

// ---------------------------------------------------------------- per-column probe
function columnSql(rel: string, col: string): string {
  const x = q(col);
  const shapeCols = SHAPES.map((s) => `count(*) filter (where shape = '${s}')::int as c_${s}, min(v) filter (where shape = '${s}') as e_${s}`).join(',\n    ');
  return `
  with s as materialized (
    select ${x} as raw, btrim(${x}) as v, ${nonblank(x)} as real from ${rel}
  ), t as materialized (
    select raw, v, real,
      case when not real then null
           when v ~ '${ISO}' then 'iso'
           when v ~ '${SLASH}' then 'slash'
           when v ~ '${EPOCH}' then (case when length(v) <= 11 then 'epoch_s' else 'epoch_ms' end)
           when v ~ '${NUM}' then 'number'
           when v ~ '${FMT}' then 'formatted'
           else 'text' end as shape
    from s
  ), u as (
    select *,
      case when shape = 'slash' then split_part(replace(v, 'T', ' '), ' ', 1) end as sd,
      case when shape = 'iso' then substr(v, 1, 4)::int end as iso_year,
      case shape when 'epoch_s' then extract(year from to_timestamp(v::double precision))::int
                 when 'epoch_ms' then extract(year from to_timestamp(v::double precision / 1000))::int end as ep_year
    from t
  ), w as materialized (
    select *,
      case when shape = 'number' then v::numeric end as nv,
      case when sd is not null then split_part(sd, '/', 1)::int end as p1,
      case when sd is not null then split_part(sd, '/', 2)::int end as p2,
      coalesce(iso_year, case when sd ~ '^\\d{1,2}/\\d{1,2}/\\d{4}$' then split_part(sd, '/', 3)::int end) as ref_year
    from u
  )
  select count(*)::int as n,
    count(*) filter (where raw is null)::int as nulls,
    count(*) filter (where raw is not null and btrim(raw) = '')::int as empties,
    count(*) filter (where raw is not null and btrim(raw) <> '' and not real)::int as placeholders,
    count(*) filter (where raw <> v)::int as padded,
    count(distinct raw)::int as distinct_raw,
    count(distinct lower(v))::int as distinct_norm,
    count(distinct v) filter (where real)::int as distinct_real,
    count(*) filter (where real)::int as real_n,
    count(*) filter (where raw like '%' || chr(65533) || '%')::int as repl_char,
    count(*) filter (where raw ~ '${MOJIBAKE}')::int as mojibake,
    min(raw) filter (where raw ~ '${MOJIBAKE}') as mojibake_ex,
    ${shapeCols},
    count(*) filter (where nv < 0)::int as neg, count(*) filter (where nv = 0)::int as zero,
    min(v) filter (where nv < 0) as neg_ex,
    min(ref_year) as ref_min, max(ref_year) as ref_max,
    min(ep_year) filter (where shape = 'epoch_s') as eps_min, max(ep_year) filter (where shape = 'epoch_s') as eps_max,
    min(ep_year) filter (where shape = 'epoch_ms') as epm_min, max(ep_year) filter (where shape = 'epoch_ms') as epm_max,
    count(*) filter (where p1 between 13 and 31 and p2 between 1 and 12)::int as dm,
    count(*) filter (where p2 between 13 and 31 and p1 between 1 and 12)::int as md,
    count(*) filter (where p1 between 1 and 12 and p2 between 1 and 12)::int as amb,
    count(*) filter (where sd is not null and not (p1 between 1 and 31 and p2 between 1 and 31 and (p1 <= 12 or p2 <= 12)))::int as slash_bad,
    count(*) filter (where sd ~ '^\\d{1,2}/\\d{1,2}/\\d{2}$')::int as slash2,
    min(v) filter (where p1 between 13 and 31 and p2 between 1 and 12) as dm_ex,
    min(v) filter (where p2 between 13 and 31 and p1 between 1 and 12) as md_ex,
    min(v) filter (where sd is not null and not (p1 between 1 and 31 and p2 between 1 and 31 and (p1 <= 12 or p2 <= 12))) as slash_bad_ex
  from w`;
}

async function probeColumn(pool: pg.Pool, rel: string, col: string): Promise<ColStat> {
  const { rows } = await pool.query(columnSql(rel, col));
  const r = rows[0] as Record<string, unknown>;
  const shape = Object.fromEntries(SHAPES.map((s) => [s, { n: num(r, `c_${s}`), ex: str(r, `e_${s}`) }])) as ColStat['shape'];
  const yr = (k: string) => (r[k] == null ? null : Number(r[k]));
  return {
    name: col, n: num(r, 'n'), nulls: num(r, 'nulls'), empties: num(r, 'empties'), placeholders: num(r, 'placeholders'), padded: num(r, 'padded'),
    distinctRaw: num(r, 'distinct_raw'), distinctNorm: num(r, 'distinct_norm'), distinctReal: num(r, 'distinct_real'), realN: num(r, 'real_n'),
    replChar: num(r, 'repl_char'), mojibake: num(r, 'mojibake'), mojibakeEx: str(r, 'mojibake_ex'),
    shape, refMin: yr('ref_min'), refMax: yr('ref_max'),
    epYears: { epoch_s: [yr('eps_min'), yr('eps_max')], epoch_ms: [yr('epm_min'), yr('epm_max')] },
    dm: num(r, 'dm'), md: num(r, 'md'), amb: num(r, 'amb'), slashBad: num(r, 'slash_bad'), slash2digit: num(r, 'slash2'),
    neg: num(r, 'neg'), zero: num(r, 'zero'), negEx: str(r, 'neg_ex'),
    dmEx: str(r, 'dm_ex'), mdEx: str(r, 'md_ex'), slashBadEx: str(r, 'slash_bad_ex'),
  };
}

/** Findings + decisions for one column (clean columns produce nothing). */
async function describeColumn(pool: pg.Pool, rel: string, tbl: Sink, s: ColStat): Promise<void> {
  const c = `\`${s.name}\``;
  const T = tbl.table;
  const add = (line: string) => tbl.findings.push(`- ${c}: ${line}`);
  if (s.n === 0) return;

  // blanks / placeholders
  const blank = s.empties + s.placeholders;
  if (blank + s.nulls > 0) {
    let spell = '';
    if (blank > 0) {
      const { rows } = await pool.query(
        `select ${q(s.name)} as v, count(*)::int as n from ${rel} where ${q(s.name)} is not null and (btrim(${q(s.name)}) = '' or lower(btrim(${q(s.name)})) in ${PH}) group by 1 order by 2 desc, 1 limit 6`,
      );
      spell = (rows as Array<{ v: string; n: number }>).map((r) => `'${r.v.replace(/\s/g, ' ')}'×${fmt(r.n)}`).join(', ');
    }
    const parts = [s.nulls ? `NULL×${fmt(s.nulls)}` : '', spell].filter(Boolean).join(', ');
    add(`${fmt(s.nulls + blank)} of ${fmt(s.n)} blank/placeholder (${parts})`);
    if (blank > 0) tbl.decisions.push({ table: T, kind: 'blanks', col: s.name, detail: `${s.name}(${fmt(blank)})` });
  }
  if (s.padded) add(`${fmt(s.padded)} values with leading/trailing whitespace`);
  if (s.replChar) add(`${fmt(s.replChar)} values contain U+FFFD (invalid UTF-8 in the source file; text is already damaged)`);
  if (s.mojibake) add(`${fmt(s.mojibake)} values look like mojibake (UTF-8 read as Latin-1), e.g. ${code(s.mojibakeEx)}`);

  // shapes
  const dec = (kind: string, detail: string) => tbl.decisions.push({ table: T, kind, col: s.name, detail });
  const present = SHAPES.filter((k) => s.shape[k].n > 0);
  const label = (k: Shape) => `${SHAPE_LABEL[k]} ×${fmt(s.shape[k].n)} (e.g. ${code(s.shape[k].ex)})`;
  if (present.length >= 2) {
    add(`MIXED shapes: ${present.map(label).join('; ')}`);
  } else if (present.length === 1 && (present[0] === 'epoch_s' || present[0] === 'epoch_ms' || present[0] === 'formatted')) {
    add(`all values are ${label(present[0])}`);
  }
  if (s.shape.formatted.n > 0) dec('units', `${s.name}(e.g. ${code(s.shape.formatted.ex)})`);
  const nonDate = present.filter((k) => k === 'number' || k === 'formatted' || k === 'text');
  const dateish = present.filter((k) => k !== 'number' && k !== 'formatted' && k !== 'text');
  // number + formatted is covered by the 'units' decision; anything mixed with free text needs its own
  if (nonDate.length >= 2 && nonDate.includes('text')) dec('mixed', `${s.name}(${nonDate.map((k) => SHAPE_LABEL[k]).join(' + ')})`);
  const dateParts: string[] = [];
  if (s.shape.iso.n) dateParts.push('ISO');

  // epoch decoding vs the column's own dates
  for (const k of ['epoch_s', 'epoch_ms'] as const) {
    if (!s.shape[k].n) continue;
    const [lo, hi] = s.epYears[k];
    const ex = Number(s.shape[k].ex);
    const decoded = Number.isFinite(ex) ? new Date(k === 'epoch_s' ? ex * 1000 : ex).toISOString().slice(0, 10) : '?';
    let cmp: string;
    let verdict: string;
    if (s.refMin != null && s.refMax != null && lo != null && hi != null) {
      const ok = lo >= s.refMin - 1 && hi <= s.refMax + 1;
      cmp = `date values in this column span ${s.refMin}–${s.refMax}: ${ok ? 'same range' : 'OUTSIDE that range, so the unit may be wrong'}`;
      verdict = ok ? 'in range' : 'OUT OF RANGE';
    } else {
      cmp = 'no ISO/slash dates in this column to compare';
      verdict = 'no reference range';
    }
    add(`${SHAPE_LABEL[k]} ×${fmt(s.shape[k].n)}: ${code(s.shape[k].ex)} → ${decoded}; decoded years ${lo}–${hi}; ${cmp}`);
    dateParts.push(`${k === 'epoch_s' ? 'epoch s' : 'epoch ms'} (${verdict})`);
  }

  // slash date order
  const slashN = s.shape.slash.n;
  if (slashN > 0) {
    let verdict: string;
    let part: string;
    if (s.dm > 0 && s.md === 0) {
      verdict = `D/M proven: ${fmt(s.dm)} values only fit D/M (e.g. ${code(s.dmEx)}), 0 fit M/D; ${fmt(s.amb)} ambiguous values then read D/M`;
      part = 'D/M (proven)';
    } else if (s.md > 0 && s.dm === 0) {
      verdict = `M/D proven: ${fmt(s.md)} values only fit M/D (e.g. ${code(s.mdEx)}), 0 fit D/M; ${fmt(s.amb)} ambiguous values then read M/D`;
      part = 'M/D (proven)';
    } else if (s.dm > 0 && s.md > 0) {
      verdict = `CONFLICT: ${fmt(s.dm)} values only fit D/M (e.g. ${code(s.dmEx)}) and ${fmt(s.md)} only fit M/D (e.g. ${code(s.mdEx)}): mixed orders in one column, ask`;
      part = 'slash with BOTH orders (ASK)';
    } else {
      verdict = `ambiguous: ask. ${fmt(s.amb)} slash dates, none with a part > 12`;
      part = 'slash AMBIGUOUS (ASK D/M vs M/D)';
    }
    if (s.slashBad) verdict += `; ${fmt(s.slashBad)} impossible (e.g. ${code(s.slashBadEx)})`;
    if (s.slash2digit) verdict += `; ${fmt(s.slash2digit)} have 2-digit years`;
    add(`slash-date order → ${verdict}`);
    dateParts.splice(s.shape.iso.n ? 1 : 0, 0, part);
  }
  if (dateish.length > 1 || s.shape.slash.n || s.shape.epoch_s.n || s.shape.epoch_ms.n) dec('dates', dateParts.join(' + '));

  // negatives / zeros in numeric columns (plain numbers are the majority)
  if (s.shape.number.n > 0 && s.shape.number.n * 2 >= s.realN && (s.neg > 0 || s.zero > 0)) {
    const bits = [s.neg ? `negatives ×${fmt(s.neg)} (e.g. ${code(s.negEx)})` : '', s.zero ? `zeros ×${fmt(s.zero)}` : ''].filter(Boolean);
    add(`numeric column has ${bits.join(', ')}`);
    dec('numeric', `${s.name}(${[s.neg ? `${fmt(s.neg)} neg` : '', s.zero ? `${fmt(s.zero)} zero` : ''].filter(Boolean).join(', ')})`);
  }

  // case/whitespace variants (low-cardinality text only)
  if (s.distinctRaw <= 50 && s.distinctNorm < s.distinctRaw) {
    const { rows } = await pool.query(`select ${q(s.name)} as v, count(*)::int as n from ${rel} where ${q(s.name)} is not null group by 1`);
    const groups = new Map<string, Array<{ v: string; n: number }>>();
    for (const r of rows as Array<{ v: string; n: number }>) {
      const k = r.v.trim().toLowerCase();
      groups.set(k, [...(groups.get(k) ?? []), r]);
    }
    const collapsing = [...groups.values()].filter((g) => g.length > 1);
    const shown = collapsing
      .slice(0, 6)
      .map((g) => g.sort((a, b) => b.n - a.n).map((r) => `'${r.v}'×${fmt(r.n)}`).join(' / '))
      .join('; ');
    add(`${collapsing.length} value(s) collapse under lower(btrim()): ${shown}${collapsing.length > 6 ? `; +${collapsing.length - 6} more` : ''}`);
    dec('text', `${collapsing.length} case/space variant groups`);
  } else if (s.distinctRaw > 50 && s.distinctNorm < s.distinctRaw) {
    // high-cardinality: raw values that differ from another row's value only by case/whitespace
    const { rows } = await pool.query(
      `select vs, count(*) over()::int as groups, (sum(cardinality(vs)) over())::int as vals from (
         select array_agg(distinct ${q(s.name)} order by ${q(s.name)}) as vs from ${rel}
         where ${nonblank(q(s.name))} group by lower(btrim(${q(s.name)})) having count(distinct ${q(s.name)}) > 1) g
       order by vs limit 2`,
    );
    const r = rows as Array<{ vs: string[]; groups: number; vals: number }>;
    if (r.length) {
      add(`${fmt(r[0]!.vals)} values collide case-insensitively (${fmt(r[0]!.groups)} groups; raw spellings differ), e.g. ${r.map((x) => x.vs.slice(0, 3).map((v) => code(v)).join(' / ')).join('; ')}`);
      dec('text', `${fmt(r[0]!.vals)} case-colliding values`);
    }
  }
  if (s.padded) dec('text', `${fmt(s.padded)} padded`);
}

// ---------------------------------------------------------------- candidate key + duplicates
async function describeKey(pool: pg.Pool, rel: string, tbl: Sink & Pick<TableInfo, 'key' | 'columns' | 'stats'>): Promise<void> {
  const k = q(tbl.key);
  const kStat = tbl.stats.find((s) => s.name === tbl.key)!;
  const others = tbl.columns.filter((c) => c !== tbl.key);
  const rowHash = others.length ? `md5(row(${others.map((c) => `coalesce(${q(c)}, chr(1))`).join(', ')})::text)` : `md5('')`;
  const { rows } = await pool.query(`
    with kk as (select btrim(${k}) as k from ${rel} where ${nonblank(k)}),
    d as (select k from kk group by k having count(*) > 1),
    g as (
      select btrim(${k}) as k, count(*)::int as n, count(distinct ${rowHash})::int as dh
        ${others.map((c, i) => `, count(distinct coalesce(${q(c)}, chr(1)))::int as d${i}`).join('')}
      from ${rel} where btrim(${k}) in (select k from d) group by 1
    )
    select (select count(distinct k)::int from kk) as keys, (select count(distinct lower(k))::int from kk) as keys_norm,
      count(*) filter (where n > 1)::int as dup_keys,
      coalesce(sum(n) filter (where n > 1), 0)::int as dup_rows,
      count(*) filter (where n > 1 and dh = 1)::int as identical,
      count(*) filter (where n > 1 and dh > 1)::int as conflicting,
      (array_agg(k order by n desc, k) filter (where n > 1 and dh = 1))[1:2] as identical_ex,
      (array_agg(k order by n desc, k) filter (where n > 1 and dh > 1))[1:2] as conflicting_ex
      ${others.map((_, i) => `, count(*) filter (where n > 1 and dh > 1 and d${i} > 1)::int as diff${i}`).join('')}
    from g`);
  const r = rows[0] as Record<string, unknown>;
  const dupKeys = num(r, 'dup_keys');
  const keyBlank = kStat.nulls + kStat.empties + kStat.placeholders;
  const head = `- key \`${tbl.key}\` (candidate: ${isKeyName(tbl.key) ? 'by name' : 'first column'}): ${fmt(num(r, 'keys'))} distinct`;
  const extra = [keyBlank ? `${fmt(keyBlank)} rows with a blank key` : ''];
  if (dupKeys === 0) {
    tbl.findings.push(`${head}, no duplicates${extra[0] ? `; ${extra[0]}` : ''}`);
  } else {
    const identical = num(r, 'identical');
    const conflicting = num(r, 'conflicting');
    const differs = others
      .map((c, i) => ({ c, n: num(r, `diff${i}`) }))
      .filter((d) => d.n > 0)
      .sort((a, b) => b.n - a.n)
      .slice(0, 5)
      .map((d) => `${d.c}×${fmt(d.n)}`);
    const exs = (v: unknown) => ((v as string[] | null) ?? []).map((e) => code(e)).join(', ');
    const parts = [
      `${fmt(dupKeys)} duplicated key values over ${fmt(num(r, 'dup_rows'))} rows`,
      `${fmt(identical)} groups IDENTICAL on every other column${identical ? ` (e.g. ${exs(r.identical_ex)})` : ''}`,
      `${fmt(conflicting)} CONFLICTING${conflicting ? ` (e.g. ${exs(r.conflicting_ex)}; differing columns: ${differs.join(', ') || 'n/a'})` : ''}`,
    ];
    const normExtra = num(r, 'keys') - num(r, 'keys_norm');
    if (normExtra > 0) parts.push(`${fmt(normExtra)} more key values collide only under case/whitespace`);
    if (extra[0]) parts.push(extra[0]);
    tbl.findings.push(`${head}; ${parts.join('; ')}`);
    tbl.decisions.push({
      table: tbl.table, kind: 'dupes', col: tbl.key,
      detail: `${tbl.key}: ${[identical ? `${fmt(identical)} identical groups → collapse` : '', conflicting ? `${fmt(conflicting)} conflicting groups → which row wins (first/last/newest), or reject` : ''].filter(Boolean).join('; ')}`,
    });
  }
  if (dupKeys === 0 && num(r, 'keys_norm') < num(r, 'keys')) {
    tbl.findings.push(`- key \`${tbl.key}\`: ${fmt(num(r, 'keys') - num(r, 'keys_norm'))} key values collide only under case/whitespace`);
  }
  if (keyBlank) tbl.decisions.push({ table: tbl.table, kind: 'blankkey', col: tbl.key, detail: `${tbl.key}(${fmt(keyBlank)} rows) → reject?` });
}

// ---------------------------------------------------------------- cross-table references
const STOP = new Set(['id', 'code', 'key', 'no', 'num', 'number', 'ref', 'uuid']);
const stem = (t: string) => (t.length > 3 && t.endsWith('s') ? t.slice(0, -1) : t);
const tokens = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map(stem);
const isGenericName = (c: string) => tokens(c).every((t) => STOP.has(t));

/** Does the column name point at table T's key? Required when T's key is numeric (small ints match everything). */
function nameAffinity(col: string, T: TableInfo): boolean {
  if (col === T.key) return true;
  const kt = tokens(T.key).filter((t) => !STOP.has(t));
  const stems = kt.length ? kt : tokens(T.table).filter((t) => !STOP.has(t));
  const ct = new Set(tokens(col));
  return stems.some((t) => t.length >= 3 && ct.has(t));
}

/** The column is named like the target's key (same non-generic key name, or <singular|plural>_id / _code): report it whatever the overlap. */
function namedAfter(col: string, T: TableInfo): boolean {
  if (col === T.key && !isGenericName(T.key)) return true;
  const singular = T.table.replace(/s$/, '');
  return [singular, T.table].some((n) => col === `${n}_id` || col === `${n}_code`);
}

interface RefCandidate { from: TableInfo; col: string; to: TableInfo; nd: number; m: number; affinity: boolean; named: boolean }

async function findReferences(pool: pg.Pool, tables: TableInfo[]): Promise<string[]> {
  const usable = tables.filter((t) => t.load && t.rows > 0);
  const targets = usable.filter((t) => {
    const ks = t.stats.find((s) => s.name === t.key);
    return ks && ks.distinctReal >= 2 && ks.distinctReal / Math.max(ks.realN, 1) >= 0.5;
  });
  const cands: RefCandidate[] = [];
  await Promise.all(
    targets.flatMap((T) =>
      usable
        .filter((O) => O !== T)
        .map(async (O) => {
          const cols = O.stats.filter((s) => s.name !== '_row' && (s.distinctReal >= 2 || namedAfter(s.name, T)) && !(s.name === O.key && isGenericName(s.name) && isGenericName(T.key)));
          if (!cols.length) return;
          const sql = `
            with ks as (select distinct btrim(${q(T.key)}) as k from ${T.rel} where ${nonblank(q(T.key))})
            ${cols
              .map(
                (s) => `select '${s.name.replace(/'/g, "''")}' as c, count(distinct x.v)::int as nd, count(distinct x.v) filter (where ks.k is not null)::int as m
                 from (select btrim(${q(s.name)}) as v from ${O.rel} where ${nonblank(q(s.name))}) x left join ks on ks.k = x.v`,
              )
              .join('\nunion all\n')}`;
          const { rows } = await pool.query(sql);
          for (const r of rows as Array<{ c: string; nd: number; m: number }>) {
            const named = namedAfter(r.c, T);
            if (r.nd > 0 && (named || r.m / r.nd >= 0.8)) cands.push({ from: O, col: r.c, to: T, nd: r.nd, m: r.m, affinity: nameAffinity(r.c, T), named });
          }
        }),
    ),
  );
  // numeric keys: require a name pointing at the table (otherwise any small-int column "references" it)
  const numericKey = (T: TableInfo) => {
    const ks = T.stats.find((s) => s.name === T.key)!;
    return ks.realN > 0 && (ks.shape.number.n + ks.shape.epoch_s.n + ks.shape.epoch_ms.n) / ks.realN >= 0.98;
  };
  const kept = cands.filter((c) => c.named || c.affinity || !numericKey(c.to));
  // one best target per referencing column
  const best = new Map<string, RefCandidate>();
  const rank = (x: RefCandidate) => [x.named ? 1 : 0, x.m / x.nd, x.affinity ? 1 : 0, x.to.stats.find((s) => s.name === x.to.key)!.distinctReal] as const;
  const better = (a: RefCandidate, b: RefCandidate) => {
    const [ra, rb] = [rank(a), rank(b)];
    for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i]! > rb[i]!;
    return false;
  };
  for (const c of kept) {
    const id = `${c.from.table}.${c.col}`;
    const cur = best.get(id);
    if (!cur || better(c, cur)) best.set(id, c);
  }
  const lines: string[] = [];
  for (const c of [...best.values()].sort((a, b) => a.from.table.localeCompare(b.from.table) || a.col.localeCompare(b.col))) {
    const T = c.to;
    const dcols = T.columns.filter((d) => d !== '_row');
    const sql = `
      with ks as (select distinct btrim(${q(T.key)}) as k from ${T.rel} where ${nonblank(q(T.key))}),
      o as (select btrim(${q(c.col)}) as v from ${c.from.rel} where ${nonblank(q(c.col))} and not exists (select 1 from ks where ks.k = btrim(${q(c.col)})))
      select '#total' as d, count(*)::int as rows, count(distinct v)::int as dv, null::text as ex, 0 as amb from o
      union all select '#top', 0, 0, (select string_agg(v, chr(31)) from (select v from o group by v order by count(*) desc, v limit 3) z), 0
      ${dcols
        .map(
          (d) => `union all select '${d.replace(/'/g, "''")}', count(*)::int, count(distinct o.v)::int, min(o.v), count(*) filter (where dd.c > 1)::int
            from o join (select lower(btrim(${q(d)})) as l, count(*)::int as c from ${T.rel} where ${nonblank(q(d))} group by 1) dd on lower(o.v) = dd.l`,
        )
        .join('\n')}`;
    const { rows } = await pool.query(sql);
    const byD = new Map((rows as Array<{ d: string; rows: number; dv: number; ex: string | null; amb: number }>).map((r) => [r.d, r]));
    const total = byD.get('#total')!;
    const top = (byD.get('#top')?.ex ?? '').split('\u001f').filter(Boolean);
    const ref = `\`${c.from.table}.${c.col}\` → \`${T.table}.${T.key}\``;
    const head = `${fmt(c.nd)} distinct values, ${pct(c.m, c.nd)} match${c.named && c.m / c.nd < 0.8 ? ' (reported by column name despite <80% overlap)' : ''}`;
    if (total.rows === 0) {
      lines.push(`- ${ref}: ${head}, 0 orphans`);
      continue;
    }
    lines.push(`- ${ref}: ${head}; orphans: ${fmt(total.rows)} rows / ${fmt(total.dv)} values, e.g. ${top.map((v) => code(v)).join(', ')}`);
    c.from.decisions.push({ table: c.from.table, kind: 'orphans', col: c.col, detail: `${c.col}→${T.table}.${T.key}(${fmt(total.rows)} rows)` });
    for (const d of dcols) {
      const r = byD.get(d);
      if (!r || r.rows === 0) continue;
      const same = d === T.key;
      lines.push(
        `  - ${fmt(r.rows)} orphan rows (${fmt(r.dv)} values, e.g. ${code(r.ex)}) equal \`${T.table}.${d}\` case-insensitively` +
          (same ? ' (case/whitespace variants of the key)' : ` (${T.table}.${d} used instead of ${T.key})`) +
          (r.amb ? `; ${fmt(r.amb)} rows hit a ${d} shared by several ${T.table} rows` : ''),
      );
      c.from.decisions.push({
        table: c.from.table, kind: 'names', col: c.col,
        detail: same ? `${c.col}(${fmt(r.rows)} differ from ${T.key} only by case/space)` : `${c.col}(${fmt(r.rows)} are ${T.table}.${d}${r.amb ? ', NOT unique' : ''})`,
      });
    }
  }
  return lines;
}

// ---------------------------------------------------------------- decisions (one line per finding kind per table)
const DECISION_TEXT: Record<string, { label: string; ask: string }> = {
  dupes: { label: 'duplicate keys', ask: '' },
  blankkey: { label: 'blank key', ask: '' },
  dates: { label: 'dates', ask: '→ normalise to timestamptz UTC' },
  units: { label: 'units/currency/separators', ask: '→ strip; which unit/currency is assumed?' },
  mixed: { label: 'mixed number/text', ask: '→ normalise to one type; which wins on conflict?' },
  numeric: { label: 'negative/zero numbers', ask: '→ valid, reject, or NULL?' },
  blanks: { label: 'blanks', ask: '→ NULL?' },
  text: { label: 'text hygiene', ask: '→ trim; canonical spelling/lowercase; is a case-collision one entity or two?' },
  orphans: { label: 'orphans', ask: '→ reject rows, insert placeholder parents, or NULL them?' },
  names: { label: 'names used as codes', ask: '→ map via the name column, or reject?' },
};

/** Kinds that share one output line per table (related rulings read better together). */
const LINE_GROUPS = [['dupes', 'blankkey'], ['dates'], ['units', 'mixed', 'numeric'], ['blanks', 'text'], ['orphans', 'names']];

function renderDecisions(tables: TableInfo[]): string[] {
  const lines: string[] = [];
  const clause = (kind: string, ds: Decision[]): string => {
    const { label, ask } = DECISION_TEXT[kind]!;
    if (kind === 'text') {
      const byCol = new Map<string, string[]>();
      for (const d of ds) byCol.set(d.col, [...(byCol.get(d.col) ?? []), d.detail]);
      return `${label}: ${[...byCol].map(([c, f]) => `${c}(${f.join(', ')})`).join(', ')} ${ask}`;
    }
    return `${label}: ${ds.map((d) => d.detail).join(', ')}${ask ? ` ${ask}` : ''}`;
  };
  for (const t of tables) {
    for (const group of LINE_GROUPS) {
      if (group[0] === 'dates') {
        // columns with the same date mix share one line
        const byDetail = new Map<string, string[]>();
        for (const d of t.decisions.filter((x) => x.kind === 'dates')) byDetail.set(d.detail, [...(byDetail.get(d.detail) ?? []), d.col]);
        for (const [detail, cols] of byDetail) lines.push(`${t.table} ${DECISION_TEXT.dates!.label} ${cols.join('/')}: ${detail} ${DECISION_TEXT.dates!.ask}`);
        continue;
      }
      const parts = group.map((k) => ({ k, ds: t.decisions.filter((d) => d.kind === k) })).filter((x) => x.ds.length);
      if (parts.length) lines.push(`${t.table} ${parts.map((x) => clause(x.k, x.ds)).join('; ')}`);
    }
  }
  return lines;
}

// ---------------------------------------------------------------- main
async function recon(args: string[]): Promise<number> {
  const t0 = Date.now();
  const entries = discover(args);
  const pool = new pg.Pool({ connectionString: databaseUrl(), max: 4 });
  pool.on('error', () => {});
  try {
    try {
      await pool.query('select 1');
    } catch (err) {
      const e = err as Error & { code?: string };
      const where = (() => { try { const u = new URL(databaseUrl()); return `${u.hostname}:${u.port || 5432}`; } catch { return 'DATABASE_URL'; } })();
      throw new ReconError(`cannot reach Postgres at ${where}: ${e.message || e.code}`, 'start it with `pnpm db:up`, or set DATABASE_URL to a reachable database.');
    }

    // 1. load every file (lossless, --replace). Create the schema once: concurrent `create schema if not exists` races.
    await pool.query('create schema if not exists staging');
    const tables: TableInfo[] = entries.map((e) => ({
      table: e.table, file: e.file, columns: [], key: '', stats: [], findings: [], decisions: [], rel: `staging.${q(e.table)}`, rows: 0,
    }));
    await Promise.all(
      tables.map(async (t) => {
        const client = await pool.connect();
        try {
          t.load = await loadFile(client, { file: t.file, table: t.table, replace: true });
          t.rows = t.load.rows;
          t.columns = t.load.columns;
        } catch (err) {
          t.error = err instanceof LoadError ? err : new LoadError(`load failed: ${(err as Error).message}`);
        } finally {
          client.release();
        }
      }),
    );
    const tLoad = Date.now() - t0;

    // 2. per-table probes
    await Promise.all(
      tables
        .filter((t) => t.load && t.rows > 0)
        .map(async (t) => {
          t.stats = await Promise.all(t.columns.map((c) => probeColumn(pool, t.rel, c)));
          t.key = t.columns.find(isKeyName) ?? t.columns[0]!;
          // one scratch sink per column so finding order stays stable while the extra queries run in parallel
          const sink = () => ({ table: t.table, findings: [] as string[], decisions: [] as Decision[] });
          const per = await Promise.all(
            t.stats.map(async (s) => {
              const p = sink();
              await describeColumn(pool, t.rel, p, s);
              return p;
            }),
          );
          const keyScratch = { ...sink(), key: t.key, columns: t.columns, stats: t.stats };
          await describeKey(pool, t.rel, keyScratch);
          t.findings.push(...keyScratch.findings, ...per.flatMap((p) => p.findings));
          t.decisions.push(...keyScratch.decisions, ...per.flatMap((p) => p.decisions));
        }),
    );

    // 3. cross-table
    const refLines = await findReferences(pool, tables);

    // 4. render
    const out: string[] = [];
    const totalRows = tables.reduce((a, t) => a + t.rows, 0);
    out.push('# Data recon', '', '## Files', '', `_${tables.length} files, ${fmt(totalRows)} rows staged in ${(tLoad / 1000).toFixed(1)} s; recon total ${((Date.now() - t0) / 1000).toFixed(1)} s_`, '');
    out.push('| table | file | rows | columns | load ms | notes |', '|---|---|---:|---:|---:|---|');
    for (const t of tables) {
      if (t.error) {
        out.push(`| \`${t.table}\` | ${path.basename(t.file)} | | | | FAILED: ${t.error.message}${t.error.fix ? ` Fix: ${t.error.fix}` : ''} |`);
        continue;
      }
      const notes = [t.load!.bom ? 'UTF-8 BOM stripped' : ''];
      const repl = t.stats.reduce((a, s) => a + s.replChar, 0);
      const moj = t.stats.reduce((a, s) => a + s.mojibake, 0);
      if (repl) notes.push(`${fmt(repl)} values with U+FFFD`);
      if (moj) notes.push(`${fmt(moj)} mojibake values`);
      if (t.rows === 0) notes.push('EMPTY');
      out.push(`| \`${t.table}\` | ${path.basename(t.file)} | ${fmt(t.rows)} | ${t.columns.length} | ${t.load!.ms} | ${notes.filter(Boolean).join('; ')} |`);
    }
    for (const t of tables) {
      if (t.error) continue;
      out.push('', `## ${t.table} — Findings`, '');
      out.push(...(t.findings.length ? t.findings : ['- none']));
    }
    out.push('', '## References', '', ...(refLines.length ? refLines : ['- none found (no column matches another table\'s candidate key at >= 80%)']));
    const decisions = renderDecisions(tables);
    out.push('', '## Decisions you will need', '', ...(decisions.length ? decisions.map((d, i) => `${i + 1}. ${d}`) : ['none: nothing in the data needs a ruling']));
    const md = out.join('\n');
    console.log(md);
    const outDir = process.env.DATA_OUT_DIR || 'data/out'; // tests point this at a temp dir
    mkdirSync(outDir, { recursive: true });
    writeFileSync(path.join(outDir, 'recon.md'), `${md}\n`);
    console.error(`\n(report saved to ${path.join(outDir, 'recon.md')})`);
    const failed = tables.filter((t) => t.error);
    for (const t of failed) console.error(`recon: ${t.file}: ${t.error!.message}${t.error!.fix ? ` Fix: ${t.error!.fix}` : ''}`);
    return failed.length ? 1 : 0;
  } finally {
    await pool.end();
  }
}

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!args.length) {
  console.error('Usage: pnpm data:recon <dir-or-files...>   (supported: ' + SUPPORTED_EXTENSIONS.join(' ') + ')');
  process.exitCode = 2;
} else {
  recon(args).then(
    (code) => { process.exitCode = code; },
    (err: unknown) => {
      if (err instanceof ReconError) console.error(`recon failed: ${err.message}\nFix: ${err.fix}`);
      else console.error(`recon failed: ${(err as Error).message}\nFix: re-run one table with pnpm data:load <file> --replace and pnpm data:profile staging.<table> to isolate it.`);
      process.exitCode = 1;
    },
  );
}
