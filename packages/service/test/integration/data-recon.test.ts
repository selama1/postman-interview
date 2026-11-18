import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { testEnv } from '../harness/env.js';
import { useTarget } from '../harness/server.js';

/**
 * `pnpm data:recon` is the first step of a live session: it loads every raw file and reports what would
 * affect an import. Tested at its call path (CLI subprocess, fresh DB) with small files that plant one
 * instance of each class of problem, so a regression in any probe shows up as a missing/changed line.
 */
describe('data:recon (CLI) reports everything that affects an import', () => {
  const t = useTarget();
  const root = mkdtempSync(path.join(tmpdir(), 'data-recon-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const recon = (dir: string) =>
    spawnSync(process.execPath, ['--import', 'tsx', 'scripts/data/recon.ts', dir], {
      cwd: testEnv.root,
      // Reports go to a temp dir: a test run must never write into the repo's data/ folder.
      env: { ...process.env, DATABASE_URL: t.db!.url, DATA_OUT_DIR: path.join(root, 'out') },
      encoding: 'utf8',
    });

  it('flags duplicates, mixed shapes, slash-date order, epoch, case variants, units, orphans and names-for-codes', () => {
    const dir = path.join(root, 'planted');
    mkdirSync(dir);
    // planets.csv starts with a UTF-8 BOM: the header must still be `code`, and the BOM is reported.
    writeFileSync(
      path.join(dir, 'planets.csv'),
      `﻿code,name\n${['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta', 'Eta', 'Theta', 'Iota'].map((n, i) => `P0${i + 1},${n}`).join('\n')}\n`,
    );
    writeFileSync(
      path.join(dir, 'parcels.csv'),
      [
        'parcel_id,status,booked_at,price,dest',
        'PX-1,delivered,2024-03-01T10:00:00Z,12.5,P01',
        'PX-1,delivered,2024-03-01T10:00:00Z,12.5,P01', // identical duplicate
        'PX-2,Delivered,2024-03-02T10:00:00Z,"$1,234.50",P02', // unit/currency value
        'PX-2,lost,2024-03-02T10:00:00Z,"$1,234.50",P02', // conflicting duplicate (status differs)
        'PX-3,DELIVERED ,3/14/2024,7,P03', // slash date, second part > 12: only M/D fits; padded + case variant
        'PX-4,lost,1710000000,8,P04', // epoch seconds (2024-03-09)
        'PX-5,lost,2024-03-05T10:00:00Z,9,P05',
        'PX-6,delivered,2024-03-06T10:00:00Z,10,P06',
        'PX-7,delivered,2024-03-07T10:00:00Z,11,P07',
        'PX-8,delivered,2024-03-08T10:00:00Z,12,P08',
        'PX-9,delivered,2024-03-09T10:00:00Z,13,P09',
        'PX-10,delivered,2024-03-10T10:00:00Z,14,Alpha', // a planet NAME used instead of its code
        'PX-11,delivered,2024-03-11T10:00:00Z,15,Alpha',
        'PX-12,delivered,2024-03-12T10:00:00Z,16,ZZZ', // orphan
      ].join('\n'),
    );

    const r = recon(dir);
    expect(r.status, `recon failed:\n${r.stdout}\n${r.stderr}`).toBe(0);
    const out = r.stdout;
    // The saved report lands in DATA_OUT_DIR, not in the repo's data/out.
    expect(readFileSync(path.join(root, 'out', 'recon.md'), 'utf8')).toContain('parcels');
    expect(existsSync(path.join(testEnv.root, 'data', 'out', 'recon.md'))).toBe(false);

    // Files: row counts, BOM
    expect(out).toMatch(/\| `parcels` \| parcels\.csv \| 14 \| 5 \|/);
    expect(out).toMatch(/\| `planets` \| planets\.csv \| 9 \| 2 \| \d+ \| UTF-8 BOM stripped/);
    // candidate key + duplicates: PX-1 identical, PX-2 conflicting (differing column named)
    expect(out).toContain('key `parcel_id` (candidate: by name): 12 distinct; 2 duplicated key values over 4 rows; 1 groups IDENTICAL');
    expect(out).toMatch(/1 CONFLICTING \(e\.g\. `PX-2`; differing columns: status×1\)/);
    // mixed shapes with counts + example; epoch decoded and compared with the column's own dates
    expect(out).toMatch(/`booked_at`: MIXED shapes: ISO timestamp\/date ×12 .*slash date ×1 \(e\.g\. `3\/14\/2024`\).*epoch seconds ×1 \(e\.g\. `1710000000`\)/);
    expect(out).toMatch(/epoch seconds ×1: `1710000000` → 2024-03-09; .*same range/);
    // slash-date order verdict
    expect(out).toContain('M/D proven: 1 values only fit M/D (e.g. `3/14/2024`), 0 fit D/M');
    // case/whitespace variants, padding
    expect(out).toMatch(/`status`: 1 value\(s\) collapse under lower\(btrim\(\)\): .*'delivered'×9/);
    expect(out).toContain("'Delivered'×1");
    expect(out).toContain("'DELIVERED '×1");
    expect(out).toContain('`status`: 1 values with leading/trailing whitespace');
    // currency affix
    expect(out).toMatch(/`price`: MIXED shapes: plain number ×\d+ .*number with unit\/currency\/separators ×2 \(e\.g\. `\$1,234\.50`\)/);
    // references: orphans counted, name-instead-of-code detected
    expect(out).toMatch(/`parcels\.dest` → `planets\.code`: 11 distinct values, 81\.8% match; orphans: 3 rows \/ 2 values/);
    expect(out).toMatch(/2 orphan rows \(1 values, e\.g\. `Alpha`\) equal `planets\.name` case-insensitively \(planets\.name used instead of code\)/);
    // decisions derived from the findings
    expect(out).toContain('## Decisions you will need');
    expect(out).toContain('parcels duplicate keys: parcel_id: 1 identical groups → collapse; 1 conflicting groups → which row wins');
    expect(out).toContain('parcels dates booked_at: ISO + M/D (proven) + epoch s (in range) → normalise to timestamptz UTC');
    expect(out).toContain('parcels orphans: dest→planets.code(3 rows)');
    expect(out).toContain('names used as codes: dest(2 are planets.name)');
    // the decisions list stays compact: one line per finding kind per table
    const decisions = out.split('## Decisions you will need')[1]!.trim().split('\n').filter((l) => /^\d+\. /.test(l));
    expect(decisions.length).toBeLessThanOrEqual(12);
  });

  it('a clean ISO-only table produces no findings beyond its key', () => {
    const dir = path.join(root, 'clean');
    mkdirSync(dir);
    writeFileSync(path.join(dir, 'things.csv'), 'id,at\n1,2024-01-01T00:00:00Z\n2,2024-01-02T00:00:00Z\n');
    const r = recon(dir);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('key `id` (candidate: by name): 2 distinct, no duplicates');
    expect(r.stdout).not.toMatch(/MIXED|slash-date|orphans/);
    expect(r.stdout).toContain('none: nothing in the data needs a ruling');
  });

  it('reports a column named after another table key even below 80% overlap, plus negatives and case-colliding values', () => {
    const dir = path.join(root, 'named');
    mkdirSync(dir);
    // 60 customers (high-cardinality emails); two emails differ only in case
    const customers = Array.from({ length: 60 }, (_, i) => {
      const n = String(i + 1).padStart(3, '0');
      return `C${n},${i === 0 ? 'Dup@x.com' : i === 1 ? 'dup@x.com' : `u${n}@x.com`}`;
    });
    writeFileSync(path.join(dir, 'customers.csv'), `customer_id,email\n${customers.join('\n')}\n`);
    // 12 distinct customer ids, only 8 exist (66.7% < 80%); one negative weight
    const ids = ['C001', 'C002', 'C003', 'C004', 'C005', 'C006', 'C007', 'C008', 'X1', 'X2', 'X3', 'X4'];
    writeFileSync(
      path.join(dir, 'shipments.csv'),
      `shipment_id,customer_id,weight_kg\n${ids.map((c, i) => `S${i + 1},${c},${i === 3 ? -3 : i + 5}`).join('\n')}\n`,
    );
    const r = recon(dir);
    expect(r.status, r.stderr).toBe(0);
    const out = r.stdout;
    expect(out).toMatch(/`shipments\.customer_id` → `customers\.customer_id`: 12 distinct values, 66\.7% match \(reported by column name despite <80% overlap\); orphans: 4 rows \/ 4 values/);
    expect(out).toMatch(/`weight_kg`: numeric column has negatives ×1 \(e\.g\. `-3`\)/);
    expect(out).toMatch(/`email`: 2 values collide case-insensitively \(1 groups; raw spellings differ\), e\.g\. `Dup@x\.com` \/ `dup@x\.com`/);
    expect(out).toContain('shipments orphans: customer_id→customers.customer_id(4 rows)');
    expect(out).toContain('negative/zero numbers: weight_kg(1 neg)');
    expect(out).toContain('text hygiene: email(2 case-colliding values)');
  });

  it('refuses with the reason and the fix when there is nothing to load', () => {
    const dir = path.join(root, 'empty');
    mkdirSync(dir);
    const r = recon(dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('No data files found');
    expect(r.stderr).toMatch(/Fix: .*\.csv .*\.ndjson/);
  });
});
