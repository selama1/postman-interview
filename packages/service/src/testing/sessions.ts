import { randomBytes } from 'node:crypto';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { Logger } from 'pino';
import type { Db } from '../db/kysely.js';
import type { Database } from '../db/schema.js';
import {
  cloneTemplate,
  dropDatabase,
  ensureFixtureTemplate,
  ensureTemplate,
  quoteDb,
  retireDatabase,
  TEMPLATE_DB,
  withDatabase,
  type FixtureRegistry,
} from '../db/template.js';
import { fixtures as defaultFixtures } from './fixtures.js';

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
  fixture?: string | undefined;
  createdAt: string;
  expiresAt: string;
}

export class TestSessionError extends Error {
  constructor(
    readonly kind: 'not_found' | 'limit' | 'unknown_fixture',
    message: string,
  ) {
    super(message);
  }
}

interface Cached {
  db: Kysely<Database>;
  pool: pg.Pool;
  lastUsed: number;
  expiresAt: number;
}

export interface SessionManagerOptions {
  adminUrl: string;
  ttlMs: number;
  maxSessions: number;
  poolMax?: number;
  statementTimeoutMs?: number;
  logger?: Logger;
  /** Named initial states (default: src/testing/fixtures.ts). */
  fixtures?: FixtureRegistry;
}

const TRASH_PREFIX = 'tsdel_';
const ORPHAN_TTL_MS = 24 * 60 * 60_000;

export class TestSessionManager {
  private readonly admin: pg.Pool;
  private readonly cache = new Map<string, Cached>();
  private reaper: NodeJS.Timeout | undefined;
  private templateReady: Promise<unknown> | undefined;
  private readonly fixtureTemplates = new Map<string, Promise<string>>();
  private dropQueue: Promise<void> = Promise.resolve();
  readonly fixtures: FixtureRegistry;

  constructor(private readonly opts: SessionManagerOptions) {
    this.admin = new pg.Pool({ connectionString: opts.adminUrl, max: 2 });
    this.admin.on('error', (err) => opts.logger?.warn({ err }, 'test-session admin pool error'));
    this.fixtures = opts.fixtures ?? defaultFixtures;
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

  /**
   * A session's expiry is a property of the SESSION (stored in its database comment at creation),
   * never of whichever instance reads it: several service instances or test servers share one
   * Postgres, and judging others' sessions by your own TTL drops live ones. A session with no
   * metadata (a crash between CREATE and COMMENT, or a pre-metadata session) gets a conservative
   * expiry of max(own TTL, 24 h).
   */
  private info(id: string, meta: string | null): TestSessionInfo {
    const c = this.createdAt(id);
    let parsed: { expiresAt?: unknown; fixture?: unknown } = {};
    try {
      parsed = meta ? (JSON.parse(meta) as typeof parsed) : {};
    } catch {
      /* foreign comment: treat as no metadata */
    }
    const expires = typeof parsed.expiresAt === 'number' ? parsed.expiresAt : c + Math.max(this.opts.ttlMs, ORPHAN_TTL_MS);
    const fixture = typeof parsed.fixture === 'string' ? parsed.fixture : undefined;
    return { id, fixture, createdAt: new Date(c).toISOString(), expiresAt: new Date(expires).toISOString() };
  }

  private async lookup(where: string, params: unknown[] = []): Promise<TestSessionInfo[]> {
    const { rows } = await this.admin.query<{ datname: string; meta: string | null }>(
      `select datname, shobj_description(oid, 'pg_database') as meta from pg_database where ${where} order by datname`,
      params,
    );
    return rows.filter((r) => SESSION_ID.test(r.datname)).map((r) => this.info(r.datname, r.meta));
  }

  async list(): Promise<TestSessionInfo[]> {
    return this.lookup(`datname ~ '^ts_'`);
  }

  /** Sealed template for a fixture (built once per fingerprint, then cached for this process). */
  private fixtureTemplate(name: string): Promise<string> {
    const fx = this.fixtures[name];
    if (!fx) {
      const known = Object.keys(this.fixtures);
      throw new TestSessionError('unknown_fixture', `unknown fixture "${name}"; known: ${known.length ? known.join(', ') : '(none defined)'}`);
    }
    let p = this.fixtureTemplates.get(name);
    if (!p) {
      p = ensureFixtureTemplate(this.admin, this.opts.adminUrl, name, fx, { log: (m) => this.opts.logger?.info(m) });
      p.catch(() => this.fixtureTemplates.delete(name)); // retry on the next request after a failed seed
      this.fixtureTemplates.set(name, p);
    }
    return p;
  }

  async create(opts: { fixture?: string | undefined } = {}): Promise<TestSessionInfo> {
    await this.templateReady;
    const template = opts.fixture ? await this.fixtureTemplate(opts.fixture) : TEMPLATE_DB;
    const existing = await this.list();
    if (existing.length >= this.opts.maxSessions) {
      throw new TestSessionError('limit', `test session limit reached (${existing.length}/${this.opts.maxSessions})`);
    }
    const id = `ts_${Math.floor(Date.now() / 1000).toString(36).padStart(6, '0')}_${randomBytes(6).toString('hex')}`;
    await cloneTemplate(this.admin, id, template);
    // id and fixture name are validated identifiers; the JSON has no quotes to escape beyond its own.
    const meta = JSON.stringify({ expiresAt: this.createdAt(id) + this.opts.ttlMs, ...(opts.fixture ? { fixture: opts.fixture } : {}) });
    await this.admin.query(`comment on database ${quoteDb(id)} is '${meta.replaceAll("'", "''")}'`);
    this.opts.logger?.info({ testSession: id, fixture: opts.fixture }, 'test session created');
    return this.info(id, meta);
  }

  /** The session's Kysely handle. Throws TestSessionError('not_found') for unknown/expired ids. */
  async resolve(id: string): Promise<Db> {
    if (!SESSION_ID.test(id)) throw new TestSessionError('not_found', `"${id}" is not a test session id`);
    const hit = this.cache.get(id);
    if (hit) {
      if (Date.now() > hit.expiresAt) throw new TestSessionError('not_found', `test session ${id} has expired`);
      hit.lastUsed = Date.now();
      return hit.db;
    }
    const [found] = await this.lookup('datname = $1', [id]);
    if (!found) throw new TestSessionError('not_found', `test session ${id} does not exist (deleted or expired)`);
    const expiresAt = Date.parse(found.expiresAt);
    if (Date.now() > expiresAt) throw new TestSessionError('not_found', `test session ${id} has expired`);
    const pool = new pg.Pool({
      connectionString: withDatabase(this.opts.adminUrl, id),
      max: this.opts.poolMax ?? 3,
      idleTimeoutMillis: 10_000,
      ...(this.opts.statementTimeoutMs ? { statement_timeout: this.opts.statementTimeoutMs } : {}),
    });
    pool.on('error', () => {}); // connections are force-closed when the session is dropped
    const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
    this.cache.set(id, { db, pool, lastUsed: Date.now(), expiresAt });
    return db;
  }

  /**
   * Instant from the caller's view: the session is renamed out of the live namespace (it 404s
   * immediately) and the real DROP runs in a serialized background queue. DROP DATABASE forces a
   * checkpoint and concurrent drops serialize (measured 40 parallel drops = 22 s), which would
   * otherwise dominate a large suite's teardown.
   */
  async drop(id: string): Promise<boolean> {
    if (!SESSION_ID.test(id)) return false;
    await this.evict(id);
    const { rowCount } = await this.admin.query('select 1 from pg_database where datname = $1', [id]);
    if (!rowCount) return false;
    const trash = `${TRASH_PREFIX}${id.slice(3)}`;
    await retireDatabase(this.admin, id, trash);
    this.enqueueDrop(trash);
    this.opts.logger?.info({ testSession: id }, 'test session deleted');
    return true;
  }

  private enqueueDrop(name: string) {
    this.dropQueue = this.dropQueue
      .then(() => dropDatabase(this.admin, name))
      .catch((err) => this.opts.logger?.warn({ err, db: name }, 'background drop failed (reaper will retry)'));
  }

  /** Resolves when every background drop queued so far has finished (tests, shutdown). */
  async settle(): Promise<void> {
    await this.dropQueue;
  }

  private async evict(id: string) {
    const c = this.cache.get(id);
    if (!c) return;
    this.cache.delete(id);
    await c.db.destroy().catch(() => {});
    if (!c.pool.ended) await c.pool.end().catch(() => {});
  }

  /** Drop expired sessions and leftover retired DBs (e.g. after a crash); close pools idle > 5 min. */
  async reap(): Promise<void> {
    const { rows } = await this.admin.query<{ datname: string }>(`select datname from pg_database where starts_with(datname, '${TRASH_PREFIX}')`);
    for (const r of rows) this.enqueueDrop(r.datname);
    for (const s of await this.list()) {
      if (Date.parse(s.expiresAt) < Date.now()) await this.drop(s.id);
    }
    for (const [id, c] of this.cache) if (Date.now() - c.lastUsed > 5 * 60_000) await this.evict(id);
  }

  async close(): Promise<void> {
    if (this.reaper) clearInterval(this.reaper);
    for (const id of [...this.cache.keys()]) await this.evict(id);
    await this.settle();
    await this.admin.end();
  }
}
