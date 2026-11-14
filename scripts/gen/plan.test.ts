/**
 * Generator behaviour on a scratch tree: refusal to overwrite, marker handling, migration
 * numbering, ref-target detection. The generated code itself is proven by compiling + running it
 * (see the commit message), not by string assertions here.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { apply, docsLines, GenError, insertAtMarker, PATHS, plan } from './plan.js';

let root: string;
const w = (rel: string, text: string) => {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  writeFileSync(path.join(root, rel), text);
};
const r = (rel: string) => readFileSync(path.join(root, rel), 'utf8');

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'gen-resource-'));
  w(`${PATHS.migrations}/0000_baseline.ts`, 'export {};\n');
  w(PATHS.schema, '// @gen:table-imports\n\nexport interface Database {\n  // @gen:tables\n}\n');
  w(PATHS.routesIndex, "// @gen:route-imports\nexport async function registerRoutes(app: any) {\n  await app.register(health);\n  // @gen:routes\n}\n");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('gen:resource plan/apply', () => {
  it('creates the five files, numbers the migration after the last one, registers above the markers', () => {
    w(`${PATHS.migrations}/0007_something.ts`, 'export {};\n');
    const p = plan(root, 'authors', 'name:text:unique, tier:enum(basic|gold)');
    expect(p.files.map((f) => f.rel)).toEqual([
      'packages/service/src/db/migrations/0008_create_authors.ts',
      'packages/service/src/resources/authors/repo.ts',
      'packages/service/src/resources/authors/routes.ts',
      'packages/service/test/fixtures/authors.ts',
      'packages/service/test/integration/authors.test.ts',
    ]);
    apply(root, p);
    expect(r(PATHS.schema)).toContain("import type { AuthorsTable } from '../resources/authors/repo.js';\n// @gen:table-imports");
    expect(r(PATHS.schema)).toContain('  authors: AuthorsTable;\n  // @gen:tables');
    expect(r(PATHS.routesIndex)).toContain("  await app.register(authorsRoutes, { prefix: '/authors' });\n  // @gen:routes");
  });

  it('refuses to overwrite any existing file, names it, and writes nothing', () => {
    apply(root, plan(root, 'authors', 'name:text'));
    const before = r(PATHS.schema);
    expect(() => plan(root, 'authors', 'name:text')).toThrow(/refusing to overwrite[\s\S]*repo\.ts[\s\S]*delete them or choose another name/);
    w(`${PATHS.tests}/boxes.test.ts`, '// mine\n');
    expect(() => plan(root, 'boxes', 'name:text')).toThrow(/boxes\.test\.ts[\s\S]*delete it or choose another name/);
    expect(existsSync(path.join(root, PATHS.resources, 'boxes'))).toBe(false);
    expect(r(PATHS.schema)).toBe(before);
    expect(r(`${PATHS.tests}/boxes.test.ts`)).toBe('// mine\n');
  });

  it('fails loudly (and writes nothing) when a marker is missing', () => {
    w(PATHS.routesIndex, 'export async function registerRoutes(app: any) {}\n');
    expect(() => plan(root, 'authors', 'name:text')).toThrow(GenError);
    expect(() => plan(root, 'authors', 'name:text')).toThrow(/marker "\/\/ @gen:route-imports" not found in packages\/service\/src\/http\/routes\/index\.ts/);
    expect(existsSync(path.join(root, PATHS.resources))).toBe(false);
  });

  it('marker insertion is idempotent and keeps the marker', () => {
    const once = insertAtMarker('  // @gen:tables\n', '// @gen:tables', 'a: A;', 'x.ts');
    expect(once).toBe('  a: A;\n  // @gen:tables\n');
    expect(insertAtMarker(once, '// @gen:tables', 'a: A;', 'x.ts')).toBe(once);
  });

  it('ref target: unknown table is an error with the fix; hand-made table warns; generated resource is used as fixture', () => {
    expect(() => plan(root, 'books', 'authorId:ref(authors)')).toThrow(/no migration creates a table named "authors"[\s\S]*gen:resource authors/);

    w(`${PATHS.migrations}/0001_orders.ts`, 'await sql`create table orders (id bigint primary key)`.execute(db);\n');
    const hand = plan(root, 'lines', 'orderId:ref(orders)');
    expect(hand.warnings.join('\n')).toMatch(/orders.*no generated resource fixture/);
    expect(hand.files.find((f) => f.rel.endsWith('lines.test.ts'))!.content).toContain('insert into orders default values');

    apply(root, plan(root, 'authors', 'name:text'));
    const gen = plan(root, 'books', 'authorId:ref(authors)');
    expect(gen.warnings).toEqual([]);
    expect(gen.files.find((f) => f.rel.endsWith('books.test.ts'))!.content).toContain("import { insertAuthor } from '../fixtures/authors.js'");
  });

  it('self references are refused with a reason', () => {
    expect(() => plan(root, 'nodes', 'parentId:ref(nodes)')).toThrow(/self-references/);
  });

  it('nullable and ref columns are never sort-allowlisted (keyset needs NOT NULL)', () => {
    const repo = plan(root, 'things', 'name:text, note:text?').files.find((f) => f.rel.endsWith('repo.ts'))!.content;
    expect(repo).toContain("name: 'name'");
    expect(repo).not.toMatch(/note: 'note'/);
  });

  it('prints one docs line per route', () => {
    const lines = docsLines(plan(root, 'authors', 'name:text, tier:enum(a|b)'));
    expect(lines.map((l) => l.trim().split(/\s{2,}/)[0])).toEqual(['POST /authors/', 'GET /authors/', 'GET /authors/:id', 'PATCH /authors/:id', 'DELETE /authors/:id']);
  });
});
