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
  // Columns are the union of every record's keys, in first-seen order. JSON records need not share
  // keys: a key first seen in a later record adds a column, and earlier rows hold NULL for it.
  const colOf = new Map<string, string>(); // source key -> column name
  const used = new Set<string>(['_row']);
  let keys: string[] = []; // source keys, in column order
  let batch: Array<Array<string | null>> = [];
  let total = 0;
  const t0 = Date.now();

  const flush = async () => {
    if (!batch.length) return;
    const width = keys.length + 1;
    const values = batch.map((_, i) => `(${Array.from({ length: width }, (__, j) => `$${i * width + j + 1}`).join(',')})`).join(',');
    await client.query(`insert into ${full} ("_row", ${keys.map((k) => `"${colOf.get(k)}"`).join(',')}) values ${values}`, batch.flat());
    batch = [];
  };
  const columnFor = (key: string) => {
    const base = sanitizeIdent(key) || 'col';
    let name = base;
    for (let n = 2; used.has(name); n++) name = `${base}_${n}`;
    used.add(name);
    colOf.set(key, name);
    return name;
  };

  try {
    await client.query('begin');
    await client.query('create schema if not exists staging');
    if (replace) await client.query(`drop table if exists ${full}`);
    await client.query(`create table ${full} ("_row" bigint primary key)`);
    for await (const rec of records()) {
      const unseen = Object.keys(rec).filter((k) => !colOf.has(k));
      if (unseen.length) {
        await flush(); // the pending batch was built for the old column list
        for (const k of unseen) await client.query(`alter table ${full} add column "${columnFor(k)}" text`);
        keys = [...colOf.keys()];
      }
      total++;
      batch.push([String(total), ...keys.map((k) => toText(rec[k]))]);
      if (batch.length >= Math.floor(60_000 / (keys.length + 1))) await flush();
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
  const cols = [...colOf.values()];
  console.log(`loaded ${total} rows into ${full} (${cols.length} columns) in ${Date.now() - t0} ms`);
  console.log(`columns: ${cols.join(', ')}`);
  console.log(`next: pnpm data:profile staging.${table}`);
}

void main();
