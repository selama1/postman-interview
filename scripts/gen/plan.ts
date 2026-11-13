/**
 * Plan + apply for `pnpm gen:resource`: decides which files to create and which registry files to
 * edit, validating EVERYTHING before touching disk (so a refusal never leaves a half-generated
 * resource). The only fs-dependent part of the generator; resource.ts is the thin CLI.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { names, renderFixture, renderMigration, renderRepo, renderRoutes, renderTest, type Ctx, type ParentInfo } from './render.js';
import { parseFields, parseTableName, EXAMPLE } from './spec.js';

export class GenError extends Error {
  override name = 'GenError';
}

export const PATHS = {
  migrations: 'packages/service/src/db/migrations',
  resources: 'packages/service/src/resources',
  fixtures: 'packages/service/test/fixtures',
  tests: 'packages/service/test/integration',
  schema: 'packages/service/src/db/schema.ts',
  routesIndex: 'packages/service/src/http/routes/index.ts',
} as const;

export const MARKERS = {
  schemaImports: '// @gen:table-imports',
  schemaTables: '// @gen:tables',
  routeImports: '// @gen:route-imports',
  routes: '// @gen:routes',
} as const;

export interface PlannedFile {
  rel: string;
  content: string;
}
export interface PlannedEdit {
  rel: string;
  marker: string;
  line: string;
  before: string;
  after: string;
}
export interface Plan {
  ctx: Ctx;
  files: PlannedFile[];
  edits: PlannedEdit[];
  warnings: string[];
}

const abs = (root: string, rel: string) => path.join(root, rel);
const read = (root: string, rel: string) => readFileSync(abs(root, rel), 'utf8');

/** Insert `line` (same indentation as the marker) directly above the marker. No-op if already present. Fails loudly if the marker is missing. */
export function insertAtMarker(text: string, marker: string, line: string, rel: string): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex((l) => l.trim() === marker);
  if (at < 0) {
    throw new GenError(
      `marker "${marker}" not found in ${rel}.\n  Fix: add a line containing exactly \`${marker}\` where generated entries belong (the generator inserts above it and keeps it), then re-run. Nothing was written.`,
    );
  }
  if (lines.some((l) => l.trim() === line.trim())) return text;
  const indent = lines[at]!.match(/^\s*/)![0];
  lines.splice(at, 0, indent + line);
  return lines.join(eol);
}

const nextMigrationNumber = (root: string) => {
  const files = readdirSync(abs(root, PATHS.migrations)).filter((f) => /^\d{4}_/.test(f)).sort();
  const last = files.at(-1);
  return String((last ? Number.parseInt(last.slice(0, 4), 10) : -1) + 1).padStart(4, '0');
};

const tableInMigrations = (root: string, table: string) =>
  readdirSync(abs(root, PATHS.migrations))
    .filter((f) => f.endsWith('.ts'))
    .some((f) => new RegExp(`create\\s+table\\s+(if\\s+not\\s+exists\\s+)?"?${table}"?[\\s(]|createTable\\(\\s*['"]${table}['"]`, 'i').test(read(root, `${PATHS.migrations}/${f}`)));

export function plan(root: string, plural: string | undefined, fieldsSpec: string | undefined): Plan {
  const table = parseTableName(plural);
  const fields = parseFields(fieldsSpec);
  const n = names(table);
  const warnings: string[] = [];

  // Ref targets: how will tests create the parent row?
  const parents: ParentInfo[] = [];
  for (const target of new Set(fields.filter((f) => f.kind === 'ref').map((f) => f.refTable!))) {
    if (target === table) throw new GenError(`ref(${target}) points at the table being generated; self-references are not supported by the generator. Add the parent column by hand in a follow-up migration.`);
    const hasFixture = existsSync(abs(root, `${PATHS.fixtures}/${target}.ts`));
    const hasResource = existsSync(abs(root, `${PATHS.resources}/${target}/repo.ts`));
    if (hasResource && hasFixture) {
      parents.push({ table: target, mode: 'fixture' });
    } else if (hasResource || tableInMigrations(root, target)) {
      parents.push({ table: target, mode: 'fallback' });
      warnings.push(
        `ref(${target}): table "${target}" exists but has no generated resource fixture (${PATHS.fixtures}/${target}.ts). The generated tests create the parent with \`insert into ${target} default values\` -- edit the TODO helper if "${target}" has required columns.`,
      );
    } else {
      throw new GenError(
        `ref(${target}): no migration creates a table named "${target}", so the foreign key would fail at migrate time.\n  Fix: generate it first (e.g. \`pnpm gen:resource ${target} --fields "name:text"\`), or fix the name. Example of this generator's syntax: --fields "${EXAMPLE}"`,
      );
    }
  }

  const num = nextMigrationNumber(root);
  const migrationFile = `${num}_create_${table}.ts`;
  const ctx: Ctx = { plural: table, fields, parents, migrationFile };

  const files: PlannedFile[] = [
    { rel: `${PATHS.migrations}/${migrationFile}`, content: renderMigration(ctx) },
    { rel: `${PATHS.resources}/${table}/repo.ts`, content: renderRepo(ctx) },
    { rel: `${PATHS.resources}/${table}/routes.ts`, content: renderRoutes(ctx) },
    { rel: `${PATHS.fixtures}/${table}.ts`, content: renderFixture(ctx) },
    { rel: `${PATHS.tests}/${table}.test.ts`, content: renderTest(ctx) },
  ];

  // Refuse to overwrite: check every target (incl. any earlier create_<table> migration) before writing anything.
  const clashes = files.filter((f) => existsSync(abs(root, f.rel))).map((f) => f.rel);
  const earlier = readdirSync(abs(root, PATHS.migrations)).filter((f) => new RegExp(`^\\d{4}_create_${table}\\.ts$`).test(f));
  for (const e of earlier) clashes.push(`${PATHS.migrations}/${e}`);
  if (clashes.length) {
    throw new GenError(`refusing to overwrite existing file(s):\n${clashes.map((c) => `  - ${c}`).join('\n')}\n  Fix: delete ${clashes.length === 1 ? 'it' : 'them'} or choose another name.`);
  }

  // Registry edits (validated now, applied later).
  // One chain per file: each marker insertion builds on the previous result.
  const edits: PlannedEdit[] = [];
  const chain = (rel: string, items: Array<[string, string]>) => {
    let text = read(root, rel);
    for (const [marker, line] of items) {
      const before = text;
      text = insertAtMarker(text, marker, line, rel);
      if (text !== before) edits.push({ rel, marker, line, before, after: text });
    }
  };
  chain(PATHS.schema, [
    [MARKERS.schemaImports, `import type { ${n.tableType} } from '../resources/${table}/repo.js';`],
    [MARKERS.schemaTables, `${table}: ${n.tableType};`],
  ]);
  chain(PATHS.routesIndex, [
    [MARKERS.routeImports, `import { ${n.routesVar} } from '../../resources/${table}/routes.js';`],
    [MARKERS.routes, `await app.register(${n.routesVar}, { prefix: '/${table}' });`],
  ]);

  return { ctx, files, edits, warnings };
}

/** Write the planned files and apply the edits (the last edit per file already contains the earlier ones). */
export function apply(root: string, p: Plan): void {
  for (const f of p.files) {
    mkdirSync(path.dirname(abs(root, f.rel)), { recursive: true });
    writeFileSync(abs(root, f.rel), f.content, { encoding: 'utf8' });
  }
  const last = new Map<string, string>();
  for (const e of p.edits) last.set(e.rel, e.after);
  for (const [rel, text] of last) writeFileSync(abs(root, rel), text, { encoding: 'utf8' });
}

/** The lines to paste into docs/llms.txt § 4 (docs:check requires each route). */
export function docsLines(p: Plan): string[] {
  const t = p.ctx.plural;
  const one = names(t).one;
  const filters = p.ctx.fields.filter((f) => f.kind === 'enum' || f.kind === 'ref' || f.kind === 'bool').map((f) => f.name);
  const firstText = p.ctx.fields.find((f) => f.kind === 'text');
  const filt = [...filters, ...(firstText ? ['q'] : [])].join(', ');
  const col = (s: string) => s.padEnd(`DELETE /${t}/:id`.length + 2);
  // docs:check lists collection routes with a trailing slash (OpenAPI path of a '/' route under a prefix).
  return [
    `    ${col(`POST /${t}/`)}create a ${one} -> 201 + Location`,
    `    ${col(`GET /${t}/`)}list (keyset: ?limit ?cursor ?sort${filt ? `; filters: ${filt}` : ''})`,
    `    ${col(`GET /${t}/:id`)}get one; 404 NOT_FOUND`,
    `    ${col(`PATCH /${t}/:id`)}partial update; 400 EMPTY_PATCH`,
    `    ${col(`DELETE /${t}/:id`)}delete -> 204`,
  ];
}
