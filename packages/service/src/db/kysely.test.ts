import pg from 'pg';
import { describe, expect, it } from 'vitest';
import './kysely.js';

describe('pg type parsers (registered by importing kysely.ts)', () => {
  it('date columns stay plain YYYY-MM-DD strings (no timezone shift)', () => {
    expect(pg.types.getTypeParser(pg.types.builtins.DATE)('2026-01-02')).toBe('2026-01-02');
  });
  it('int8 parses to a number, numeric stays a string', () => {
    expect(pg.types.getTypeParser(pg.types.builtins.INT8)('42')).toBe(42);
    expect(pg.types.getTypeParser(pg.types.builtins.NUMERIC)('12.50')).toBe('12.50');
  });
});
