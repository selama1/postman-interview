import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './config.js';

describe('loadConfig', () => {
  it('applies defaults and coerces types', () => {
    const c = loadConfig({ DATABASE_URL: 'postgres://u:p@h:5432/d', PORT: '8080', MIGRATE_ON_START: 'true' });
    expect(c).toMatchObject({ PORT: 8080, MIGRATE_ON_START: true, DB_POOL_MAX: 10, NODE_ENV: 'development' });
  });

  it('fails fast naming every bad variable and the fix', () => {
    expect(() => loadConfig({ DATABASE_URL: 'mysql://x' })).toThrow(ConfigError);
    let msg = '';
    try {
      loadConfig({ PORT: 'abc' });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/DATABASE_URL/);
    expect(msg).toMatch(/PORT/);
    expect(msg).toMatch(/Fix:/);
  });
});
