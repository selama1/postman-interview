import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Test env. Precedence: real env > repo-root .env > defaults below (match docker-compose.yml).
 * Minimal .env parser (KEY=VALUE, # comments, optional quotes) so tests need no extra deps.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

function readDotEnv(): Record<string, string> {
  const p = path.join(ROOT, '.env');
  if (!existsSync(p)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    let v = m[2]!;
    if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    out[m[1]!] = v;
  }
  return out;
}

const dot = readDotEnv();
const get = (k: string, d: string) => process.env[k] ?? dot[k] ?? d;

export const testEnv = {
  root: ROOT,
  adminUrl: get('TEST_DATABASE_ADMIN_URL', 'postgres://app:app@localhost:55432/postgres'),
  e2eBaseUrl: get('E2E_BASE_URL', 'http://localhost:3480'),
  /** silent by default; TEST_LOG_LEVEL=debug to see request + SQL logs while debugging a test */
  logLevel: get('TEST_LOG_LEVEL', 'silent'),
  logSql: get('TEST_LOG_SQL', 'false') === 'true',
  target: (process.env.TEST_TARGET ?? 'integration') as 'integration' | 'e2e',
  templateDb: 'app_template',
};

/** Replace the database name in a postgres URL. */
export function withDatabase(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}
