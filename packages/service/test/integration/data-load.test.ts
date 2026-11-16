import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { testEnv } from '../harness/env.js';
import { useTarget } from '../harness/server.js';

/**
 * `pnpm data:load` is the lossless first step of every import, so it is tested at its call path:
 * the CLI as a subprocess, against a fresh database.
 */
describe('data:load (CLI) stages raw files losslessly', () => {
  const t = useTarget();
  const dir = mkdtempSync(path.join(tmpdir(), 'data-load-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const load = (file: string, content: string) => {
    const p = path.join(dir, file);
    writeFileSync(p, content);
    const r = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/data/load.ts', p, '--replace'], {
      cwd: testEnv.root,
      env: { ...process.env, DATABASE_URL: t.db!.url },
      encoding: 'utf8',
    });
    expect(r.status, `load failed:\n${r.stdout}\n${r.stderr}`).toBe(0);
    return r.stdout;
  };

  // Regression (2026-11-16): columns came from the FIRST record only, so a key that first appears
  // later (shipment_events.ndjson `meta`, on 21,780 of 107,828 rows) was silently dropped.
  it('NDJSON: a key that first appears in a later record becomes a column; earlier rows get NULL', async () => {
    const out = load('events.ndjson', [
      '{"id":1,"type":"booked"}',
      '{"id":2,"type":"departed","meta":{"crew":"Ada","temp_c":-76}}',
      '{"id":3,"type":"arrived","note":"late"}',
    ].join('\n'));
    expect(out).toMatch(/3 rows .*\(4 columns\)/);
    const rows = await t.db!.query(`select _row::int, id, type, meta, note from staging.events order by _row`);
    expect(rows).toEqual([
      { _row: 1, id: '1', type: 'booked', meta: null, note: null },
      { _row: 2, id: '2', type: 'departed', meta: '{"crew":"Ada","temp_c":-76}', note: null },
      { _row: 3, id: '3', type: 'arrived', meta: null, note: 'late' },
    ]);
  });

  it('JSON array: the same rule (union of all keys, in first-seen order)', async () => {
    load('things.json', JSON.stringify([{ a: 'x' }, { b: 2 }, { a: 'z', c: true }]));
    const cols = await t.db!.query<{ column_name: string }>(
      `select column_name from information_schema.columns where table_schema = 'staging' and table_name = 'things' order by ordinal_position`,
    );
    expect(cols.map((c) => c.column_name)).toEqual(['_row', 'a', 'b', 'c']);
    expect(await t.db!.query(`select a, b, c from staging.things order by _row`)).toEqual([
      { a: 'x', b: null, c: null },
      { a: null, b: '2', c: null },
      { a: 'z', b: null, c: 'true' },
    ]);
  });
});
