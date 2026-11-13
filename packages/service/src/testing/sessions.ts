import { randomBytes } from 'node:crypto';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { Logger } from 'pino';
import type { Db } from '../db/kysely.js';
import type { Database } from '../db/schema.js';
import { cloneTemplate, dropDatabase, ensureTemplate, withDatabase } from '../db/template.js';

/**
 * API test mode: each test session is its own database, cloned from the sealed migrated
 * template. Clients opt in per request with `x-test-session: <id>`; the request's `req.db` then
 * points at that database (src/http/test-mode.ts).
 *
 * State lives in Postgres, not in this process: the session id IS the database name
 * (`ts_<created epoch36>_<random>`), so sessions survive a service restart and expiry needs no
 * bookkeeping. This process only caches small per-session pools (closed when idle).
 *
 * Isolation covers Postgres state only. Anything else a handler keeps (in-memory caches,
 * background jobs, outbound calls) must key on the session too — see docs/llms.txt § Test mode.
 */
export const SESSION_ID = /^ts_[0-9a-z]{6}_[0-9a-f]{12}$/;

export interface TestSessionInfo {
  id: string;
  createdAt: string;
  expiresAt: string;
}

export class TestSessionError extends Error {
  constructor(
    readonly kind: 'not_found' | 'limit',
    message: string,
  ) {
    super(message);
  }
}

interface Cached {
  db: Kysely<Database>;
  pool: pg.Pool;
  lastUsed: number;
}

export interface SessionManagerOptions {
  adminUrl: string;
  ttlMs: number;
  maxSessions: number;
  poolMax?: number;
  statementTimeoutMs?: number;
  logger?: Logger;
}

export class TestSessionManager {
  private readonly admin: pg.Pool;
  private readonly cache = new Map<string, Cached>();
  private reaper: NodeJS.Timeout | undefined;
  private templateReady: Promise<unknown> | undefined;

  constructor(private readonly opts: SessionManagerOptions) {
    this.admin = new pg.Pool({ connectionString: opts.adminUrl, max: 2 });
    this.admin.on('error', (err) => opts.logger?.warn({ err }, 'test-session admin pool error'));
  }

  /** Build/refresh the template if migrations changed; start the expiry reaper. */
  async start(): Promise<void> {
    this.templateReady ??= ensureTemplate(this.admin, this.opts.adminUrl, { log: (m) => this.opts.logger?.info(m) });
    await this.templateReady;
    await this.reap();
    this.reaper = setInterval(() => void this.reap().catch((err) => this.opts.logger?.warn({ err }, 'test-session reap failed')), 60_000);
    this.reaper.unref();
  }

  private createdAt(id: string): number {
    return Number.parseInt(id.split('_')[1]!, 36) * 1000;
  }

  private info(id: string): TestSessionInfo {
    const c = this.createdAt(id);
    return { id, createdAt: new Date(c).toISOString(), expiresAt: new Date(c + this.opts.ttlMs).toISOString() };
  }

  async list(): Promise<TestSessionInfo[]> {
    const { rows } = await this.admin.query<{ datname: string }>(`select datname from pg_database where datname ~ '^ts_' order by datname`);
    return rows.map((r) => r.datname).filter((n) => SESSION_ID.test(n)).map((n) => this.info(n));
  }

  async create(): Promise<TestSessionInfo> {
    await this.templateReady;
    const existing = await this.list();
    if (existing.length >= this.opts.maxSessions) {
      throw new TestSessionError('limit', `test session limit reached (${existing.length}/${this.opts.maxSessions})`);
    }
    const id = `ts_${Math.floor(Date.now() / 1000).toString(36).padStart(6, '0')}_${randomBytes(6).toString('hex')}`;
    await cloneTemplate(this.admin, id);
    this.opts.logger?.info({ testSession: id }, 'test session created');
    return this.info(id);
  }

  /** The session's Kysely handle. Throws TestSessionError('not_found') for unknown/expired ids. */
  async resolve(id: string): Promise<Db> {
    if (!SESSION_ID.test(id)) throw new TestSessionError('not_found', `"${id}" is not a test session id`);
    if (Date.now() - this.createdAt(id) > this.opts.ttlMs) {
      throw new TestSessionError('not_found', `test session ${id} has expired`);
    }
    const hit = this.cache.get(id);
    if (hit) {
      hit.lastUsed = Date.now();
      return hit.db;
    }
    const { rowCount } = await this.admin.query('select 1 from pg_database where datname = $1', [id]);
    if (!rowCount) throw new TestSessionError('not_found', `test session ${id} does not exist (deleted or expired)`);
    const pool = new pg.Pool({
      connectionString: withDatabase(this.opts.adminUrl, id),
      max: this.opts.poolMax ?? 3,
      idleTimeoutMillis: 10_000,
      ...(this.opts.statementTimeoutMs ? { statement_timeout: this.opts.statementTimeoutMs } : {}),
    });
    pool.on('error', () => {}); // connections are force-closed when the session is dropped
    const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
    this.cache.set(id, { db, pool, lastUsed: Date.now() });
    return db;
  }

  async drop(id: string): Promise<boolean> {
    if (!SESSION_ID.test(id)) return false;
    await this.evict(id);
    const { rowCount } = await this.admin.query('select 1 from pg_database where datname = $1', [id]);
    if (!rowCount) return false;
    await dropDatabase(this.admin, id);
    this.opts.logger?.info({ testSession: id }, 'test session dropped');
    return true;
  }

  private async evict(id: string) {
    const c = this.cache.get(id);
    if (!c) return;
    this.cache.delete(id);
    await c.db.destroy().catch(() => {});
    if (!c.pool.ended) await c.pool.end().catch(() => {});
  }

  /** Drop expired sessions; close pools idle > 5 min. */
  async reap(): Promise<void> {
    for (const s of await this.list()) {
      if (Date.parse(s.expiresAt) < Date.now()) await this.drop(s.id);
    }
    for (const [id, c] of this.cache) if (Date.now() - c.lastUsed > 5 * 60_000) await this.evict(id);
  }

  async close(): Promise<void> {
    if (this.reaper) clearInterval(this.reaper);
    for (const id of [...this.cache.keys()]) await this.evict(id);
    await this.admin.end();
  }
}
