/**
 * Import staging tables into typed tables; every bad row lands in import_rejects.
 *
 *   tsx scripts/data/import.ts scripts/data/specs/shipments.ts
 *   DATABASE_URL=... tsx scripts/data/import.ts <spec-file.ts>      (defaults to .env / compose dev DB)
 *
 * The spec file default-exports an ImportSpec, or an array of them run in order (parents before
 * children, so `ref` lookups find the parent rows). See importFromStaging's JSDoc for a full spec:
 *
 *   import type { ImportSpec } from '../../packages/service/src/db/import.js';
 *   export default { source: 'staging.customers', target: 'customers', key: ['external_id'], columns: {...} } satisfies ImportSpec;
 *
 * Exit code 0 even with rejects (rejects are data, inspect them); 1 only on errors.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { importFromStaging, ImportError, type ImportReport, type ImportSpec } from '../../packages/service/src/db/import.js';
import { createDb } from '../../packages/service/src/db/kysely.js';
import { databaseUrl } from './util.js';

function formatReport(r: ImportReport): string {
  const lines = [
    `import ${r.importId}: ${r.source} -> ${r.target}`,
    `  total               ${r.total}`,
    `  inserted            ${r.inserted}`,
    `  updated             ${r.updated}`,
    `  skipped duplicates  ${r.skippedDuplicates}`,
    `  rejected            ${r.rejected}`,
  ];
  if (r.byReason.length) {
    lines.push('  rejects by reason:');
    const w = Math.max(...r.byReason.map((x) => x.column.length));
    for (const x of r.byReason) {
      lines.push(`    ${String(x.count).padStart(7)}  ${x.column.padEnd(w)}  ${x.reason}   rows: ${x.sampleRows.join(', ')}${x.count > x.sampleRows.length ? ', ...' : ''}`);
    }
  }
  if (r.rejected > 0) {
    lines.push(
      `WARN: ${r.rejected} of ${r.total} rows were NOT imported (they are data, not a failure). Inspect:`,
      `  select source_row, reasons, raw from import_rejects where import_id = '${r.importId.replace(/'/g, "''")}' order by source_row`,
    );
  }
  return lines.join('\n');
}

async function main() {
  const file = process.argv[2];
  if (!file || file.startsWith('--')) {
    console.error('Usage: tsx scripts/data/import.ts <spec-file.ts>   (default export: an ImportSpec or an array of them)');
    process.exitCode = 2;
    return;
  }
  const mod = (await import(pathToFileURL(path.resolve(file)).href)) as { default?: ImportSpec | ImportSpec[] };
  if (!mod.default) {
    console.error(`${file} has no default export. Fix: export default { source, target, columns, ... } satisfies ImportSpec;  (or an array of them)`);
    process.exitCode = 1;
    return;
  }
  const specs = Array.isArray(mod.default) ? mod.default : [mod.default];
  const { db } = createDb({ url: databaseUrl() });
  try {
    for (const spec of specs) {
      console.log(formatReport(await importFromStaging(db, spec)));
    }
  } catch (err) {
    // ImportError already carries reason + fix; anything else (connection, ...) is shown as is.
    console.error(err instanceof ImportError ? err.message : err instanceof Error ? `import failed: ${err.message}` : err);
    process.exitCode = 1;
  } finally {
    await db.destroy();
  }
}

void main();
