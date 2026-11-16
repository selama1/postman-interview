/**
 * Load a raw dataset into the `staging` schema, losslessly, before designing real tables.
 *
 *   pnpm data:load data/raw/books.csv                 -> staging.books
 *   pnpm data:load data/raw/x.json --table authors      (JSON array or NDJSON)
 *   pnpm data:load data/raw/x.csv --delimiter ";" --replace
 *   DATABASE_URL=... pnpm data:load ...                   (defaults to .env / compose dev DB)
 *
 * Every column is TEXT (no guessing at load time — that's what data:profile is for), plus
 * `_row` (1-based source row number) so bad records can be reported back by line.
 * Nested JSON values are stored as JSON text. JSON records need not share keys: the columns are the
 * union of all keys (absent key = NULL). Then:
 *   pnpm data:profile staging.books   -> types, nulls, keys, anomalies
 *   write a migration that creates the real table and INSERT ... SELECT from staging with casts.
 *
 * The loading itself lives in loader.ts (shared with `pnpm data:recon`).
 */
import pg from 'pg';
import { LoadError, loadFile } from './loader.js';
import { argValue, databaseUrl, hasFlag } from './util.js';

const file = process.argv[2];
if (!file || file.startsWith('--')) {
  console.error('Usage: pnpm data:load <file.csv|.tsv|.json|.ndjson> [--table name] [--delimiter ,] [--replace]');
  process.exit(2);
}

async function main() {
  const client = new pg.Client({ connectionString: databaseUrl() });
  await client.connect();
  try {
    const r = await loadFile(client, { file: file!, table: argValue('--table'), replace: hasFlag('--replace'), delimiter: argValue('--delimiter') });
    console.log(`loaded ${r.rows} rows into staging."${r.table}" (${r.columns.length} columns) in ${r.ms} ms`);
    console.log(`columns: ${r.columns.join(', ')}`);
    console.log(`next: pnpm data:profile staging.${r.table}`);
  } catch (err) {
    if (err instanceof LoadError) {
      console.error(err.message.startsWith('load failed') ? err.message : `load failed: ${err.message}`);
      if (err.fix) console.error(`Fix: ${err.fix}`);
    } else {
      console.error(`load failed: ${(err as Error).message}`);
    }
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

void main();
