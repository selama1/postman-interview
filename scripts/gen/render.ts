/**
 * Renderers for `pnpm gen:resource`: field spec -> source text of the migration, repo, routes,
 * test fixture and integration test. Pure string building (no I/O); the output shape is the
 * house shape of packages/service/test/fixtures/widgets.ts split into layers (CLAUDE.md §8).
 *
 * Note for editors of this file: the generated code contains backticks and `${...}`; they are
 * escaped here (\` and \${) on purpose.
 */
import { camel, pascal, singular, snake, type Field } from './spec.js';

/** How a ref target's parent row is created in generated tests. */
export interface ParentInfo {
  table: string;
  /** fixture: test/fixtures/<table>.ts exists (generated earlier) and exports insert<Parent>.
   *  fallback: table exists but has no generated fixture -> `insert ... default values` (adjust if it has required columns). */
  mode: 'fixture' | 'fallback';
}

export interface Ctx {
  plural: string;
  fields: Field[];
  parents: ParentInfo[];
  migrationFile: string;
}

export const names = (plural: string) => {
  const one = singular(plural);
  return {
    plural,
    one,
    Plural: pascal(plural),
    One: pascal(one),
    routesVar: `${camel(plural)}Routes`,
    tableType: `${pascal(plural)}Table`,
    upper: snake(one).toUpperCase(),
  };
};

const q = (s: string) => `'${s}'`;
const ind = (n: number, lines: string[]) => lines.map((l) => (l ? ' '.repeat(n) + l : l));
const join = (lines: string[]) => `${lines.join('\n')}\n`;
const INT4 = { min: -2147483648, max: 2147483647 };

// --- per-kind mappings ------------------------------------------------------------------------
const enumConst = (c: Ctx, f: Field) => `${names(c.plural).upper}_${snake(f.name).toUpperCase()}_VALUES`;
const enumType = (c: Ctx, f: Field) => `${names(c.plural).One}${pascal(f.name)}`;

function sqlType(f: Field): string {
  switch (f.kind) {
    case 'text':
    case 'enum':
      return 'text';
    case 'int':
      return 'integer';
    case 'bigint':
    case 'ref':
      return 'bigint';
    case 'numeric':
      return `numeric(${f.precision},${f.scale})`;
    case 'bool':
      return 'boolean';
    case 'date':
      return 'date';
    case 'timestamptz':
      return 'timestamptz(3)'; // llms.txt pitfall #3
  }
}

/** Plain TS type of the value as the repo/API sees it. */
function tsValueType(c: Ctx, f: Field): string {
  switch (f.kind) {
    case 'text':
    case 'numeric':
    case 'date':
    case 'timestamptz':
      return 'string';
    case 'int':
    case 'bigint':
    case 'ref':
      return 'number';
    case 'bool':
      return 'boolean';
    case 'enum':
      return enumType(c, f);
  }
}

function tableColumnType(c: Ctx, f: Field): string {
  const t = tsValueType(c, f);
  if (f.kind === 'timestamptz') {
    return f.nullable ? 'ColumnType<Date | null, Date | string | null, Date | string | null>' : 'ColumnType<Date, Date | string, Date | string>';
  }
  return f.nullable ? `${t} | null` : t;
}

function zodIn(c: Ctx, f: Field): string {
  const lo = f.positive ? 1 : f.min0 ? 0 : undefined;
  switch (f.kind) {
    case 'text':
      return `z.string().trim().min(1).max(${f.max})`;
    case 'int':
      return `z.number().int().min(${lo ?? INT4.min}).max(${INT4.max})`;
    case 'bigint':
      return `z.number().int().safe()${lo !== undefined ? `.min(${lo})` : ''}`;
    case 'numeric': {
      const intDigits = f.precision! - f.scale!;
      const sign = f.min0 || f.positive ? '' : '-?';
      const frac = f.scale! > 0 ? `(\\.\\d{1,${f.scale}})?` : '';
      const hint = `decimal string with at most ${intDigits} integer and ${f.scale} fraction digits, e.g. "12.50"`;
      const pos = f.positive ? `.refine((v) => /[1-9]/.test(v), { message: 'must be greater than 0' })` : '';
      return `z.string().regex(/^${sign}\\d{1,${intDigits}}${frac}$/, '${hint}')${pos}`;
    }
    case 'bool':
      return 'z.boolean()';
    case 'date':
      return 'z.iso.date()';
    case 'timestamptz':
      return 'z.iso.datetime({ offset: true })';
    case 'enum':
      return `z.enum(${enumConst(c, f)})`;
    case 'ref':
      return 'z.number().int().positive().safe()';
  }
}

function zodOut(c: Ctx, f: Field): string {
  switch (f.kind) {
    case 'text':
    case 'numeric':
    case 'date':
    case 'timestamptz':
      return 'z.string()';
    case 'int':
    case 'bigint':
    case 'ref':
      return 'z.number().int()';
    case 'bool':
      return 'z.boolean()';
    case 'enum':
      return `z.enum(${enumConst(c, f)})`;
  }
}

// --- 1. migration -----------------------------------------------------------------------------
export function renderMigration(c: Ctx): string {
  const t = c.plural;
  const col = (f: Field) => {
    let s = `${f.column} ${sqlType(f)}${f.nullable ? '' : ' not null'}${f.unique ? ' unique' : ''}`;
    if (f.kind === 'ref') s += ` references ${f.refTable} (id)`;
    if (f.kind === 'text') s += ` check (char_length(${f.column}) <= ${f.max})`;
    if (f.kind === 'enum') s += ` check (${f.column} in (${f.values!.map(q).join(', ')}))`;
    if (f.positive) s += ` check (${f.column} > 0)`;
    if (f.min0) s += ` check (${f.column} >= 0)`;
    return s;
  };
  const cols = [
    'id bigint generated always as identity primary key',
    ...c.fields.map(col),
    'created_at timestamptz(3) not null default now()',
    'updated_at timestamptz(3) not null default now()',
  ];
  const stmts = [`create table ${t} (`, ...ind(2, cols.map((l, i) => l + (i < cols.length - 1 ? ',' : ''))), ');'];
  stmts.push(`create index ${t}_created_idx on ${t} (created_at, id);`);
  for (const f of sortable(c)) {
    // (sort_col, id) keeps keyset pages index-ordered; skip low-cardinality types and columns that already have a UNIQUE index.
    if (f.kind !== 'bool' && f.kind !== 'enum' && !f.unique) stmts.push(`create index ${t}_${f.column}_idx on ${t} (${f.column}, id);`);
  }
  for (const f of c.fields.filter((x) => x.kind === 'ref')) stmts.push(`create index ${t}_${f.column}_idx on ${t} (${f.column});`);
  const firstText = c.fields.find((f) => f.kind === 'text');
  if (firstText) stmts.push(`create index ${t}_${firstText.column}_trgm_idx on ${t} using gin (${firstText.column} gin_trgm_ops);`); // serves ?q= (pg_trgm: baseline migration)
  stmts.push(`create trigger ${t}_updated_at before update on ${t} for each row execute function set_updated_at();`);

  return join([
    `import { sql, type Kysely } from 'kysely';`,
    '',
    '// Generated by `pnpm gen:resource`. Migrations are frozen history: never edit one that has been applied anywhere shared.',
    'export async function up(db: Kysely<any>): Promise<void> {',
    '  await sql`',
    ...ind(4, stmts),
    '  `.execute(db);',
    '}',
    '',
    'export async function down(db: Kysely<any>): Promise<void> {',
    `  await sql\`drop table ${t}\`.execute(db);`,
    '}',
  ]);
}

/** Fields the list endpoint can sort by: non-ref scalars that are NOT NULL (keyset needs NOT NULL sort columns). */
export const sortable = (c: Ctx) => c.fields.filter((f) => f.kind !== 'ref' && !f.nullable);

// --- 2. repo ----------------------------------------------------------------------------------
export function renderRepo(c: Ctx): string {
  const n = names(c.plural);
  const t = c.plural;
  const enums = c.fields.filter((f) => f.kind === 'enum');
  const hasTs = c.fields.some((f) => f.kind === 'timestamptz');
  const firstText = c.fields.find((f) => f.kind === 'text');
  const filters = c.fields.filter((f) => f.kind === 'enum' || f.kind === 'ref' || f.kind === 'bool');
  const sorts = sortable(c);

  const L: string[] = [
    '/**',
    ` * ${n.Plural} repo: SQL only (Kysely over an Executor); no HTTP types. Generated by \`pnpm gen:resource\`.`,
    ' * Routes (routes.ts) map HTTP <-> these functions; the table type is registered in db/schema.ts.',
    ' */',
    `import type { ${hasTs ? 'ColumnType, ' : ''}Generated, Selectable } from 'kysely';`,
    `import type { Executor } from '../../db/tx.js';`,
    `import { keysetPage, keysetResult } from '../../http/pagination.js';`,
    ...(firstText ? [`import { likeEscape } from '../../http/query.js';`] : []),
    '',
    ...enums.flatMap((f) => [
      `export const ${enumConst(c, f)} = [${f.values!.map(q).join(', ')}] as const;`,
      `export type ${enumType(c, f)} = (typeof ${enumConst(c, f)})[number];`,
      '',
    ]),
    `export interface ${n.tableType} {`,
    '  id: Generated<number>;',
    ...c.fields.map((f) => `  ${f.column}: ${tableColumnType(c, f)};`),
    '  created_at: Generated<Date>;',
    '  updated_at: Generated<Date>;',
    '}',
    '',
    `export type ${n.One}Row = Selectable<${n.tableType}>;`,
    '',
    '/** Domain input (camelCase). Optional-or-null fields are the nullable columns. */',
    `export interface ${n.One}Input {`,
    ...c.fields.map((f) => (f.nullable ? `  ${f.name}?: ${tsValueType(c, f)} | null;` : `  ${f.name}: ${tsValueType(c, f)};`)),
    '}',
    `export type ${n.One}Patch = Partial<${n.One}Input>;`,
    '',
    '/** API sort field -> column. Allowlist: nullable columns are excluded (keyset pagination needs NOT NULL sort columns). */',
    'export const SORTABLE = {',
    ...sorts.map((f) => `  ${f.name}: ${q(f.column)},`),
    "  createdAt: 'created_at',",
    '} as const;',
    'export type SortColumn = (typeof SORTABLE)[keyof typeof SORTABLE];',
    '',
    `export interface ${n.One}ListQuery {`,
    '  limit: number;',
    '  cursor?: string | undefined;',
    '  sort: Array<{ col: SortColumn; dir: \'asc\' | \'desc\' }>;',
    ...filters.map((f) => `  ${f.name}?: ${f.kind === 'enum' ? `${enumType(c, f)}[]` : tsValueType(c, f)} | undefined;`),
    ...(firstText ? [`  /** case-insensitive substring match on ${firstText.name} */`, '  q?: string | undefined;'] : []),
    '}',
    '',
    `export async function create(db: Executor, input: ${n.One}Input): Promise<${n.One}Row> {`,
    '  return db',
    `    .insertInto('${t}')`,
    '    .values({',
    ...c.fields.map((f) => `      ${f.column}: input.${f.name}${f.nullable ? ' ?? null' : ''},`),
    '    })',
    '    .returningAll()',
    '    .executeTakeFirstOrThrow();',
    '}',
    '',
    `export async function get(db: Executor, id: number): Promise<${n.One}Row | undefined> {`,
    `  return db.selectFrom('${t}').selectAll().where('id', '=', id).executeTakeFirst();`,
    '}',
    '',
    `export async function list(db: Executor, query: ${n.One}ListQuery) {`,
    '  const opts = { sort: query.sort.map(({ col, dir }) => ({ col, dir })), id: \'id\', limit: query.limit, cursor: query.cursor };',
    `  let qb = db.selectFrom('${t}').selectAll();`,
    ...filters.flatMap((f) =>
      f.kind === 'enum'
        ? [`  if (query.${f.name}?.length) qb = qb.where('${f.column}', 'in', query.${f.name});`]
        : [`  if (query.${f.name} !== undefined) qb = qb.where('${f.column}', '=', query.${f.name});`],
    ),
    ...(firstText ? [`  if (query.q) qb = qb.where('${firstText.column}', 'ilike', \`%\${likeEscape(query.q)}%\`);`] : []),
    '  const rows = await keysetPage(qb, opts).execute();',
    '  return keysetResult(rows, opts, (r) => [...query.sort.map((s) => r[s.col]), r.id]);',
    '}',
    '',
    `export async function update(db: Executor, id: number, patch: ${n.One}Patch): Promise<${n.One}Row | undefined> {`,
    '  const set = {',
    ...c.fields.map((f) => `    ...(patch.${f.name} !== undefined ? { ${f.column}: patch.${f.name} } : {}),`),
    '  };',
    '  if (Object.keys(set).length === 0) return get(db, id);',
    `  return db.updateTable('${t}').set(set).where('id', '=', id).returningAll().executeTakeFirst();`,
    '}',
    '',
    'export async function remove(db: Executor, id: number): Promise<boolean> {',
    `  const r = await db.deleteFrom('${t}').where('id', '=', id).executeTakeFirst();`,
    '  return r.numDeletedRows > 0n;',
    '}',
  ];
  return join(L);
}

// --- 3. routes --------------------------------------------------------------------------------
export function renderRoutes(c: Ctx): string {
  const n = names(c.plural);
  const t = c.plural;
  const enums = c.fields.filter((f) => f.kind === 'enum');
  const firstText = c.fields.find((f) => f.kind === 'text');
  const filters = c.fields.filter((f) => f.kind === 'enum' || f.kind === 'ref' || f.kind === 'bool');
  const fieldNames = c.fields.map((f) => f.name).join(', ');
  const repoImports = ['SORTABLE', `type ${n.One}Row`, 'type SortColumn', ...enums.map((f) => enumConst(c, f))];

  const L: string[] = [
    '/**',
    ` * ${n.Plural} routes: HTTP only (zod schemas, status codes, Location); SQL lives in repo.ts.`,
    ' * Generated by `pnpm gen:resource`. Always `req.db` (test-mode aware), never `app.db`.',
    ' * FK / UNIQUE / CHECK violations are mapped centrally (409 / 409 / 422): no pre-checks here.',
    ' */',
    `import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';`,
    `import { z } from 'zod';`,
    `import { badRequest, notFound } from '../../http/errors.js';`,
    `import { KeysetQuery, pageSchema } from '../../http/pagination.js';`,
    `import { ${filters.some((f) => f.kind === 'enum') ? 'csvList, ' : ''}parseSort } from '../../http/query.js';`,
    `import * as repo from './repo.js';`,
    `import { ${repoImports.join(', ')} } from './repo.js';`,
    '',
    `export const ${n.One}Input = z.object({`,
    ...c.fields.map((f) => `  ${f.name}: ${zodIn(c, f)}${f.nullable ? '.nullish()' : ''},`),
    '});',
    `export const ${n.One}Patch = ${n.One}Input.partial().refine((p) => Object.keys(p).length > 0, { message: 'provide at least one field' });`,
    `export const ${n.One} = z.object({`,
    '  id: z.number().int(),',
    ...c.fields.map((f) => `  ${f.name}: ${zodOut(c, f)}${f.nullable ? '.nullable()' : ''},`),
    '  createdAt: z.string(),',
    '  updatedAt: z.string(),',
    '});',
    `export type ${n.One} = z.infer<typeof ${n.One}>;`,
    '',
    `const toDto = (r: ${n.One}Row): ${n.One} => ({`,
    '  id: r.id,',
    ...c.fields.map((f) => {
      const v = `r.${f.column}`;
      if (f.kind !== 'timestamptz') return `  ${f.name}: ${v},`;
      return f.nullable ? `  ${f.name}: ${v} === null ? null : new Date(${v}).toISOString(),` : `  ${f.name}: new Date(${v}).toISOString(),`;
    }),
    '  createdAt: r.created_at.toISOString(),',
    '  updatedAt: r.updated_at.toISOString(),',
    '});',
    '',
    'const IdParams = z.object({ id: z.coerce.number().int().positive() });',
    '',
    `export const ${n.routesVar}: FastifyPluginAsyncZod = async (app) => {`,
    `  app.post('/', { schema: { tags: ['${t}'], body: ${n.One}Input, response: { 201: ${n.One} } } }, async (req, reply) => {`,
    '    const row = await repo.create(req.db, req.body);',
    "    return reply.code(201).header('location', `${req.url.replace(/\\/$/, '')}/${row.id}`).send(toDto(row));",
    '  });',
    '',
    '  app.get(',
    "    '/',",
    '    {',
    '      schema: {',
    `        tags: ['${t}'],`,
    '        querystring: KeysetQuery.extend({',
    ...filters.map((f) => {
      const z =
        f.kind === 'enum'
          ? `csvList().pipe(z.array(z.enum(${enumConst(c, f)}))).optional()`
          : f.kind === 'ref'
            ? 'z.coerce.number().int().positive().optional()'
            : "z.enum(['true', 'false']).transform((v) => v === 'true').optional()";
      return `          ${f.name}: ${z},`;
    }),
    ...(firstText ? [`          q: z.string().min(1).max(100).optional(), // substring of ${firstText.name}`] : []),
    '          sort: z.string().optional(),',
    '        }),',
    `        response: { 200: pageSchema(${n.One}) },`,
    '      },',
    '    },',
    '    async (req) => {',
    '      const { sort: rawSort, ...rest } = req.query;',
    '      // parseSort enforces the SORTABLE allowlist, so every col is a SortColumn.',
    "      const sort = parseSort(rawSort, SORTABLE, 'createdAt').map(({ col, dir }) => ({ col: col as SortColumn, dir }));",
    '      const page = await repo.list(req.db, { ...rest, sort });',
    '      return { items: page.items.map(toDto), nextCursor: page.nextCursor };',
    '    },',
    '  );',
    '',
    `  app.get('/:id', { schema: { tags: ['${t}'], params: IdParams, response: { 200: ${n.One} } } }, async (req) => {`,
    '    const row = await repo.get(req.db, req.params.id);',
    `    if (!row) throw notFound('${n.one}', req.params.id, 'List ${t} with GET /${t} to find a valid id.');`,
    '    return toDto(row);',
    '  });',
    '',
    `  app.patch('/:id', { schema: { tags: ['${t}'], params: IdParams, body: ${n.One}Patch, response: { 200: ${n.One} } } }, async (req) => {`,
    '    if (Object.values(req.body).every((v) => v === undefined)) {',
    `      throw badRequest('EMPTY_PATCH', 'no fields to update', 'Send at least one of ${fieldNames}.');`,
    '    }',
    '    const row = await repo.update(req.db, req.params.id, req.body);',
    `    if (!row) throw notFound('${n.one}', req.params.id, 'List ${t} with GET /${t} to find a valid id.');`,
    '    return toDto(row);',
    '  });',
    '',
    `  app.delete('/:id', { schema: { tags: ['${t}'], params: IdParams } }, async (req, reply) => {`,
    '    if (!(await repo.remove(req.db, req.params.id))) {',
    `      throw notFound('${n.one}', req.params.id, 'List ${t} with GET /${t} to find a valid id.');`,
    '    }',
    '    return reply.code(204).send();',
    '  });',
    '};',
  ];
  return join(L);
}

// --- sample values (tests + fixtures) ---------------------------------------------------------
const word = (f: Field, base: string, i: string) => {
  const e = `${q(base)} + ${i}`;
  return f.max! < 12 ? `(${e}).slice(-${f.max})` : e;
};
const frac = (f: Field, lead: string) => (f.scale! > 0 ? `${lead}${'0'.repeat(f.scale! - 1)}` : '');

/** TS expression for a valid value of field f, distinct per `i` (unique fields stay unique for i up to ~23). */
export function makeExpr(c: Ctx, f: Field, i: string, refExpr: (f: Field) => string): string {
  switch (f.kind) {
    case 'text':
      return word(f, f.name.toLowerCase().slice(0, 8), i);
    case 'int':
    case 'bigint':
      return f.unique ? `${i} + 1` : `(${i} % 7) + 1`;
    case 'numeric':
      return `String(${f.unique ? `${i} + 1` : `(${i} % 9) + 1`})${f.scale! > 0 ? ` + '.${frac(f, '5')}'` : ''}`;
    case 'bool':
      return `${i} % 2 === 0`;
    case 'date':
      return `new Date(Date.UTC(2026, 0, 1 + ${i})).toISOString().slice(0, 10)`;
    case 'timestamptz':
      return `new Date(Date.UTC(2026, 0, 1, 0, ${i})).toISOString()`;
    case 'enum':
      return `[${f.values!.map(q).join(', ')}][${i} % ${f.values!.length}]`;
    case 'ref':
      return refExpr(f);
  }
}

/** A valid value that differs from makeExpr's (PATCH tests). Not defined for ref. */
function patchExpr(f: Field, i: string): string | undefined {
  switch (f.kind) {
    case 'text':
      return word(f, 'patched', i);
    case 'int':
    case 'bigint':
      return `100 + ${i}`;
    case 'numeric':
      return `'7${f.scale! > 0 ? `.7${'5'.repeat(Math.max(0, f.scale! - 1))}` : ''}'`;
    case 'bool':
      return `${i} % 2 !== 0`;
    case 'date':
      return "'2031-02-03'";
    case 'timestamptz':
      return "'2031-02-03T04:05:06.000Z'";
    case 'enum':
      return `[${f.values!.map(q).join(', ')}][(${i} + 1) % ${f.values!.length}]`;
    case 'ref':
      return undefined;
  }
}

// --- parents (ref targets) --------------------------------------------------------------------
const insertName = (table: string) => `insert${pascal(singular(table))}`;
const parentRefs = (c: Ctx) => [...new Set(c.fields.filter((f) => f.kind === 'ref').map((f) => f.refTable!))];
const fallbackDecl = (table: string) => [
  `// TODO: "${table}" has no generated fixture; this assumes every column has a default. Add required columns if it has some.`,
  `const ${insertName(table)} = async (db: FreshDb, _i = 1): Promise<number> =>`,
  `  Number((await db.query<{ id: number }>('insert into ${table} default values returning id'))[0]!.id);`,
];
const parentImports = (c: Ctx) => c.parents.filter((p) => p.mode === 'fixture').map((p) => `import { ${insertName(p.table)} } from './${p.table}.js';`);
const modeOf = (c: Ctx, table: string) => c.parents.find((p) => p.table === table)?.mode ?? 'fallback';

// --- 4. test fixture --------------------------------------------------------------------------
export function renderFixture(c: Ctx): string {
  const n = names(c.plural);
  const refs = parentRefs(c);
  const nonNullRefs = (f: Field) => f.kind === 'ref' && !f.nullable;
  const params = c.fields.map((f) => (f.kind === 'ref' ? (f.nullable ? 'null' : `${camel(f.refTable!)}Id`) : makeExpr(c, f, 'i', () => 'null')));
  const cols = c.fields.map((f) => f.column);
  const L: string[] = [
    '/**',
    ` * Test fixture generated by \`pnpm gen:resource\`: inserts one valid ${n.one} row (and the parents it needs) with raw SQL.`,
    ` * Other resources' tests that reference ${c.plural} import ${insertName(c.plural)}; call it with a distinct \`i\` per row.`,
    ' */',
    `import type { FreshDb } from '../harness/fresh-db.js';`,
    ...parentImports(c).map((l) => l),
    '',
    ...refs.filter((r) => modeOf(c, r) === 'fallback').flatMap((r) => [...fallbackDecl(r), '']),
    `export async function ${insertName(c.plural)}(db: FreshDb, i = 1): Promise<number> {`,
    ...c.fields.filter(nonNullRefs).map((f) => `  const ${camel(f.refTable!)}Id = await ${insertName(f.refTable!)}(db, i);`),
    '  const rows = await db.query<{ id: number }>(',
    `    '${`insert into ${c.plural} (${cols.join(', ')}) values (${cols.map((_, k) => `$${k + 1}`).join(', ')}) returning id`}',`,
    `    [${params.join(', ')}],`,
    '  );',
    '  return Number(rows[0]!.id);',
    '}',
  ];
  // Two non-null refs to the same table would insert two parents; keep one id per table.
  return dedupeRefDecls(join(L));
}

function dedupeRefDecls(src: string): string {
  const seen = new Set<string>();
  return src
    .split('\n')
    .filter((l) => {
      const m = l.match(/^ {2}const (\w+Id) = await /);
      if (!m) return true;
      if (seen.has(m[1]!)) return false;
      seen.add(m[1]!);
      return true;
    })
    .join('\n');
}

// --- 5. integration test ----------------------------------------------------------------------
interface Case {
  name: string;
  field: string;
  value: string;
}

function invalidCases(f: Field): Case[] {
  const k = (name: string, value: string): Case => ({ name: `${name} ${f.name}`, field: f.name, value });
  switch (f.kind) {
    case 'text':
      return [k('non-string', '123'), k('empty', "''"), k('blank', "'   '"), k('over-long', `'x'.repeat(${f.max! + 1})`)];
    case 'int':
      return [
        k('string-typed', "'5'"),
        k('fractional', '1.5'),
        k('out-of-range', String(INT4.max + 1)),
        ...(f.positive ? [k('non-positive', '0')] : f.min0 ? [k('negative', '-1')] : []),
      ];
    case 'bigint':
      return [k('string-typed', "'5'"), k('fractional', '1.5'), ...(f.positive ? [k('non-positive', '0')] : f.min0 ? [k('negative', '-1')] : [])];
    case 'numeric': {
      const intDigits = f.precision! - f.scale!;
      return [
        k('non-decimal', "'abc'"),
        k('JS-number (floats are never accepted)', '1.5'),
        k('too many integer digits', `'${'9'.repeat(intDigits + 1)}'`),
        k('too many fraction digits', `'1.${'1'.repeat(f.scale! + 1)}'`),
        ...(f.positive ? [k('non-positive', `'0${f.scale! > 0 ? `.${'0'.repeat(f.scale!)}` : ''}'`)] : f.min0 ? [k('negative', `'-1${f.scale! > 0 ? `.${'0'.repeat(f.scale!)}` : ''}'`)] : []),
      ];
    }
    case 'bool':
      return [k('string-typed', "'yes'"), k('number-typed', '1')];
    case 'date':
      return [k('impossible', "'2026-13-45'"), k('wrong format', "'01/02/2026'")];
    case 'timestamptz':
      return [k('non-ISO', "'yesterday'"), k('date-only', "'2026-01-01'")];
    case 'enum':
      return [k('unknown value for', "'not_a_value'"), k('number-typed', '1')];
    case 'ref':
      return [k('non-numeric', "'abc'"), k('zero', '0'), k('negative', '-1')];
  }
}

const sortPref: Record<string, number> = { int: 0, bigint: 0, numeric: 0, date: 1, timestamptz: 1, text: 2, enum: 3, bool: 4 };

export function renderTest(c: Ctx): string {
  const n = names(c.plural);
  const path = `/${c.plural}`;
  const refs = parentRefs(c);
  const hasRefs = refs.length > 0;
  const unique = c.fields.find((f) => f.unique);
  const firstText = c.fields.find((f) => f.kind === 'text');
  const enums = c.fields.filter((f) => f.kind === 'enum');
  const bools = c.fields.filter((f) => f.kind === 'bool');
  const refFields = c.fields.filter((f) => f.kind === 'ref');
  const nullables = c.fields.filter((f) => f.nullable);
  const required = c.fields.filter((f) => !f.nullable);
  const numericNames = c.fields.filter((f) => f.kind === 'numeric').map((f) => q(f.name));
  const refExpr = (f: Field) => (f.nullable ? 'null' : '1');
  const make = (f: Field) => makeExpr(c, f, 'i', refExpr);

  // sorts: best two sortable fields (numbers/dates before text before enum/bool), then createdAt
  const sorts = [...sortable(c)].sort((a, b) => sortPref[a.kind]! - sortPref[b.kind]!).slice(0, 2);
  const sortSpecs: Array<{ sort: string; keys: Array<[string, 1 | -1]> }> = [];
  if (sorts[0]) sortSpecs.push({ sort: sorts[0].name, keys: [[sorts[0].name, 1]] });
  if (sorts[1]) sortSpecs.push({ sort: `-${sorts[1].name}${sorts[0] ? `,${sorts[0].name}` : ''}`, keys: [[sorts[1].name, -1], ...(sorts[0] ? ([[sorts[0].name, 1]] as Array<[string, 1 | -1]>) : [])] });
  else if (sorts[0]) sortSpecs.push({ sort: `-${sorts[0].name}`, keys: [[sorts[0].name, -1]] });
  sortSpecs.push({ sort: '-createdAt', keys: [['createdAt', -1]] });

  const patchFields = c.fields.filter((f) => f.kind !== 'ref').slice(0, 3);
  const patchBody = patchFields.length
    ? patchFields.map((f) => `${f.name}: ${patchExpr(f, 'i')}`).join(', ')
    : refFields.map((f) => `${f.name}: ${refExpr(f)}`).join(', ');

  const needsFixtureImports = refs.some((r) => modeOf(c, r) === 'fixture');
  const L: string[] = [
    '/**',
    ` * HTTP-level tests for ${path}, generated by \`pnpm gen:resource\` from the harness contract packs`,
    ' * (same shape as harness-widgets.test.ts). A floor, not the spec: business rules get their own',
    ' * repro-first tests. Runs against the real app + a fresh migrated Postgres per test.',
    ' */',
    `import { describe, expect, it } from 'vitest';`,
    ...(hasRefs ? [`import type { FreshDb } from '../harness/fresh-db.js';`] : []),
    `import { crudContract, paginationContract, ${unique ? 'uniqueRaceContract, ' : ''}seed, validationContract } from '../harness/packs.js';`,
    `import { useTarget } from '../harness/server.js';`,
    ...(needsFixtureImports ? refs.filter((r) => modeOf(c, r) === 'fixture').map((r) => `import { ${insertName(r)} } from '../fixtures/${r}.js';`) : []),
    '',
    `type Body = Record<string, unknown>;`,
    '',
    ...refs.filter((r) => modeOf(c, r) === 'fallback').flatMap((r) => [...fallbackDecl(r), '']),
    ...(hasRefs
      ? [
          '// Every test starts on an empty DB: parent rows must exist before the first child (ids start at 1).',
          'const server = {',
          '  setup: async (db: FreshDb) => {',
          ...refs.map((r) => `    await ${insertName(r)}(db, 1);`),
          '  },',
          '};',
          '',
        ]
      : []),
    `const make = (i: number): Body => ({`,
    ...c.fields.map((f) => `  ${f.name}: ${make(f)},`),
    '});',
    '',
  ];
  const srv = hasRefs ? ['  server,'] : [];

  L.push(
    'crudContract({',
    `  name: '${n.one}',`,
    `  path: '${path}',`,
    '  make,',
    `  patch: (i) => ({ ${patchBody} }),`,
    "  invalidId: 'abc',",
    ...srv,
    '});',
    '',
    '// Validation: every required field missing, plus one case per type / bound / enum violation.',
    'const valid = make(1);',
    'const bad = (over: Body): Body => ({ ...valid, ...over });',
    'const omit = (key: string): Body => Object.fromEntries(Object.entries(valid).filter(([k]) => k !== key));',
    'validationContract({',
    `  path: '${path}',`,
    '  valid,',
    '  cases: [',
    ...required.map((f) => `    { name: 'missing ${f.name}', body: omit('${f.name}'), field: '${f.name}' },`),
    ...c.fields.flatMap((f) => invalidCases(f).map((k) => `    { name: ${q(k.name)}, body: bad({ ${f.name}: ${k.value} }), field: '${f.name}' },`)),
    '  ],',
    ...srv,
    '});',
    '',
    '// Pagination: keyset walk with two (mixed-direction) sorts plus createdAt. Comparators mirror the SQL order;',
    '// the id tiebreaker follows the direction of the last sort key.',
    `const NUMERIC_FIELDS: string[] = [${numericNames.join(', ')}];`,
    "const val = (row: Body, f: string) => (NUMERIC_FIELDS.includes(f) ? Number(row[f]) : row[f]) as string | number | boolean;",
    'const cmp = (x: string | number | boolean, y: string | number | boolean) => (x < y ? -1 : x > y ? 1 : 0);',
    "const order = (...keys: Array<[field: string, dir: 1 | -1]>) => (a: Body, b: Body) => {",
    '  for (const [f, dir] of keys) {',
    '    const r = cmp(val(a, f), val(b, f));',
    '    if (r !== 0) return r * dir;',
    '  }',
    "  return cmp(a.id as number, b.id as number) * keys[keys.length - 1]![1];",
    '};',
    'paginationContract({',
    `  path: '${path}',`,
    '  make,',
    '  sorts: [',
    ...sortSpecs.map((s) => `    { sort: '${s.sort}', compare: order(${s.keys.map(([f, d]) => `['${f}', ${d}]`).join(', ')}) },`),
    '  ],',
    ...srv,
    '});',
    '',
  );

  if (unique) {
    L.push('uniqueRaceContract({', `  path: '${path}',`, '  make: () => make(1),', ...srv, '});', '');
  }

  // filters
  const filterTests: string[] = [];
  for (const f of enums) {
    const first = f.values![0]!;
    const two = f.values!.slice(0, 2).map(q);
    filterTests.push(
      `  it('?${f.name}= filters by one value and by a comma-separated list', async () => {`,
      `    const rows = await seed(t.client, '${path}', make, 8);`,
      `    const one = await t.client.get<{ items: Body[] }>('${path}', { ${f.name}: '${first}', limit: 200 });`,
      '    expect(one).toHaveStatus(200);',
      `    expect(one.body.items.map((r) => r.id).sort()).toEqual(rows.filter((r) => r.${f.name} === '${first}').map((r) => r.id).sort());`,
      `    const list = await t.client.get<{ items: Body[] }>('${path}', { ${f.name}: '${two.map((s) => s.slice(1, -1)).join(',')}', limit: 200 });`,
      `    expect(list.body.items.map((r) => r.id).sort()).toEqual(rows.filter((r) => [${two.join(', ')}].includes(r.${f.name} as string)).map((r) => r.id).sort());`,
      `    expect(await t.client.get('${path}', { ${f.name}: 'not_a_value' })).toBeProblem(400, 'VALIDATION_FAILED');`,
      '  });',
      '',
    );
  }
  for (const f of bools) {
    filterTests.push(
      `  it('?${f.name}=true|false filters', async () => {`,
      `    const rows = await seed(t.client, '${path}', make, 6);`,
      `    for (const want of [true, false]) {`,
      `      const res = await t.client.get<{ items: Body[] }>('${path}', { ${f.name}: String(want), limit: 200 });`,
      '      expect(res).toHaveStatus(200);',
      `      expect(res.body.items.map((r) => r.id).sort()).toEqual(rows.filter((r) => r.${f.name} === want).map((r) => r.id).sort());`,
      '    }',
      '  });',
      '',
    );
  }
  for (const f of refFields) {
    const parent = f.refTable!;
    filterTests.push(
      `  it('?${f.name}= filters by parent; a missing parent is 409 REFERENCE_VIOLATION', async () => {`,
      `    const second = await ${insertName(parent)}(t.db!, 2);`,
      `    const a = await t.client.post<Body>('${path}', { ...make(1), ${f.name}: 1 });`,
      `    const b = await t.client.post<Body>('${path}', { ...make(2), ${f.name}: second });`,
      '    expect(a).toHaveStatus(201);',
      '    expect(b).toHaveStatus(201);',
      `    const res = await t.client.get<{ items: Body[] }>('${path}', { ${f.name}: second });`,
      '    expect(res.body.items.map((r) => r.id)).toEqual([b.body.id]);',
      `    expect(await t.client.post('${path}', { ...make(3), ${f.name}: 999999 })).toBeProblem(409, 'REFERENCE_VIOLATION');`,
      '  });',
      '',
    );
  }
  if (firstText) {
    const f = firstText;
    filterTests.push(
      `  it('?q= is a case-insensitive substring match on ${f.name}, with LIKE wildcards escaped', async () => {`,
      `    const rows = await seed(t.client, '${path}', make, 6);`,
      `    const target = String(rows[3]!.${f.name});`,
      `    const hit = await t.client.get<{ items: Body[] }>('${path}', { q: target.toUpperCase(), limit: 200 });`,
      '    expect(hit).toHaveStatus(200);',
      '    expect(hit.body.items.map((r) => r.id)).toContain(rows[3]!.id);',
      `    for (const r of hit.body.items) expect(String(r.${f.name}).toLowerCase()).toContain(target.toLowerCase());`,
      `    expect((await t.client.get<{ items: Body[] }>('${path}', { q: '%', limit: 200 })).body.items).toEqual([]);`,
      '  });',
      '',
    );
  }
  if (nullables.length) {
    filterTests.push(
      "  it('optional fields may be omitted (stored as null) and cleared with null on PATCH', async () => {",
      `    const created = await t.client.post<Body>('${path}', Object.fromEntries(Object.entries(make(1)).filter(([k]) => ![${nullables.map((f) => q(f.name)).join(', ')}].includes(k))));`,
      '    expect(created).toHaveStatus(201);',
      ...nullables.map((f) => `    expect(created.body.${f.name}).toBeNull();`),
      `    const patched = await t.client.patch<Body>('${path}/' + created.body.id, { ${nullables.map((f) => `${f.name}: make(1).${f.name}`).join(', ')} });`,
      '    expect(patched).toHaveStatus(200);',
      `    const cleared = await t.client.patch<Body>('${path}/' + created.body.id, { ${nullables.map((f) => `${f.name}: null`).join(', ')} });`,
      '    expect(cleared).toHaveStatus(200);',
      ...nullables.map((f) => `    expect(cleared.body.${f.name}).toBeNull();`),
      '  });',
      '',
    );
  }
  filterTests.push(
    "  it('PATCH with an empty body is a 400 problem', async () => {",
    `    const created = await t.client.post<Body>('${path}', make(1));`,
    `    expect(await t.client.patch('${path}/' + created.body.id, {})).toBeProblem(400);`,
    '  });',
    '',
  );
  L.push(
    `describe('${path} filters and partial updates', () => {`,
    `  const t = useTarget(${hasRefs ? 'server' : ''});`,
    '',
    ...filterTests.slice(0, -1),
    '});',
  );
  return join(L);
}
