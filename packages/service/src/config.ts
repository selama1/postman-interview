import { z } from 'zod';

/**
 * All runtime configuration, validated once at startup.
 * Add new settings HERE (with a default when it is safe) — never read process.env elsewhere.
 * A bad value fails fast with the variable name, the reason and the fix.
 */
const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  LOG_FORMAT: z.enum(['pretty', 'json']).optional(),
  DATABASE_URL: z
    .string()
    .url()
    .refine((u) => u.startsWith('postgres://') || u.startsWith('postgresql://'), 'must be a postgres:// URL'),
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().nonnegative().default(15_000),
  LOG_SQL: bool.default(false),
  SLOW_QUERY_MS: z.coerce.number().int().nonnegative().default(250),
  MIGRATE_ON_START: bool.default(false),
  /** API test mode (x-test-session). Never enable on a deployment that holds real data. */
  TEST_SESSIONS_ENABLED: bool.default(false),
  TEST_SESSION_TTL_MIN: z.coerce.number().positive().default(60),
  TEST_SESSIONS_MAX: z.coerce.number().int().positive().default(100),
});

export type Config = z.infer<typeof ConfigSchema>;

export class ConfigError extends Error {}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: Partial<Record<keyof Config, string>> = {}): Config {
  const parsed = ConfigSchema.safeParse({ ...env, ...overrides });
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new ConfigError(
      `Invalid configuration:\n${lines.join('\n')}\n` +
        `Fix: set the variables above (see .env.example; for local runs \`cp .env.example .env\`).`,
    );
  }
  return parsed.data;
}
