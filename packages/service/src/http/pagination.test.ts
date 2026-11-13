import { describe, expect, it } from 'vitest';
import { AppError } from './errors.js';
import { decodeCursor, encodeCursor, keysetResult } from './pagination.js';

describe('cursor', () => {
  it('round-trips values (dates become ISO strings)', () => {
    const d = new Date('2026-01-02T03:04:05.678Z');
    expect(decodeCursor(encodeCursor([d, 'x', 7], 'sig'), 'sig')).toEqual([d.toISOString(), 'x', 7]);
  });

  it('rejects garbage and cursors from a different sort, with a fix', () => {
    expect(() => decodeCursor('%%%', 'sig')).toThrow(AppError);
    const c = encodeCursor([1], 'a');
    try {
      decodeCursor(c, 'b');
      expect.unreachable();
    } catch (e) {
      expect((e as AppError).code).toBe('INVALID_CURSOR');
      expect((e as AppError).fix).toMatch(/first page/);
    }
  });
});

describe('keysetResult', () => {
  const o = { sort: [{ col: 'n', dir: 'asc' as const }], id: 'id', limit: 2 };
  it('trims the probe row and emits a cursor only when there is more', () => {
    const more = keysetResult([{ n: 1, id: 1 }, { n: 2, id: 2 }, { n: 3, id: 3 }], o, (r) => [r.n, r.id]);
    expect(more.items).toHaveLength(2);
    expect(more.nextCursor).not.toBeNull();
    const last = keysetResult([{ n: 1, id: 1 }], o, (r) => [r.n, r.id]);
    expect(last.nextCursor).toBeNull();
  });
});
