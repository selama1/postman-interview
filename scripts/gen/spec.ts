/**
 * Field-spec parser + naming helpers for `pnpm gen:resource`. Pure: no I/O, unit-tested in spec.test.ts.
 *
 * Grammar (comma-separated; commas inside parentheses do not split):
 *
 *   name:type[?][:modifier...]
 *
 *   name       camelCase API name (-> snake_case column). Reserved: id, createdAt, updatedAt.
 *   type       text | int | bigint | bool | date | timestamptz
 *              numeric(p,s)            API: decimal STRING ("12.50"), never a JS float
 *              enum(a|b|c)             text + CHECK constraint, z.enum, `?status=a,b` filter
 *              ref(<table>)            bigint FK to <table>(id), indexed, `?<name>=<id>` filter
 *   ?          nullable in the DB, optional in the API (null = "no value")
 *   modifiers  unique                  UNIQUE constraint (not on bool/enum/ref)
 *              min0 | positive         CHECK >= 0 / > 0 + the same bound in zod (int/bigint/numeric)
 *              max=<n>                 text length cap, CHECK + zod (default 200, 1..10000)
 *
 *   Example:
 *     "trackingCode:text:unique, status:enum(pending|in_transit|delivered), weightKg:numeric(10,2),
 *      declaredValue:int?:min0, customerId:ref(customers), shippedAt:timestamptz?"
 */

export const TYPES = ['text', 'int', 'bigint', 'numeric(p,s)', 'bool', 'date', 'timestamptz', 'enum(a|b|c)', 'ref(<table>)'] as const;
export const MODIFIERS = ['unique', 'min0', 'positive', 'max=<n>'] as const;
export const EXAMPLE = 'trackingCode:text:unique, status:enum(pending|delivered), weightKg:numeric(10,2), declaredValue:int?:min0, customerId:ref(customers)';
export const DEFAULT_TEXT_MAX = 200;

export type Kind = 'text' | 'int' | 'bigint' | 'numeric' | 'bool' | 'date' | 'timestamptz' | 'enum' | 'ref';

export interface Field {
  /** camelCase API name */
  name: string;
  /** snake_case column */
  column: string;
  kind: Kind;
  nullable: boolean;
  unique: boolean;
  /** CHECK >= 0 */
  min0: boolean;
  /** CHECK > 0 */
  positive: boolean;
  /** text only */
  max?: number;
  /** numeric only */
  precision?: number;
  scale?: number;
  /** enum only */
  values?: string[];
  /** ref only: target table */
  refTable?: string;
}

/** A user-facing spec error: the message names the token, the valid options and an example. */
export class SpecError extends Error {
  override name = 'SpecError';
}

const RESERVED = new Set(['id', 'createdAt', 'updatedAt']);
const NAME_RE = /^[a-z][a-zA-Z0-9]*$/;
const TABLE_RE = /^[a-z][a-z0-9_]*$/;

export const snake = (camel: string) => camel.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
export const pascal = (s: string) =>
  s
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join('');
export const camel = (s: string) => {
  const p = pascal(s);
  return p[0]!.toLowerCase() + p.slice(1);
};
/** Naive English singular, good enough for labels (customers -> customer, categories -> category, boxes -> box). */
export const singular = (plural: string) => {
  if (/ies$/.test(plural)) return `${plural.slice(0, -3)}y`;
  if (/(s|x|z|ch|sh)es$/.test(plural)) return plural.slice(0, -2);
  if (/s$/.test(plural) && !/ss$/.test(plural)) return plural.slice(0, -1);
  return plural;
};

/** Split on commas that are not inside parentheses. */
export function splitTop(input: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of input) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

const bad = (token: string, why: string, hint?: string): never => {
  throw new SpecError(
    `bad field spec "${token}": ${why}\n  valid types:     ${TYPES.join(' | ')}\n  valid modifiers: ${MODIFIERS.join(' | ')} (and a trailing ? on the type for nullable)\n  ${hint ?? `example: --fields "${EXAMPLE}"`}`,
  );
};

export function parseTableName(raw: string | undefined): string {
  if (!raw || !TABLE_RE.test(raw) || raw.length > 40) {
    throw new SpecError(
      `bad resource name "${raw ?? ''}": use the PLURAL snake_case table name (lowercase letters, digits, underscores; starts with a letter; max 40).\n  example: pnpm gen:resource shipments --fields "${EXAMPLE}"`,
    );
  }
  return raw;
}

export function parseField(token: string): Field {
  const [name = '', typeRaw = '', ...mods] = token.split(':').map((s) => s.trim());
  if (!name || !typeRaw) bad(token, 'expected name:type[?][:modifier...]');
  if (!NAME_RE.test(name)) bad(token, `field name "${name}" must be camelCase (letters/digits, starts lowercase)`, 'example: weightKg:numeric(10,2)');
  if (RESERVED.has(name)) bad(token, `"${name}" is reserved: id, createdAt and updatedAt are added by the generator`);

  const nullable = typeRaw.endsWith('?');
  const t = (nullable ? typeRaw.slice(0, -1) : typeRaw).replace(/\s+/g, '');
  const f: Field = { name, column: snake(name), kind: 'text', nullable, unique: false, min0: false, positive: false };

  let m: RegExpMatchArray | null;
  if (/^(text|int|bigint|bool|date|timestamptz)$/.test(t)) {
    f.kind = t as Kind;
  } else if ((m = t.match(/^numeric\((\d+),(\d+)\)$/))) {
    f.kind = 'numeric';
    f.precision = Number(m[1]);
    f.scale = Number(m[2]);
    if (f.precision < 1 || f.precision > 38 || f.scale >= f.precision) {
      bad(token, `numeric(${f.precision},${f.scale}) needs 1 <= precision <= 38 and scale < precision`, 'example: weightKg:numeric(10,2)');
    }
  } else if ((m = t.match(/^enum\(([^)]*)\)$/))) {
    f.kind = 'enum';
    f.values = m[1]!.split('|').filter((v) => v !== '');
    if (f.values.some((v) => !/^[A-Za-z0-9_]+$/.test(v))) bad(token, 'enum values may contain only letters, digits and underscores', 'example: status:enum(pending|in_transit|delivered)');
    if (f.values.length < 2) bad(token, 'enum needs at least two values separated by |', 'example: status:enum(pending|in_transit|delivered)');
    if (new Set(f.values).size !== f.values.length) bad(token, 'enum values must be distinct');
  } else if ((m = t.match(/^ref\(([^)]*)\)$/))) {
    f.kind = 'ref';
    f.refTable = m[1]!;
    if (!TABLE_RE.test(f.refTable)) bad(token, `ref target "${f.refTable}" must be a snake_case table name`, 'example: customerId:ref(customers)');
    if (!name.endsWith('Id')) bad(token, `ref field "${name}" should end in Id (the column is ${snake(name)})`, 'example: customerId:ref(customers)');
  } else {
    bad(token, `unknown type "${t}"`);
  }

  for (const mod of mods) {
    if (mod === 'unique') {
      if (f.kind === 'bool' || f.kind === 'enum' || f.kind === 'ref') bad(token, `"unique" makes no sense on ${f.kind}`);
      f.unique = true;
    } else if (mod === 'min0' || mod === 'positive') {
      if (f.kind !== 'int' && f.kind !== 'bigint' && f.kind !== 'numeric') bad(token, `"${mod}" applies to int, bigint and numeric only`);
      f[mod === 'min0' ? 'min0' : 'positive'] = true;
    } else if ((m = mod.match(/^max=(\d+)$/))) {
      if (f.kind !== 'text') bad(token, '"max=<n>" applies to text only');
      f.max = Number(m[1]);
      if (f.max < 1 || f.max > 10_000) bad(token, 'max must be between 1 and 10000');
    } else {
      bad(token, `unknown modifier "${mod}"`);
    }
  }
  if (f.min0 && f.positive) bad(token, 'use either min0 or positive, not both (positive already excludes 0)');
  if (f.kind === 'text') f.max ??= DEFAULT_TEXT_MAX;
  if (f.unique && f.kind === 'text' && f.max! < 2) bad(token, 'unique text needs max >= 2 (generated tests need distinct values)');
  if (f.unique && f.kind === 'numeric' && f.precision! - f.scale! < 2) bad(token, 'unique numeric needs at least 2 integer digits (precision - scale >= 2) so generated tests can create 23 distinct rows');
  return f;
}

export function parseFields(spec: string | undefined): Field[] {
  if (!spec || !spec.trim()) {
    throw new SpecError(`missing --fields.\n  example: --fields "${EXAMPLE}"`);
  }
  const fields = splitTop(spec).map(parseField);
  const seen = new Set<string>();
  for (const f of fields) {
    if (seen.has(f.name)) throw new SpecError(`duplicate field "${f.name}" in --fields; each field name may appear once`);
    seen.add(f.name);
  }
  return fields;
}
