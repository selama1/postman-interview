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

  type Row = Partial<Record<'isbn' | 'author_id' | 'price' | 'status' | 'published' | 'reviewed' | 'copies', string | null>>;
  const good = (n: number, over: Row = {}): Row => ({
    isbn: `ISBN${n}`,
    author_id: '1',
    price: '10',
    status: 'draft',
    published: '2026-01-02',
    reviewed: '2026-01-03T10:00:00Z',
    copies: '5',
    ...over,
  });

  async function setup(rows: Row[] = [], extraDdl = '') {
    await q(`create table imp_authors (id bigint primary key, name text not null)`);
    await q(`insert into imp_authors values (1, 'Ada'), (2, 'Grace')`);
    await q(`create table imp_books (
      id bigint generated always as identity primary key,
      isbn text not null unique,
      author_id bigint not null references imp_authors(id),
      price_usd numeric(10,2),
      status text not null default 'draft',
      published_on date,
      reviewed_at timestamptz,
      copies integer)`);
    await q(`create table staging.imp_books (_row bigint primary key, isbn text, author_id text, price text, status text, published text, reviewed text, copies text)`);
    if (extraDdl) await q(extraDdl);
    for (const [i, r] of rows.entries()) {
      await q(`insert into staging.imp_books values ($1,$2,$3,$4,$5,$6,$7,$8)`, [i + 1, r.isbn ?? null, r.author_id ?? null, r.price ?? null, r.status ?? null, r.published ?? null, r.reviewed ?? null, r.copies ?? null]);
    }
  }

  const rule = (r: ColumnRule) => r;
  const spec = (over: Partial<ImportSpec> = {}, columns: Record<string, ColumnRule> = {}): ImportSpec => ({
    source: 'staging.imp_books',
    target: 'imp_books',
    key: ['isbn'],
    columns: {
      isbn: rule({ from: 'isbn', type: 'text', required: true, normalize: 'upper' }),
      author_id: rule({ from: 'author_id', type: 'bigint', required: true, ref: { table: 'imp_authors', column: 'id' } }),
      price_usd: rule({ from: 'price', type: 'numeric', normalize: 'number', check: { sql: '$v > 0', reason: 'must be positive' } }),
      status: rule({ from: 'status', type: 'text', normalize: 'lower', oneOf: ['draft', 'in_review', 'published', 'out_of_print'], default: "'draft'" }),
      published_on: rule({ from: 'published', type: 'date' }),
      reviewed_at: rule({ from: 'reviewed', type: 'timestamptz' }),
      copies: rule({ from: 'copies', type: 'integer' }),
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
    await setup([good(1), good(2, { isbn: ' isbn2 ', price: '1,234.5 USD', status: 'PUBLISHED' })]);
    const r = accounted(await run());
    expect(r).toMatchObject({ total: 2, inserted: 2, updated: 0, rejected: 0, skippedDuplicates: 0, byReason: [] });
    const rows = await q(`select isbn, price_usd::text, status, published_on::text, reviewed_at is not null as d, copies from imp_books order by id`);
    expect(rows).toEqual([
      { isbn: 'ISBN1', price_usd: '10.00', status: 'draft', published_on: '2026-01-02', d: true, copies: 5 },
      { isbn: 'ISBN2', price_usd: '1234.50', status: 'published', published_on: '2026-01-02', d: true, copies: 5 },
    ]);
    expect(await rejects(r.importId)).toEqual([]);
    const [run1] = await q(`select inserted, rejected, total from import_runs where import_id = $1`, [r.importId]);
    expect(run1).toEqual({ inserted: 2, rejected: 0, total: 2 });
  });

  // One case per failure class: [label, overrides, column, reason template, reason text].
  const classes: Array<[string, Row, string, string, string]> = [
    ['numeric cast', { price: '12,5USD' }, 'price_usd', 'is not a valid numeric', 'price_usd: "12,5USD" is not a valid numeric'],
    ['numeric unit-only', { price: 'USD' }, 'price_usd', 'is not a valid numeric', 'price_usd: "USD" is not a valid numeric'],
    ['numeric NaN', { price: 'NaN' }, 'price_usd', 'is not a valid numeric', 'price_usd: "NaN" is not a valid numeric'],
    ['date cast', { published: '2026-13-45' }, 'published_on', 'is not a valid date', 'published_on: "2026-13-45" is not a valid date'],
    ['date special word', { published: 'today' }, 'published_on', 'is not a valid date', 'published_on: "today" is not a valid date'],
    ['timestamptz cast', { reviewed: 'yesterday-ish' }, 'reviewed_at', 'is not a valid timestamptz', 'reviewed_at: "yesterday-ish" is not a valid timestamptz'],
    ['integer cast', { copies: '2.5' }, 'copies', 'is not a valid integer', 'copies: "2.5" is not a valid integer'],
    ['required blank', { isbn: '   ' }, 'isbn', 'required', 'isbn: required'],
    ['required null', { author_id: null }, 'author_id', 'required', 'author_id: required'],
    ['oneOf', { status: 'printed' }, 'status', 'not in (draft|in_review|published|out_of_print)', 'status: "printed" not in (draft|in_review|published|out_of_print)'],
    ['check', { price: '-3' }, 'price_usd', 'must be positive', 'price_usd: must be positive (got "-3")'],
    ['missing ref', { author_id: '99' }, 'author_id', 'no matching imp_authors.id', 'author_id: no imp_authors.id = 99'],
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
    expect(await q(`select count(*)::int as n from imp_books`)).toEqual([{ n: 2 }]);
  });

  it('a row with two problems gets BOTH reasons; the report counts it under each', async () => {
    await setup([good(1), good(2, { price: 'x', status: 'printed', author_id: '99' }), good(3, { price: 'y' })]);
    const r = await run();
    const rej = await rejects(r.importId);
    expect(rej.map((x) => x.source_row)).toEqual([2, 3]);
    expect(rej[0]!.reasons).toEqual([
      'author_id: no imp_authors.id = 99',
      'price_usd: "x" is not a valid numeric',
      'status: "printed" not in (draft|in_review|published|out_of_print)',
    ]);
    const price = r.byReason.find((x) => x.reason === 'is not a valid numeric');
    expect(price).toEqual({ column: 'price_usd', reason: 'is not a valid numeric', count: 2, sampleRows: [2, 3] });
    expect(r.byReason[0]!.count).toBe(2); // sorted by count desc
    expect(r.rejected).toBe(2);
  });

  it('normalize number: "1,234.5 USD" -> 1234.5, spaces and %, but "12,5" is rejected not guessed', async () => {
    await setup([
      good(1, { price: '1,234.5 USD' }),
      good(2, { price: ' 1 234.5USD ' }),
      good(3, { price: '-7.25 USD' }),
      good(4, { price: '12,5' }),
      good(5, { price: '1,23,4' }),
    ]);
    const r = await run({}, { price_usd: rule({ from: 'price', type: 'numeric', normalize: 'number' }) });
    expect((await q(`select isbn, price_usd::text as w from imp_books order by id`))).toEqual([
      { isbn: 'ISBN1', w: '1234.50' },
      { isbn: 'ISBN2', w: '1234.50' },
      { isbn: 'ISBN3', w: '-7.25' },
    ]);
    expect(r.byReason).toEqual([{ column: 'price_usd', reason: 'is not a valid numeric', count: 2, sampleRows: [4, 5] }]);
  });

  it('dateOrder decides ambiguous dates explicitly; 13/02/2026 is invalid as MDY, valid as DMY', async () => {
    await setup([good(1, { published: '01/02/2026' }), good(2, { published: '13/02/2026' })]);
    const mdy = await run();
    expect(mdy.byReason).toEqual([{ column: 'published_on', reason: 'is not a valid date', count: 1, sampleRows: [2] }]);
    expect(await q(`select published_on::text as d from imp_books`)).toEqual([{ d: '2026-01-02' }]);
    await q(`delete from imp_books`);
    const dmy = await run({ dateOrder: 'DMY' });
    expect(dmy).toMatchObject({ inserted: 2, rejected: 0 });
    expect(await q(`select published_on::text as d from imp_books order by id`)).toEqual([{ d: '2026-02-01' }, { d: '2026-02-13' }]);
  });

  describe('duplicates on the natural key', () => {
    it('reject: later in-source duplicates name the winning row; the winner is the first row that passes every other rule', async () => {
      await setup([
        good(1, { isbn: 'DUP', price: 'x' }), // would be first, but invalid
        good(2, { isbn: 'dup' }), // upper-normalized: same key, first valid -> wins
        good(3, { isbn: 'DUP' }),
        good(4, { isbn: 'DUP', copies: 'z' }), // duplicate AND bad cast: both reasons
      ]);
      const r = accounted(await run());
      expect(r).toMatchObject({ inserted: 1, rejected: 3 });
      const rej = await rejects(r.importId);
      expect(rej.map((x) => [x.source_row, x.reasons])).toEqual([
        [1, ['price_usd: "x" is not a valid numeric', 'duplicate of source row 2 on (isbn)']],
        [3, ['duplicate of source row 2 on (isbn)']],
        [4, ['copies: "z" is not a valid integer', 'duplicate of source row 2 on (isbn)']],
      ]);
      expect(r.byReason.find((x) => x.column === 'isbn')).toEqual({
        column: 'isbn',
        reason: 'duplicate of an earlier source row',
        count: 3,
        sampleRows: [1, 3, 4],
      });
    });

    it('reject: a row already in the target is rejected with the target named', async () => {
      await setup([good(1, { isbn: 'OLD' }), good(2)]);
      await q(`insert into imp_books (isbn, author_id) values ('OLD', 1)`);
      const r = accounted(await run());
      expect(r).toMatchObject({ inserted: 1, rejected: 1 });
      expect((await rejects(r.importId))[0]).toMatchObject({ source_row: 1, reasons: ['already exists in imp_books on (isbn)'] });
      expect(r.byReason).toEqual([{ column: 'isbn', reason: 'already exists in imp_books', count: 1, sampleRows: [1] }]);
    });

    it("skip: duplicates are counted as skippedDuplicates (not rejects); a duplicate with another problem is still a reject for THAT problem", async () => {
      await setup([
        good(1, { isbn: 'OLD' }), // exists in target -> skipped
        good(2, { isbn: 'NEW' }),
        good(3, { isbn: 'NEW' }), // in-source duplicate -> skipped
        good(4, { isbn: 'OLD', price: 'x' }), // duplicate but also bad -> reject (own reason only)
      ]);
      await q(`insert into imp_books (isbn, author_id) values ('OLD', 1)`);
      const r = accounted(await run({ onDuplicate: 'skip' }));
      expect(r).toMatchObject({ total: 4, inserted: 1, skippedDuplicates: 2, rejected: 1, updated: 0 });
      const rej = await rejects(r.importId);
      expect(rej).toHaveLength(1);
      expect(rej[0]).toMatchObject({ source_row: 4, reasons: ['price_usd: "x" is not a valid numeric'] });
      expect(await q(`select count(*)::int as n from imp_books`)).toEqual([{ n: 2 }]);
    });

    it('update: existing rows are upserted (updated), new rows inserted, in-source duplicates still rejected', async () => {
      await setup([
        good(1, { isbn: 'OLD', price: '99', status: 'out_of_print' }),
        good(2, { isbn: 'NEW', price: '5' }),
        good(3, { isbn: 'NEW', price: '6' }),
      ]);
      await q(`insert into imp_books (isbn, author_id, price_usd) values ('OLD', 2, 1)`);
      const r = accounted(await run({ onDuplicate: 'update' }));
      expect(r).toMatchObject({ total: 3, inserted: 1, updated: 1, rejected: 1, skippedDuplicates: 0 });
      expect(await q(`select isbn, author_id::int as c, price_usd::text as w, status from imp_books order by id`)).toEqual([
        { isbn: 'OLD', c: 1, w: '99.00', status: 'out_of_print' },
        { isbn: 'NEW', c: 1, w: '5.00', status: 'draft' },
      ]);
      expect((await rejects(r.importId))[0]).toMatchObject({ source_row: 3, reasons: ['duplicate of source row 2 on (isbn)'] });
    });
  });

  it('rowChecks: a cross-column rule rejects rows where it is false, with CHECK semantics (NULL passes)', async () => {
    await setup([
      good(1), // reviewed 2026-01-03 after published 2026-01-02: ok
      good(2, { published: '2026-02-01' }), // reviewed before published: rejected
      good(3, { published: null }), // rule is NULL: passes, like a DB CHECK
      good(4, { published: '2026-02-01', price: '-5' }), // two reasons: column rule + row rule
    ]);
    const r = accounted(await run({ rowChecks: [{ sql: '$reviewed_at >= $published_on', reason: 'reviewed before published' }] }));
    expect(r).toMatchObject({ total: 4, inserted: 2, rejected: 2 });
    expect(r.byReason).toContainEqual({ column: 'row', reason: 'reviewed before published', count: 2, sampleRows: [2, 4] });
    expect((await rejects(r.importId)).map((x) => [x.source_row, x.reasons])).toEqual([
      [2, ['row: reviewed before published']],
      [4, ['price_usd: must be positive (got "-5")', 'row: reviewed before published']],
    ]);
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
      expect(await q(`select (select count(*)::int from imp_books) as s, (select count(*)::int from import_runs) as r, (select count(*)::int from import_rejects) as j`)).toEqual([{ s: 0, r: 0, j: 0 }]);
    };

    it('rowChecks naming an unmapped column lists the mapped ones', async () => {
      await setup([good(1)]);
      await expectSpecError({ rowChecks: [{ sql: '$reviewed_at >= $printed_on', reason: 'reviewed before printed' }] }, {}, '$printed_on', 'not a mapped column', 'published_on');
    });

    it('unknown staging column lists the staging columns', async () => {
      await setup([good(1)]);
      await expectSpecError({}, { price_usd: rule({ from: 'pirce', type: 'numeric' }) }, '"pirce"', 'available:', 'isbn, author_id, price, status');
    });

    it('unknown target column lists the target columns', async () => {
      await setup([good(1)]);
      await expectSpecError({}, { pirce_usd: rule({ from: 'price', type: 'numeric' }) }, '"pirce_usd"', 'available: id, isbn, author_id, price_usd');
    });

    it('unknown source table lists the tables in that schema', async () => {
      await setup([good(1)]);
      await expectSpecError({ source: 'staging.shipmnts' }, {}, 'staging.shipmnts', 'imp_books');
    });

    it('a bad identifier is refused by name, not interpolated', async () => {
      await setup([good(1)]);
      await expectSpecError({ target: 'imp_books; drop table imp_authors' }, {}, 'imp_books; drop table imp_authors');
      await expectSpecError({}, { price_usd: rule({ from: 'price" from x; --', type: 'numeric' }) }, 'from x; --');
      expect(await q(`select count(*)::int as n from imp_authors`)).toEqual([{ n: 2 }]);
    });

    it('lists every problem at once, plus key / type / update-needs-unique mistakes', async () => {
      await setup([good(1)]);
      await expectSpecError({ key: ['nope'], onDuplicate: 'update' }, {}, '"nope"', 'mapped: isbn, author_id');
      await expectSpecError({}, { copies: rule({ from: 'copies', type: 'text' }) }, "rule type 'text' does not match imp_books.copies (int4)");
      await expectSpecError({ onDuplicate: 'update', key: ['author_id'] }, {}, 'no plain unique index', '(author_id)', 'found: (id) (isbn)');
    });
  });

  it('is atomic: a target constraint no rule covers aborts everything and the error says what to do', async () => {
    await setup(
      [good(1), good(2, { price: '5000' }), good(3, { status: 'printed' }), good(4)],
      `alter table imp_books add constraint price_cap check (price_usd < 1000)`,
    );
    const err = await run().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ImportError);
    const e = err as ImportError;
    expect(e.code).toBe('IMPORT_FAILED');
    expect(e.message).toContain('price_cap');
    expect(e.message).toContain('rolled back');
    expect(e.fix).toContain('check: { sql, reason }');
    expect(await q(`select (select count(*)::int from imp_books) as s, (select count(*)::int from import_runs) as r, (select count(*)::int from import_rejects) as j`)).toEqual([{ s: 0, r: 0, j: 0 }]);
    // ...and once the rule exists the same data imports cleanly, with the cap violation as a reject.
    const r = await run({}, { price_usd: rule({ from: 'price', type: 'numeric', check: { sql: '$v > 0 and $v < 1000', reason: 'must be between 0 and 1000' } }) });
    expect(r).toMatchObject({ inserted: 2, rejected: 2 });
  });

  it('joins a caller transaction: rolling the caller back removes rows, rejects and the run', async () => {
    await setup([good(1), good(2, { price: 'x' })]);
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
    expect(await q(`select (select count(*)::int from imp_books) as s, (select count(*)::int from import_runs) as r`)).toEqual([{ s: 0, r: 0 }]);
  });

  it('refuses a reused importId (and says how to re-run)', async () => {
    await setup([good(1)]);
    await run({ importId: 'run-1' });
    await q(`delete from imp_books`);
    const err = await run({ importId: 'run-1' }).then(() => null, (e: unknown) => e as ImportError);
    expect(err).toMatchObject({ code: 'IMPORT_ID_TAKEN' });
    expect(err!.fix).toContain('delete from import_runs');
  });

  // "Set-based" is proven by counting statements, not by wall time: a timing bound in a parallel
  // suite measures machine load (2.8 s on a quiet host, 10.9 s with every layer in one container).
  // The statement count is deterministic; the generous ceiling only catches a quadratic plan.
  async function countedImport(rows: number) {
    await q(`insert into staging.imp_books
      select g, 'I' || g, (1 + g % 2)::text,
             case when g % 100 = 0 then 'bad' else ((g % 900) + 1)::text || '.5 USD' end,
             case when g % 250 = 0 then 'bogus' else 'Draft' end,
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
    await q(`truncate imp_books, staging.imp_books`);
    const big = await countedImport(50_000);
    console.log(`[import perf] 50000 rows -> inserted ${big.report.inserted}, rejected ${big.report.rejected} in ${big.ms} ms, ${big.statements} statements`);
    expect(big.statements, 'statements must not grow with rows (row-by-row work crept in)').toBe(small.statements);
    expect(big.ms).toBeLessThan(60_000);
    // bad price every 100th (500) + bogus status every 250th (200) - both every 500th (100) = 600 rejected rows
    expect(big.report).toMatchObject({ total: 50000, inserted: 49400, rejected: 600 });
    expect(big.report.byReason.map((x) => [x.column, x.count])).toEqual([['price_usd', 500], ['status', 200]]);
    expect(await q(`select count(*)::int as n from import_rejects where import_id = $1`, [big.report.importId])).toEqual([{ n: 600 }]);
  });
});
