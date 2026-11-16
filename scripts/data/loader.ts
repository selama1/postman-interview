/**
 * The lossless raw-file -> staging loader, shared by `pnpm data:load` (load.ts) and
 * `pnpm data:recon` (recon.ts): one implementation, so both stage files identically.
 *
 * Every column is TEXT plus `_row` (1-based source row number). Columns are the union of all
 * record keys in first-seen order. Throws `LoadError` (message + fix) instead of exiting.
 */
import { createReadStream } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'csv-parse';
import type pg from 'pg';
import { sanitizeIdent } from './util.js';

export const SUPPORTED_EXTENSIONS = ['.csv', '.tsv', '.json', '.ndjson', '.jsonl'] as const;

export class LoadError extends Error {
  constructor(message: string, readonly fix?: string) {
    super(message);
  }
}

export interface LoadOptions {
  file: string;
  /** staging table name; default = sanitized file basename */
  table?: string;
  replace?: boolean;
  /** CSV delimiter; default `,` (`\t` for .tsv) */
  delimiter?: string;
}

export interface LoadResult {
  table: string;
  rows: number;
  columns: string[];
  ms: number;
  /** a UTF-8 byte-order mark was present and stripped */
  bom: boolean;
}

export const tableNameFor = (file: string) => sanitizeIdent(path.basename(file, path.extname(file)));

const toText = (v: unknown): string | null =>
  v === null || v === undefined ? null : typeof v === 'object' ? JSON.stringify(v) : String(v);

/** Leading bytes: UTF-8 BOM is stripped; a UTF-16 BOM cannot be read as UTF-8, so refuse it. */
async function sniffBom(file: string): Promise<boolean> {
  const fh = await open(file, 'r');
  try {
    const b = Buffer.alloc(3);
    await fh.read(b, 0, 3, 0);
    if ((b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff)) {
      throw new LoadError(
        `${file} is UTF-16 encoded (byte-order mark ${b[0]!.toString(16)}${b[1]!.toString(16)}); it would load as garbage.`,
        'Re-save it as UTF-8 (e.g. iconv -f UTF-16 -t UTF-8 in.csv > out.csv) and load that.',
      );
    }
    return b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf;
  } finally {
    await fh.close();
  }
}

async function* records(file: string, ext: string, delimiter: string | undefined): AsyncGenerator<Record<string, unknown>> {
  if (ext === '.json') {
    const data = JSON.parse((await readFile(file, 'utf8')).replace(/^﻿/, '')) as unknown;
    const arr = Array.isArray(data) ? data : (Object.values(data as object).find(Array.isArray) as unknown[] | undefined);
    if (!arr) throw new LoadError('JSON must be an array of objects (or an object containing one).', 'Wrap the records in [ ... ].');
    for (const r of arr) yield r as Record<string, unknown>;
  } else if (ext === '.ndjson' || ext === '.jsonl') {
    const lines = (await readFile(file, 'utf8')).replace(/^﻿/, '').split(/\r?\n/);
    for (const l of lines) if (l.trim()) yield JSON.parse(l) as Record<string, unknown>;
  } else {
    const parser = createReadStream(file).pipe(
      parse({ columns: true, delimiter: delimiter ?? (ext === '.tsv' ? '\t' : ','), bom: true, relax_column_count: true, skip_empty_lines: true, trim: false }),
    );
    for await (const r of parser) yield r as Record<string, unknown>;
  }
}

/** Load one file into staging.<table> inside one transaction on `client` (rolled back on failure). */
export async function loadFile(client: pg.ClientBase, opts: LoadOptions): Promise<LoadResult> {
  const { file } = opts;
  const ext = path.extname(file).toLowerCase();
  const table = sanitizeIdent(opts.table ?? tableNameFor(file));
  const full = `staging."${table}"`;
  const bom = await sniffBom(file);

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
    if (opts.replace) await client.query(`drop table if exists ${full}`);
    await client.query(`create table ${full} ("_row" bigint primary key)`);
    for await (const rec of records(file, ext, opts.delimiter)) {
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
    if (err instanceof LoadError) throw err;
    const e = err as Error & { code?: string };
    throw new LoadError(
      `load failed: ${e.message}`,
      e.code === '42P07'
        ? `table ${full} exists — pass --replace or --table <other>.`
        : e.code === '2BP01'
          ? `views/foreign keys/imports depend on ${full}; drop them first (\d+ ${full} lists them) or load into another database via DATABASE_URL.`
          : undefined,
    );
  }
  return { table, rows: total, columns: [...colOf.values()], ms: Date.now() - t0, bom };
}
