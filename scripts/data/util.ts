import { existsSync, readFileSync } from 'node:fs';

export const argValue = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
export const hasFlag = (name: string) => process.argv.includes(name);

/** snake_case, ascii, max 63 chars, not starting with a digit. */
export const sanitizeIdent = (s: string) => {
  let id = s
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[\s-]+/g, '_')
    .toLowerCase()
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  if (/^\d/.test(id)) id = `c_${id}`;
  return id.slice(0, 63);
};

/** DATABASE_URL from env, else repo .env, else the compose dev DB. */
export function databaseUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  if (existsSync('.env')) {
    const m = /^DATABASE_URL\s*=\s*(.+)$/m.exec(readFileSync('.env', 'utf8'));
    if (m) return m[1]!.trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return 'postgres://app:app@localhost:15432/app';
}

export const quoteIdent = (s: string) => `"${s.replace(/"/g, '""')}"`;
