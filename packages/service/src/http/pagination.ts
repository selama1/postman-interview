import { sql, type SelectQueryBuilder } from 'kysely';
import { z } from 'zod';
import { badRequest } from './errors.js';

/**
 * Pagination. Two strategies — pick per endpoint, and say why (it's a classic tradeoff):
 *
 * KEYSET (default for anything that can grow): `?limit=50&cursor=<opaque>`
 *   + O(limit) per page at any depth, stable under concurrent inserts, no skipped/duplicated rows
 *   - no random page access, no cheap total; sort columns must be NOT NULL + a unique tiebreaker (id)
 *   - needs an index on (sortCol, id) to be fast
 *
 * OFFSET: `?limit=50&offset=100`
 *   + simple, random access, natural with `total`
 *   - O(offset) — slow deep pages; rows shift under concurrent writes (skips/dupes)
 *
 * List response envelope (all list endpoints): { items: T[], nextCursor: string | null, total?: number }
 */

export const MAX_LIMIT = 200;

export const KeysetQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(50),
  cursor: z.string().min(1).optional(),
});

export const OffsetQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const pageSchema = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), nextCursor: z.string().nullable(), total: z.number().int().optional() });

type CursorValue = string | number | boolean | null;
interface CursorPayload {
  v: CursorValue[]; // sort values then id
  s: string; // sort signature: cursor is only valid for the same sort
}

export function encodeCursor(values: unknown[], sortSig: string): string {
  const v = values.map((x) => (x instanceof Date ? x.toISOString() : (x as CursorValue)));
  return Buffer.from(JSON.stringify({ v, s: sortSig } satisfies CursorPayload)).toString('base64url');
}

export function decodeCursor(cursor: string, sortSig: string): CursorValue[] {
  let payload: CursorPayload;
  try {
    payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as CursorPayload;
  } catch {
    throw badRequest('INVALID_CURSOR', 'cursor is not a valid page cursor', 'Pass the `nextCursor` value from the previous page unchanged.');
  }
  if (!Array.isArray(payload.v) || payload.s !== sortSig) {
    throw badRequest('INVALID_CURSOR', 'cursor does not match this query\'s sort order', 'Restart from the first page when you change `sort`.');
  }
  return payload.v;
}

export interface KeysetOptions {
  /** Sort columns as SQL references, e.g. [{ col: 's.created_at', dir: 'desc' }]. Must be NOT NULL. */
  sort: Array<{ col: string; dir: 'asc' | 'desc' }>;
  /** Unique tiebreaker column reference, e.g. 's.id'. */
  id: string;
  limit: number;
  cursor?: string | undefined;
}

const sig = (o: KeysetOptions) => [...o.sort.map((s) => `${s.col}:${s.dir}`), o.id].join(',');

/**
 * Apply keyset WHERE + ORDER BY + LIMIT(limit + 1). Pair with `keysetResult`.
 * Mixed directions are supported via an expanded OR chain; uniform direction uses a row
 * comparison `(a, b, id) > ($1, $2, $3)` that Postgres can satisfy from a composite index.
 */
export function keysetPage<QB extends SelectQueryBuilder<any, any, any>>(qb: QB, o: KeysetOptions): QB {
  const cols = [...o.sort, { col: o.id, dir: o.sort.at(-1)?.dir ?? 'asc' as const }];
  let q = qb;
  if (o.cursor) {
    const vals = decodeCursor(o.cursor, sig(o));
    if (vals.length !== cols.length) {
      throw badRequest('INVALID_CURSOR', 'cursor shape does not match the sort', 'Restart from the first page.');
    }
    const uniform = cols.every((c) => c.dir === cols[0]!.dir);
    if (uniform) {
      const op = cols[0]!.dir === 'asc' ? sql`>` : sql`<`;
      const lhs = sql.join(cols.map((c) => sql.ref(c.col)));
      const rhs = sql.join(vals.map((v) => sql`${v}`));
      q = q.where(sql<boolean>`(${lhs}) ${op} (${rhs})`) as QB;
    } else {
      // (a > va) OR (a = va AND b < vb) OR (a = va AND b = vb AND id > vid) ...
      const ors = cols.map((c, i) => {
        const eqs = cols.slice(0, i).map((p, j) => sql`${sql.ref(p.col)} = ${vals[j]}`);
        const cmp = sql`${sql.ref(c.col)} ${c.dir === 'asc' ? sql`>` : sql`<`} ${vals[i]}`;
        return sql`(${sql.join([...eqs, cmp], sql` AND `)})`;
      });
      q = q.where(sql<boolean>`(${sql.join(ors, sql` OR `)})`) as QB;
    }
  }
  for (const c of cols) q = q.orderBy(sql.ref(c.col), c.dir) as QB;
  return q.limit(o.limit + 1) as QB;
}

/**
 * Trim the extra row and build nextCursor. `key(row)` returns the row's values for the sort
 * columns then the id, in the same order as KeysetOptions.sort + id.
 */
export function keysetResult<T>(rows: T[], o: KeysetOptions, key: (row: T) => unknown[]) {
  const hasMore = rows.length > o.limit;
  const items = hasMore ? rows.slice(0, o.limit) : rows;
  const last = items.at(-1);
  return { items, nextCursor: hasMore && last !== undefined ? encodeCursor(key(last), sig(o)) : null };
}
