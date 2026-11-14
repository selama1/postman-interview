import { describe, expect, it } from 'vitest';
import { importFromStaging, ImportError, type ColumnRule, type ImportReport, type ImportSpec } from '../../src/db/import.js';
import { useTarget } from '../harness/server.js';

/**
 * importFromStaging against a real Postgres, fresh empty DB per test (no mocks). The staging and
 * target tables are created per test with plain SQL, exactly as a migration + data:load would.
 */
describe('importFromStaging', () => {
  const t = useTarget();
  const q = <R extends Record<string, unknown> = Record<string, unknown>>(text: string, params?: unknown[]) => t.db!.query<R>(text, params);

  type Row = Partial<Record<'tracking_code' | 'customer_id' | 'weight' | 'status' | 'shipped' | 'delivered' | 'qty', string | null>>;
  const good = (n: number, over: Row = {}): Row => ({
    tracking_code: `TC${n}`,
    customer_id: '1',
    weight: '10',
    status: 'pending',
    shipped: '2026-01-02',
    delivered: '2026-01-03T10:00:00Z',
    qty: '5',
    ...over,
  });

  async function setup(rows: Row[] = [], extraDdl = '') {
    await q(`create table imp_customers (id bigint primary key, name text not null)`);
    await q(`insert into imp_customers values (1, 'Fry'), (2, 'Leela')`);
    await q(`create table imp_shipments (
      id bigint generated always as identity primary key,
      tracking_code text not null unique,
      customer_id bigint not null references imp_customers(id),
      weight_kg numeric(10,2),
      status text not null default 'pending',
      shipped_at date,
      delivered_at timestamptz,
      qty integer)`);
    await q(`create table staging.imp_shipments (_row bigint primary key, tracking_code text, customer_id text, weight text, status text, shipped text, delivered text, qty text)`);
    if (extraDdl) await q(extraDdl);
    for (const [i, r] of rows.entries()) {
      await q(`insert into staging.imp_shipments values ($1,$2,$3,$4,$5,$6,$7,$8)`, [i + 1, r.tracking_code ?? null, r.customer_id ?? null, r.weight ?? null, r.status ?? null, r.shipped ?? null, r.delivered ?? null, r.qty ?? null]);
    }
  }

  const rule = (r: ColumnRule) => r;
  const spec = (over: Partial<ImportSpec> = {}, columns: Record<string, ColumnRule> = {}): ImportSpec => ({
    source: 'staging.imp_shipments',
    target: 'imp_shipments',
    key: ['tracking_code'],
    columns: {
      tracking_code: rule({ from: 'tracking_code', type: 'text', required: true, normalize: 'upper' }),
      customer_id: rule({ from: 'customer_id', type: 'bigint', required: true, ref: { table: 'imp_customers', column: 'id' } }),
      weight_kg: rule({ from: 'weight', type: 'numeric', normalize: 'number', check: { sql: '$v > 0', reason: 'must be positive' } }),
      status: rule({ from: 'status', type: 'text', normalize: 'lower', oneOf: ['pending', 'in_transit', 'delivered', 'lost'], default: "'pending'" }),
      shipped_at: rule({ from: 'shipped', type: 'date' }),
      delivered_at: rule({ from: 'delivered', type: 'timestamptz' }),
      qty: rule({ from: 'qty', type: 'integer' }),
      ...columns,
    },
    ...over,
  });

  const run = (over: Partial<ImportSpec> = {}, columns: Record<string, ColumnRule> = {}) => importFromStaging(t.db!.db, spec(over, columns));
  const rejects = (id: string) =>
    q<{ source_row: number; reasons: string[]; raw: Record<string, string | null> }>(
      `select source_row::int, reasons, raw from import_rejects where import_id = $1 order by source_row`,
      [id],
    );
  const accounted = (r: ImportReport) => {
    expect(r.inserted + r.updated + r.rejected + r.skippedDuplicates).toBe(r.total);
    return r;
  };

  it('happy path: every row lands typed, nothing is rejected, the run is recorded', async () => {
    await setup([good(1), good(2, { tracking_code: ' tc2 ', weight: '1,234.5 kg', status: 'DELIVERED' })]);
    const r = accounted(await run());
    expect(r).toMatchObject({ total: 2, inserted: 2, updated: 0, rejected: 0, skippedDuplicates: 0, byReason: [] });
    const rows = await q(`select tracking_code, weight_kg::text, status, shipped_at::text, delivered_at is not null as d, qty from imp_shipments order by id`);
    expect(rows).toEqual([
      { tracking_code: 'TC1', weight_kg: '10.00', status: 'pending', shipped_at: '2026-01-02', d: true, qty: 5 },
      { tracking_code: 'TC2', weight_kg: '1234.50', status: 'delivered', shipped_at: '2026-01-02', d: true, qty: 5 },
    ]);
    expect(await rejects(r.importId)).toEqual([]);
    const [run1] = await q(`select inserted, rejected, total from import_runs where import_id = $1`, [r.importId]);
    expect(run1).toEqual({ inserted: 2, rejected: 0, total: 2 });
  });

  // One case per failure class: [label, overrides, column, reason template, reason text].
  const classes: Array<[string, Row, string, string, string]> = [
    ['numeric cast', { weight: '12,5kg' }, 'weight_kg', 'is not a valid numeric', 'weight_kg: "12,5kg" is not a valid numeric'],
    ['numeric unit-only', { weight: 'kg' }, 'weight_kg', 'is not a valid numeric', 'weight_kg: "kg" is not a valid numeric'],
    ['numeric NaN', { weight: 'NaN' }, 'weight_kg', 'is not a valid numeric', 'weight_kg: "NaN" is not a valid numeric'],
    ['date cast', { shipped: '2026-13-45' }, 'shipped_at', 'is not a valid date', 'shipped_at: "2026-13-45" is not a valid date'],
    ['date special word', { shipped: 'today' }, 'shipped_at', 'is not a valid date', 'shipped_at: "today" is not a valid date'],
    ['timestamptz cast', { delivered: 'yesterday-ish' }, 'delivered_at', 'is not a valid timestamptz', 'delivered_at: "yesterday-ish" is not a valid timestamptz'],
    ['integer cast', { qty: '2.5' }, 'qty', 'is not a valid integer', 'qty: "2.5" is not a valid integer'],
    ['required blank', { tracking_code: '   ' }, 'tracking_code', 'required', 'tracking_code: required'],
    ['required null', { customer_id: null }, 'customer_id', 'required', 'customer_id: required'],
    ['oneOf', { status: 'shipped' }, 'status', 'not in (pending|in_transit|delivered|lost)', 'status: "shipped" not in (pending|in_transit|delivered|lost)'],
    ['check', { weight: '-3' }, 'weight_kg', 'must be positive', 'weight_kg: must be positive (got "-3")'],
    ['missing ref', { customer_id: '99' }, 'customer_id', 'no matching imp_customers.id', 'customer_id: no imp_customers.id = 99'],
  ];
  it.each(classes)('rejects %s with source row, reason text and report entry', async (_label, bad, column, template, text) => {
    await setup([good(1), good(2, bad), good(3)]);
    const r = accounted(await run());
    expect(r).toMatchObject({ total: 3, inserted: 2, rejected: 1 });
    expect(r.byReason).toEqual([{ column, reason: template, count: 1, sampleRows: [2] }]);
    const rej = await rejects(r.importId);
    expect(rej).toHaveLength(1);
    expect(rej[0]!.source_row).toBe(2);
    expect(rej[0]!.reasons).toEqual([text]);
    expect(rej[0]!.raw).toMatchObject({ _row: 2 }); // the full staging row is kept for inspection
    expect(await q(`select count(*)::int as n from imp_shipments`)).toEqual([{ n: 2 }]);
  });

  it('a row with two problems gets BOTH reasons; the report counts it under each', async () => {
    await setup([good(1), good(2, { weight: 'x', status: 'shipped', customer_id: '99' }), good(3, { weight: 'y' })]);
    const r = await run();
    const rej = await rejects(r.importId);
    expect(rej.map((x) => x.source_row)).toEqual([2, 3]);
    expect(rej[0]!.reasons).toEqual([
      'customer_id: no imp_customers.id = 99',
      'weight_kg: "x" is not a valid numeric',
      'status: "shipped" not in (pending|in_transit|delivered|lost)',
    ]);
    const weight = r.byReason.find((x) => x.reason === 'is not a valid numeric');
    expect(weight).toEqual({ column: 'weight_kg', reason: 'is not a valid numeric', count: 2, sampleRows: [2, 3] });
    expect(r.byReason[0]!.count).toBe(2); // sorted by count desc
    expect(r.rejected).toBe(2);
  });

  it('normalize number: "1,234.5 kg" -> 1234.5, spaces and %, but "12,5" is rejected not guessed', async () => {
    await setup([
      good(1, { weight: '1,234.5 kg' }),
      good(2, { weight: ' 1 234.5kg ' }),
      good(3, { weight: '-7.25 kg' }),
      good(4, { weight: '12,5' }),
      good(5, { weight: '1,23,4' }),
    ]);
    const r = await run({}, { weight_kg: rule({ from: 'weight', type: 'numeric', normalize: 'number' }) });
    expect((await q(`select tracking_code, weight_kg::text as w from imp_shipments order by id`))).toEqual([
      { tracking_code: 'TC1', w: '1234.50' },
      { tracking_code: 'TC2', w: '1234.50' },
      { tracking_code: 'TC3', w: '-7.25' },
    ]);
    expect(r.byReason).toEqual([{ column: 'weight_kg', reason: 'is not a valid numeric', count: 2, sampleRows: [4, 5] }]);
  });

  it('dateOrder decides ambiguous dates explicitly; 13/02/2026 is invalid as MDY, valid as DMY', async () => {
    await setup([good(1, { shipped: '01/02/2026' }), good(2, { shipped: '13/02/2026' })]);
    const mdy = await run();
    expect(mdy.byReason).toEqual([{ column: 'shipped_at', reason: 'is not a valid date', count: 1, sampleRows: [2] }]);
    expect(await q(`select shipped_at::text as d from imp_shipments`)).toEqual([{ d: '2026-01-02' }]);
    await q(`delete from imp_shipments`);
    const dmy = await run({ dateOrder: 'DMY' });
    expect(dmy).toMatchObject({ inserted: 2, rejected: 0 });
    expect(await q(`select shipped_at::text as d from imp_shipments order by id`)).toEqual([{ d: '2026-02-01' }, { d: '2026-02-13' }]);
  });

  describe('duplicates on the natural key', () => {
    it('reject: later in-source duplicates name the winning row; the winner is the first row that passes every other rule', async () => {
      await setup([
        good(1, { tracking_code: 'DUP', weight: 'x' }), // would be first, but invalid
        good(2, { tracking_code: 'dup' }), // upper-normalized: same key, first valid -> wins
        good(3, { tracking_code: 'DUP' }),
        good(4, { tracking_code: 'DUP', qty: 'z' }), // duplicate AND bad cast: both reasons
      ]);
      const r = accounted(await run());
      expect(r).toMatchObject({ inserted: 1, rejected: 3 });
      const rej = await rejects(r.importId);
      expect(rej.map((x) => [x.source_row, x.reasons])).toEqual([
        [1, ['weight_kg: "x" is not a valid numeric', 'duplicate of source row 2 on (tracking_code)']],
        [3, ['duplicate of source row 2 on (tracking_code)']],
        [4, ['qty: "z" is not a valid integer', 'duplicate of source row 2 on (tracking_code)']],
      ]);
      expect(r.byReason.find((x) => x.column === 'tracking_code')).toEqual({
        column: 'tracking_code',
        reason: 'duplicate of an earlier source row',
        count: 3,
        sampleRows: [1, 3, 4],
      });
    });

    it('reject: a row already in the target is rejected with the target named', async () => {
      await setup([good(1, { tracking_code: 'OLD' }), good(2)]);
      await q(`insert into imp_shipments (tracking_code, customer_id) values ('OLD', 1)`);
      const r = accounted(await run());
      expect(r).toMatchObject({ inserted: 1, rejected: 1 });
      expect((await rejects(r.importId))[0]).toMatchObject({ source_row: 1, reasons: ['already exists in imp_shipments on (tracking_code)'] });
      expect(r.byReason).toEqual([{ column: 'tracking_code', reason: 'already exists in imp_shipments', count: 1, sampleRows: [1] }]);
    });

    it("skip: duplicates are counted as skippedDuplicates (not rejects); a duplicate with another problem is still a reject for THAT problem", async () => {
      await setup([
        good(1, { tracking_code: 'OLD' }), // exists in target -> skipped
        good(2, { tracking_code: 'NEW' }),
        good(3, { tracking_code: 'NEW' }), // in-source duplicate -> skipped
        good(4, { tracking_code: 'OLD', weight: 'x' }), // duplicate but also bad -> reject (own reason only)
      ]);
      await q(`insert into imp_shipments (tracking_code, customer_id) values ('OLD', 1)`);
      const r = accounted(await run({ onDuplicate: 'skip' }));
      expect(r).toMatchObject({ total: 4, inserted: 1, skippedDuplicates: 2, rejected: 1, updated: 0 });
      const rej = await rejects(r.importId);
      expect(rej).toHaveLength(1);
      expect(rej[0]).toMatchObject({ source_row: 4, reasons: ['weight_kg: "x" is not a valid numeric'] });
      expect(await q(`select count(*)::int as n from imp_shipments`)).toEqual([{ n: 2 }]);
    });

    it('update: existing rows are upserted (updated), new rows inserted, in-source duplicates still rejected', async () => {
      await setup([
        good(1, { tracking_code: 'OLD', weight: '99', status: 'lost' }),
        good(2, { tracking_code: 'NEW', weight: '5' }),
        good(3, { tracking_code: 'NEW', weight: '6' }),
      ]);
      await q(`insert into imp_shipments (tracking_code, customer_id, weight_kg) values ('OLD', 2, 1)`);
      const r = accounted(await run({ onDuplicate: 'update' }));
      expect(r).toMatchObject({ total: 3, inserted: 1, updated: 1, rejected: 1, skippedDuplicates: 0 });
      expect(await q(`select tracking_code, customer_id::int as c, weight_kg::text as w, status from imp_shipments order by id`)).toEqual([
        { tracking_code: 'OLD', c: 1, w: '99.00', status: 'lost' },
        { tracking_code: 'NEW', c: 1, w: '5.00', status: 'pending' },
      ]);
      expect((await rejects(r.importId))[0]).toMatchObject({ source_row: 3, reasons: ['duplicate of source row 2 on (tracking_code)'] });
    });
  });

  describe('spec errors throw before touching data, naming the bad name, what exists and the fix', () => {
    const expectSpecError = async (over: Partial<ImportSpec>, columns: Record<string, ColumnRule>, ...fragments: string[]) => {
      const err = await run(over, columns).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(ImportError);
      expect((err as ImportError).code).toBe('IMPORT_SPEC_INVALID');
      for (const f of fragments) expect((err as ImportError).message).toContain(f);
      expect((err as ImportError).fix.length).toBeGreaterThan(0);
      expect(await q(`select (select count(*)::int from imp_shipments) as s, (select count(*)::int from import_runs) as r, (select count(*)::int from import_rejects) as j`)).toEqual([{ s: 0, r: 0, j: 0 }]);
    };

    it('unknown staging column lists the staging columns', async () => {
      await setup([good(1)]);
      await expectSpecError({}, { weight_kg: rule({ from: 'wieght', type: 'numeric' }) }, '"wieght"', 'available:', 'tracking_code, customer_id, weight, status');
    });

    it('unknown target column lists the target columns', async () => {
      await setup([good(1)]);
      await expectSpecError({}, { wieght_kg: rule({ from: 'weight', type: 'numeric' }) }, '"wieght_kg"', 'available: id, tracking_code, customer_id, weight_kg');
    });

    it('unknown source table lists the tables in that schema', async () => {
      await setup([good(1)]);
      await expectSpecError({ source: 'staging.shipmnts' }, {}, 'staging.shipmnts', 'imp_shipments');
    });

    it('a bad identifier is refused by name, not interpolated', async () => {
      await setup([good(1)]);
      await expectSpecError({ target: 'imp_shipments; drop table imp_customers' }, {}, 'imp_shipments; drop table imp_customers');
      await expectSpecError({}, { weight_kg: rule({ from: 'weight" from x; --', type: 'numeric' }) }, 'from x; --');
      expect(await q(`select count(*)::int as n from imp_customers`)).toEqual([{ n: 2 }]);
    });

    it('lists every problem at once, plus key / type / update-needs-unique mistakes', async () => {
      await setup([good(1)]);
      await expectSpecError({ key: ['nope'], onDuplicate: 'update' }, {}, '"nope"', 'mapped: tracking_code, customer_id');
      await expectSpecError({}, { qty: rule({ from: 'qty', type: 'text' }) }, "rule type 'text' does not match imp_shipments.qty (int4)");
      await expectSpecError({ onDuplicate: 'update', key: ['customer_id'] }, {}, 'no plain unique index', '(customer_id)', 'found: (id) (tracking_code)');
    });
  });

  it('is atomic: a target constraint no rule covers aborts everything and the error says what to do', async () => {
    await setup(
      [good(1), good(2, { weight: '5000' }), good(3, { status: 'shipped' }), good(4)],
      `alter table imp_shipments add constraint weight_cap check (weight_kg < 1000)`,
    );
    const err = await run().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ImportError);
    const e = err as ImportError;
    expect(e.code).toBe('IMPORT_FAILED');
    expect(e.message).toContain('weight_cap');
    expect(e.message).toContain('rolled back');
    expect(e.fix).toContain('check: { sql, reason }');
    expect(await q(`select (select count(*)::int from imp_shipments) as s, (select count(*)::int from import_runs) as r, (select count(*)::int from import_rejects) as j`)).toEqual([{ s: 0, r: 0, j: 0 }]);
    // ...and once the rule exists the same data imports cleanly, with the cap violation as a reject.
    const r = await run({}, { weight_kg: rule({ from: 'weight', type: 'numeric', check: { sql: '$v > 0 and $v < 1000', reason: 'must be between 0 and 1000' } }) });
    expect(r).toMatchObject({ inserted: 2, rejected: 2 });
  });

  it('joins a caller transaction: rolling the caller back removes rows, rejects and the run', async () => {
    await setup([good(1), good(2, { weight: 'x' })]);
    const kysely = t.db!.db;
    let inside: ImportReport | undefined;
    await kysely
      .transaction()
      .execute(async (trx) => {
        inside = await importFromStaging(trx, spec());
        await importFromStaging(trx, spec({ importId: 'second-run', onDuplicate: 'skip' })); // two runs in one tx: temp tables don't collide
        throw new Error('caller rolls back');
      })
      .catch(() => undefined);
    expect(inside).toMatchObject({ inserted: 1, rejected: 1 });
    expect(await q(`select (select count(*)::int from imp_shipments) as s, (select count(*)::int from import_runs) as r`)).toEqual([{ s: 0, r: 0 }]);
  });

  it('refuses a reused importId (and says how to re-run)', async () => {
    await setup([good(1)]);
    await run({ importId: 'run-1' });
    await q(`delete from imp_shipments`);
    const err = await run({ importId: 'run-1' }).then(() => null, (e: unknown) => e as ImportError);
    expect(err).toMatchObject({ code: 'IMPORT_ID_TAKEN' });
    expect(err!.fix).toContain('delete from import_runs');
  });

  // "Set-based" is proven by counting statements, not by wall time: a timing bound in a parallel
  // suite measures machine load (2.8 s on a quiet host, 10.9 s with every layer in one container).
  // The statement count is deterministic; the generous ceiling only catches a quadratic plan.
  async function countedImport(rows: number) {
    await q(`insert into staging.imp_shipments
      select g, 'T' || g, (1 + g % 2)::text,
             case when g % 100 = 0 then 'bad' else ((g % 900) + 1)::text || '.5 kg' end,
             case when g % 250 = 0 then 'bogus' else 'Pending' end,
             '2026-01-' || lpad(((g % 28) + 1)::text, 2, '0'), '2026-02-01T00:00:00Z', (g % 7)::text
      from generate_series(1, ${rows}) g`);
    let statements = 0;
    const counting = t.db!.db.withPlugin({
      transformQuery: (a) => (statements++, a.node),
      transformResult: async (a) => a.result,
    });
    const t0 = performance.now();
    const report = accounted(await importFromStaging(counting, spec()));
    return { report, statements, ms: Math.round(performance.now() - t0) };
  }

  it('perf: the import is set-based (statement count independent of row count) and 50k rows stay far from quadratic', async () => {
    await setup();
    const small = await countedImport(500);
    await q(`truncate imp_shipments, staging.imp_shipments`);
    const big = await countedImport(50_000);
    console.log(`[import perf] 50000 rows -> inserted ${big.report.inserted}, rejected ${big.report.rejected} in ${big.ms} ms, ${big.statements} statements`);
    expect(big.statements, 'statements must not grow with rows (row-by-row work crept in)').toBe(small.statements);
    expect(big.ms).toBeLessThan(60_000);
    // bad weight every 100th (500) + bogus status every 250th (200) - both every 500th (100) = 600 rejected rows
    expect(big.report).toMatchObject({ total: 50000, inserted: 49400, rejected: 600 });
    expect(big.report.byReason.map((x) => [x.column, x.count])).toEqual([['weight_kg', 500], ['status', 200]]);
    expect(await q(`select count(*)::int as n from import_rejects where import_id = $1`, [big.report.importId])).toEqual([{ n: 600 }]);
  });
});
