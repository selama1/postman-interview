import { z } from 'zod';
import { badRequest } from './errors.js';

/**
 * Query-string helpers. Filters are explicit per endpoint (a zod object per route) — no
 * generic "filter anything" DSL: explicit filters are documented in OpenAPI, indexable and safe.
 */

/** `?sort=-created_at,name` against an allowlist mapping API field -> SQL column ref. */
export function parseSort(
  raw: string | undefined,
  allowed: Record<string, string>,
  fallback: string,
): Array<{ field: string; col: string; dir: 'asc' | 'desc' }> {
  const spec = (raw ?? fallback).split(',').map((s) => s.trim()).filter(Boolean);
  return spec.map((s) => {
    const dir = s.startsWith('-') ? ('desc' as const) : ('asc' as const);
    const field = s.replace(/^[-+]/, '');
    const col = allowed[field];
    if (!col) {
      throw badRequest('INVALID_SORT', `cannot sort by "${field}"`, `Use one of: ${Object.keys(allowed).join(', ')} (prefix with - for descending).`);
    }
    return { field, col, dir };
  });
}

/** `?status=a,b` or repeated `?status=a&status=b` -> string[] (optionally restricted to `allowed`). */
export const csvList = (allowed?: readonly [string, ...string[]]) =>
  z
    .union([z.string(), z.array(z.string())])
    .transform((v) => (Array.isArray(v) ? v : v.split(',')).map((s) => s.trim()).filter(Boolean))
    .pipe(z.array(allowed ? z.enum(allowed) : z.string()));

/** ISO date/datetime query param -> Date */
export const isoDate = z.iso.datetime({ offset: true }).or(z.iso.date()).transform((s) => new Date(s));

/** Inclusive-from / exclusive-to range. Validates from < to. */
export const dateRange = z
  .object({ from: isoDate.optional(), to: isoDate.optional() })
  .refine((r) => !r.from || !r.to || r.from < r.to, { message: '`from` must be before `to`', path: ['from'] });

/** Escape user input for LIKE/ILIKE patterns. */
export const likeEscape = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);
