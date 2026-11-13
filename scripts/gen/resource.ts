/**
 * pnpm gen:resource <plural-name> --fields "<spec>" [--dry-run]
 *
 * Scaffolds one resource in the house shape (test/fixtures/widgets.ts, split into layers):
 *   migration  -> repo (SQL over an Executor) -> routes (zod + Fastify, req.db) -> HTTP tests
 *   + a test fixture other resources' tests can import, + registration at the @gen: markers in
 *   db/schema.ts and http/routes/index.ts.
 * Refuses to overwrite anything (exit 2). --dry-run prints paths and contents, writes nothing.
 *
 * Field grammar: see the header of ./spec.ts (also printed by --help).
 * Hidden: --root <dir> runs against another checkout/tree (used by the generator's own tests).
 */
import path from 'node:path';
import { parseArgs } from 'node:util';
import { apply, docsLines, GenError, plan } from './plan.js';
import { EXAMPLE, MODIFIERS, SpecError, TYPES } from './spec.js';

const HELP = `pnpm gen:resource <plural-name> --fields "<spec>" [--dry-run]

  <plural-name>   plural snake_case table name, e.g. shipments
  --fields        comma-separated  name:type[?][:modifier...]
                    name       camelCase (-> snake_case column); id/createdAt/updatedAt are reserved
                    types      ${TYPES.join(' | ')}
                    ?          nullable / optional
                    modifiers  ${MODIFIERS.join(' | ')}
                               unique        UNIQUE constraint (text, int, bigint, numeric, date, timestamptz)
                               min0|positive CHECK >= 0 / > 0 + zod bound (int, bigint, numeric)
                               max=<n>       text length cap (default 200)
  --dry-run       print the paths and file contents; write nothing

  example:
    pnpm gen:resource shipments --fields "${EXAMPLE}, shippedAt:timestamptz?"

Writes: migration, repo, routes, test fixture, integration test; edits db/schema.ts and
http/routes/index.ts at their @gen: markers. Never overwrites (exit 2). Exit 2 on any bad input;
the message names the token, the valid options and an example.
`;

function main(): number {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      fields: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      root: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    console.log(HELP);
    return 0;
  }
  if (positionals.length > 1) {
    throw new SpecError(`unexpected extra argument(s): ${positionals.slice(1).join(' ')}. Quote the --fields value: --fields "${EXAMPLE}"`);
  }
  const root = path.resolve(values.root ?? path.join(import.meta.dirname, '..', '..'));
  const p = plan(root, positionals[0], values.fields);
  const dry = values['dry-run'];

  for (const w of p.warnings) console.warn(`warning: ${w}`);
  const skipped = p.ctx.fields.filter((f) => f.nullable && f.kind !== 'ref').map((f) => f.name);
  if (skipped.length) console.log(`note: nullable column(s) ${skipped.join(', ')} are not sortable (keyset pagination needs NOT NULL sort columns); sort allowlist = NOT NULL scalar columns + createdAt.`);

  if (dry) {
    for (const f of p.files) console.log(`\n===== would create ${f.rel} =====\n${f.content}`);
    for (const e of p.edits) console.log(`===== would edit ${e.rel}: insert above ${e.marker}:  ${e.line}`);
    console.log('\n(dry run: nothing written)');
  } else {
    apply(root, p);
    console.log('created:');
    for (const f of p.files) console.log(`  ${f.rel}`);
    console.log('edited:');
    for (const rel of new Set(p.edits.map((e) => e.rel))) console.log(`  ${rel}`);
  }

  const t = p.ctx.plural;
  console.log(`
Next steps${dry ? ' (after re-running without --dry-run)' : ''}:
  1. Review the migration: packages/service/src/db/migrations/${p.ctx.migrationFile}
  2. pnpm vitest run --project integration ${t}      (typecheck first: pnpm typecheck; full gate: pnpm test)
  3. pnpm docs:check needs these routes in docs/llms.txt § 4 (API surface); paste:
${docsLines(p).join('\n')}
  4. Commit: git add packages/service scripts docs && git commit -m "${t}: ..."`);
  return 0;
}

try {
  process.exitCode = main();
} catch (err) {
  if (err instanceof SpecError || err instanceof GenError) {
    console.error(`gen:resource: ${err.message}`);
    process.exitCode = 2;
  } else if ((err as { code?: string }).code?.startsWith('ERR_PARSE_ARGS')) {
    console.error(`gen:resource: ${(err as Error).message}\n  Run \`pnpm gen:resource --help\` for the syntax.`);
    process.exitCode = 2;
  } else {
    throw err;
  }
}
