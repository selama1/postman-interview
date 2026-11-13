/**
 * Load a raw dataset into the `staging` schema, losslessly, before designing real tables.
 *
 *   pnpm data:load data/raw/shipments.csv                 -> staging.shipments
 *   pnpm data:load data/raw/x.json --table customers      (JSON array or NDJSON)
 *   pnpm data:load data/raw/x.csv --delimiter ";" --replace
 *   DATABASE_URL=... pnpm data:load ...                   (defaults to .env / compose dev DB)
 *
 * Every column is TEXT (no guessing at load time — that's what data:profile is for), plus
 * `_row` (1-based source row number) so bad records can be reported back by line.
 * Nested JSON values are stored as JSON text. Then:
 *   pnpm data:profile staging.shipments   -> types, nulls, keys, anomalies
 *   write a migration that creates the real table and INSERT ... SELECT from staging with casts.
 */
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'csv-parse';
import pg from 'pg';
import { argValue, databaseUrl, hasFlag, sanitizeIdent } from './util.js';

const file = process.argv[2];
if (!file || file.startsWith('--')) {
  console.error('Usage: pnpm data:load <file.csv|.tsv|.json|.ndjson> [--table name] [--delimiter ,] [--replace]');
  process.exit(2);
}
const ext = path.extname(file).toLowerCase();
const table = sanitizeIdent(argValue('--table') ?? path.basename(file, ext));
const replace = hasFlag('--replace');

async function* records(): AsyncGenerator<Record<string, unknown>> {
  if (ext === '.json') {
    const data = JSON.parse(await readFile(file!, 'utf8')) as unknown;
    const arr = Array.isArray(data) ? data : (Object.values(data as object).find(Array.isArray) as unknown[] | undefined);
    if (!arr) throw new Error('JSON must be an array of objects (or an object containing one).');
    for (const r of arr) yield r as Record<string, unknown>;
  } else if (ext === '.ndjson' || ext === '.jsonl') {
    const lines = (await readFile(file!, 'utf8')).split(/\r?\n/);
    for (const l of lines) if (l.trim()) yield JSON.parse(l) as Record<string, unknown>;
  } else {
    const delimiter = argValue('--delimiter') ?? (ext === '.tsv' ? '\t' : ',');
    const parser = createReadStream(file!).pipe(
      parse({ columns: true, delimiter, bom: true, relax_column_count: true, skip_empty_lines: true, trim: false }),
    );
    for await (const r of parser) yield r as Record<string, unknown>;
  }
}

const toText = (v: unknown): string | null =>
  v === null || v === undefined ? null : typeof v === 'object' ? JSON.stringify(v) : String(v);

async function main() {
  const client = new pg.Client({ connectionString: databaseUrl() });
  await client.connect();
  const full = `staging."${table}"`;
  let cols: string[] | null = null;
  let srcKeys: string[] = [];
  let batch: Array<Array<string | null>> = [];
  let total = 0;
  const t0 = Date.now();

  const flush = async () => {
    if (!batch.length || !cols) return;
    const width = cols.length + 1;
    const values = batch.map((_, i) => `(${Array.from({ length: width }, (__, j) => `$${i * width + j + 1}`).join(',')})`).join(',');
    await client.query(`insert into ${full} ("_row", ${cols.map((c) => `"${c}"`).join(',')}) values ${values}`, batch.flat());
    batch = [];
  };

  try {
    await client.query('begin');
    await client.query('create schema if not exists staging');
    if (replace) await client.query(`drop table if exists ${full}`);
    for await (const rec of records()) {
      if (!cols) {
        srcKeys = Object.keys(rec);
        const seen = new Map<string, number>();
        cols = srcKeys.map((k) => {
          const base = sanitizeIdent(k) || 'col';
          const n = seen.get(base) ?? 0;
          seen.set(base, n + 1);
          return n ? `${base}_${n + 1}` : base;
        });
        await client.query(`create table ${full} ("_row" bigint primary key, ${cols.map((c) => `"${c}" text`).join(', ')})`);
      }
      total++;
      batch.push([String(total), ...srcKeys.map((k) => toText(rec[k]))]);
      if (batch.length >= Math.floor(60_000 / (cols.length + 1))) await flush();
    }
    await flush();
    await client.query('commit');
  } catch (err) {
    await client.query('rollback').catch(() => {});
    const e = err as Error & { code?: string };
    console.error(`load failed: ${e.message}`);
    if (e.code === '42P07') console.error(`Fix: table ${full} exists — pass --replace or --table <other>.`);
    process.exitCode = 1;
    return;
  } finally {
    await client.end();
  }
  console.log(`loaded ${total} rows into ${full} (${cols?.length ?? 0} columns) in ${Date.now() - t0} ms`);
  console.log(`columns: ${cols?.join(', ')}`);
  console.log(`next: pnpm data:profile staging.${table}`);
}

void main();
