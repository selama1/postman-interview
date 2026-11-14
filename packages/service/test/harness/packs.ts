import { describe, expect, it } from 'vitest';
import type { TestClient, TestResponse } from './client.js';
import { useTarget, type Target, type TestServerOptions } from './server.js';
import { MAX_LIMIT } from '../../src/http/pagination.js';

/**
 * Contract packs: generic, data-independent behaviour every resource should have. Each pack
 * defines a describe() block of real HTTP tests against a fresh DB per test.
 *
 *   crudContract({ name: 'book', path: '/books', make: (i) => ({ ... }), patch: () => ({ ... }) });
 *   validationContract({ path: '/books', valid: {...}, cases: [{ name: 'negative price', body: {...}, field: 'priceUsd' }] });
 *   paginationContract({ path: '/books', make: (i) => ({...}), sorts: [{ sort: '-createdAt', compare: ... }] });
 *   uniqueRaceContract({ path: '/authors', make: () => ({ email: 'same@x' }) });
 *
 * They are a floor, not the spec: business rules still get their own repro-first tests.
 */

type Body = Record<string, unknown>;
const idOfDefault = (b: unknown) => (b as { id: string | number }).id;

export async function seed(client: TestClient, path: string, make: (i: number) => Body, n: number, concurrency = 8) {
  const out: Body[] = [];
  for (let i = 0; i < n; i += concurrency) {
    const batch = await Promise.all(
      Array.from({ length: Math.min(concurrency, n - i) }, (_, j) => client.post<Body>(path, make(i + j))),
    );
    for (const r of batch) {
      expect(r).toHaveStatus(201);
      out.push(r.body);
    }
  }
  return out;
}

export async function walkPages(client: TestClient, path: string, query: Record<string, string | number> = {}) {
  const pages: Body[][] = [];
  let cursor: string | null = null;
  for (let guard = 0; guard < 1000; guard++) {
    const res: TestResponse<{ items: Body[]; nextCursor: string | null }> = await client.get(path, { ...query, ...(cursor ? { cursor } : {}) });
    expect(res).toHaveStatus(200);
    pages.push(res.body.items);
    cursor = res.body.nextCursor;
    if (!cursor) return pages;
  }
  throw new Error('pagination did not terminate after 1000 pages');
}

export interface CrudSpec {
  name: string;
  path: string;
  make: (i: number) => Body;
  patch?: (i: number) => Body;
  idOf?: (body: unknown) => string | number;
  /** An id that is well-formed but does not exist. */
  missingId?: string | number;
  /** A malformed id (expects 400). Omit if ids are free-form strings. */
  invalidId?: string;
  /** Fields of the input that are NOT echoed back as-is (e.g. secrets, normalized values). */
  notEchoed?: string[];
  server?: TestServerOptions;
}

const echoed = (input: Body, skip: string[] = []) => Object.fromEntries(Object.entries(input).filter(([k]) => !skip.includes(k)));

export function crudContract(spec: CrudSpec) {
  const idOf = spec.idOf ?? idOfDefault;
  describe(`${spec.name} CRUD contract (${spec.path})`, () => {
    const t: Target = useTarget(spec.server);

    it('POST creates and echoes the resource with an id', async () => {
      const input = spec.make(1);
      const res = await t.client.post(spec.path, input);
      expect(res).toHaveStatus(201);
      expect(res.body).toMatchObject(echoed(input, spec.notEchoed));
      expect(idOf(res.body)).toBeDefined();
    });

    it('GET /:id returns exactly what POST created', async () => {
      const created = await t.client.post(spec.path, spec.make(2));
      expect(created).toHaveStatus(201);
      const res = await t.client.get(`${spec.path}/${idOf(created.body)}`);
      expect(res).toHaveStatus(200);
      expect(res.body).toEqual(created.body);
    });

    it('GET /:id for a missing id is a 404 problem', async () => {
      const res = await t.client.get(`${spec.path}/${spec.missingId ?? 2147483646}`);
      expect(res).toBeProblem(404, 'NOT_FOUND');
    });

    if (spec.invalidId !== undefined) {
      it('GET /:id with a malformed id is a 400 problem (not a 500)', async () => {
        const res = await t.client.get(`${spec.path}/${spec.invalidId}`);
        expect(res).toBeProblem(400);
      });
    }

    it('list includes a created resource', async () => {
      const created = await t.client.post(spec.path, spec.make(3));
      expect(created).toHaveStatus(201);
      const ids = (await walkPages(t.client, spec.path, { limit: MAX_LIMIT })).flat().map(idOf);
      expect(ids).toContain(idOf(created.body));
    });

    if (spec.patch) {
      const patch = spec.patch;
      it('PATCH updates the given fields and persists', async () => {
        const created = await t.client.post(spec.path, spec.make(4));
        const p = patch(4);
        const res = await t.client.patch(`${spec.path}/${idOf(created.body)}`, p);
        expect(res).toHaveStatus(200);
        expect(res.body).toMatchObject(echoed(p, spec.notEchoed));
        const again = await t.client.get(`${spec.path}/${idOf(created.body)}`);
        expect(again.body).toMatchObject(echoed(p, spec.notEchoed));
      });

      it('PATCH on a missing id is a 404 problem', async () => {
        const res = await t.client.patch(`${spec.path}/${spec.missingId ?? 2147483646}`, patch(5));
        expect(res).toBeProblem(404, 'NOT_FOUND');
      });
    }

    it('DELETE removes it (204), then GET and DELETE are 404', async () => {
      const created = await t.client.post(spec.path, spec.make(6));
      const id = idOf(created.body);
      expect(await t.client.delete(`${spec.path}/${id}`)).toHaveStatus(204);
      expect(await t.client.get(`${spec.path}/${id}`)).toBeProblem(404, 'NOT_FOUND');
      expect(await t.client.delete(`${spec.path}/${id}`)).toBeProblem(404, 'NOT_FOUND');
    });
  });
}

export interface ValidationSpec {
  path: string;
  method?: 'POST' | 'PUT' | 'PATCH';
  valid: Body;
  cases: Array<{ name: string; body: unknown; field: string }>;
  server?: TestServerOptions;
}

export function validationContract(spec: ValidationSpec) {
  const method = spec.method ?? 'POST';
  describe(`validation contract (${method} ${spec.path})`, () => {
    const t = useTarget(spec.server);

    it('accepts the valid body', async () => {
      expect(await t.client.request({ method, path: spec.path, body: spec.valid })).toHaveStatus([200, 201]);
    });

    it('rejects malformed JSON with a 400 problem', async () => {
      const res = await t.client.request({ method, path: spec.path, body: '{"oops":', headers: { 'content-type': 'application/json' } });
      expect(res).toBeProblem(400);
    });

    for (const c of spec.cases) {
      it(`rejects ${c.name} -> 400 VALIDATION_FAILED naming "${c.field}"`, async () => {
        const res = await t.client.request({ method, path: spec.path, body: c.body });
        expect(res).toBeProblem(400, 'VALIDATION_FAILED');
        const paths = ((res.body as { errors?: Array<{ path: string }> }).errors ?? []).map((e) => e.path);
        expect(paths.some((p) => p.includes(c.field)), `errors[].path ${JSON.stringify(paths)} should mention ${c.field}`).toBe(true);
      });
    }
  });
}

export interface PaginationSpec {
  path: string;
  make: (i: number) => Body;
  count?: number;
  limit?: number;
  idOf?: (b: unknown) => string | number;
  /** Sort param values to verify, each with a comparator over response items. */
  sorts?: Array<{ sort: string; compare: (a: Body, b: Body) => number }>;
  server?: TestServerOptions;
}

export function paginationContract(spec: PaginationSpec) {
  const idOf = spec.idOf ?? idOfDefault;
  const count = spec.count ?? 23;
  const limit = spec.limit ?? 5;
  describe(`pagination contract (${spec.path})`, () => {
    const t = useTarget(spec.server);

    it(`walks ${count} rows in pages of ${limit}: every row exactly once, no page over limit`, async () => {
      if (!t.isolated) return; // needs an empty table: integration only
      const created = await seed(t.client, spec.path, spec.make, count);
      const pages = await walkPages(t.client, spec.path, { limit });
      for (const p of pages) expect(p.length).toBeLessThanOrEqual(limit);
      const ids = pages.flat().map(idOf);
      expect(new Set(ids).size, 'duplicates across pages').toBe(ids.length);
      expect([...ids].sort()).toEqual(created.map(idOf).sort());
      expect(pages.length).toBe(Math.ceil(count / limit));
    });

    for (const s of spec.sorts ?? []) {
      it(`sort=${s.sort} is honoured across page boundaries`, async () => {
        if (!t.isolated) return;
        await seed(t.client, spec.path, spec.make, count);
        const items = (await walkPages(t.client, spec.path, { limit, sort: s.sort })).flat();
        expect(items.length).toBe(count);
        for (let i = 1; i < items.length; i++) {
          expect(s.compare(items[i - 1]!, items[i]!), `items ${i - 1},${i} out of order for sort=${s.sort}`).toBeLessThanOrEqual(0);
        }
      });
    }

    it('rejects a garbage cursor with 400 INVALID_CURSOR', async () => {
      expect(await t.client.get(spec.path, { cursor: 'not-a-cursor' })).toBeProblem(400, 'INVALID_CURSOR');
    });

    it(`rejects limit=0 and limit=${MAX_LIMIT + 1} with 400`, async () => {
      expect(await t.client.get(spec.path, { limit: 0 })).toBeProblem(400, 'VALIDATION_FAILED');
      expect(await t.client.get(spec.path, { limit: MAX_LIMIT + 1 })).toBeProblem(400, 'VALIDATION_FAILED');
    });
  });
}

export interface UniqueRaceSpec {
  path: string;
  /** Returns the SAME unique value every call. */
  make: () => Body;
  n?: number;
  server?: TestServerOptions;
}

/** N concurrent creates of the same unique value: exactly one 201, the rest 409 (never 500). */
export function uniqueRaceContract(spec: UniqueRaceSpec) {
  describe(`unique-race contract (${spec.path})`, () => {
    const t = useTarget(spec.server);
    it(`${spec.n ?? 10} concurrent duplicate creates -> one 201, rest 409 CONFLICT`, async () => {
      const body = spec.make();
      const results = await Promise.all(Array.from({ length: spec.n ?? 10 }, () => t.client.post(spec.path, body)));
      const statuses = results.map((r) => r.status).sort();
      expect(statuses.filter((s) => s === 201).length, `statuses: ${statuses.join(',')}`).toBe(1);
      for (const r of results.filter((x) => x.status !== 201)) expect(r).toBeProblem(409, 'CONFLICT');
    });
  });
}

/** Fire n concurrent calls; returns results in completion-independent order. */
export const race = <T>(n: number, fn: (i: number) => Promise<T>) => Promise.all(Array.from({ length: n }, (_, i) => fn(i)));
