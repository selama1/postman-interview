/**
 * Static invariant: route handlers use `req.db`, never `app.db`/`fastify.db`/`this.db`.
 * That is what makes API test mode (x-test-session) work for every endpoint by default.
 * If this fails: replace the global handle with `req.db` (pass `req.db` into repo functions,
 * which take an `Executor`).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
// Resources (src/resources/**, from `pnpm gen:resource`) are optional: absent in the vanilla scaffold.
const roots = [here, path.resolve(here, '../../resources'), path.resolve(here, '../../../test/fixtures')].filter((dir) => existsSync(dir));
// Files allowed to touch the global handle (with the reason).
const ALLOW = new Map<string, string>([]);

const files = roots.flatMap((dir) =>
  readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => path.join(dir, f)),
);

describe('routes read the database through req.db', () => {
  it.each(files.map((f) => [path.relative(path.resolve(here, '../../..'), f).replaceAll('\\', '/'), f]))('%s', (rel, file) => {
    if (ALLOW.has(rel)) return;
    const offending = readFileSync(file, 'utf8')
      .split('\n')
      .map((line, i) => ({ line: line.trim(), n: i + 1 }))
      .filter(({ line }) => !line.startsWith('//') && !line.startsWith('*') && /\b(app|fastify|this|instance)\.db\b/.test(line));
    expect(
      offending.map(({ n, line }) => `${rel}:${n}: ${line}`),
      'use req.db (test-mode aware) instead of the global db handle',
    ).toEqual([]);
  });
});
