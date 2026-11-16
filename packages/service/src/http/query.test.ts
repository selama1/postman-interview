import { describe, expect, it } from 'vitest';
import { AppError } from './errors.js';
import { parseSort } from './query.js';

const ALLOWED = { createdAt: 'created_at', name: 'name' };

describe('parseSort', () => {
  it('maps fields to columns with direction, in order', () => {
    expect(parseSort('-createdAt,name', ALLOWED, 'createdAt')).toEqual([
      { field: 'createdAt', col: 'created_at', dir: 'desc' },
      { field: 'name', col: 'name', dir: 'asc' },
    ]);
  });

  // Regression (2026-11-16): `?sort=` gave '' -> no keys -> the list silently ordered by id only.
  it.each([undefined, '', '  ', ','])('falls back to the default for %j', (raw) => {
    expect(parseSort(raw, ALLOWED, '-createdAt')).toEqual([{ field: 'createdAt', col: 'created_at', dir: 'desc' }]);
  });

  it('refuses an unknown field with the allowed list as the fix', () => {
    expect(() => parseSort('weight', ALLOWED, 'name')).toThrow(AppError);
    try {
      parseSort('weight', ALLOWED, 'name');
    } catch (e) {
      expect((e as AppError).code).toBe('INVALID_SORT');
      expect((e as AppError).fix).toContain('createdAt, name');
    }
  });

  it('refuses the same field twice (ambiguous direction)', () => {
    expect(() => parseSort('name,-name', ALLOWED, 'name')).toThrow(/more than once/);
  });
});
