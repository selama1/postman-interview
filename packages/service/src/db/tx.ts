import type { Kysely, Transaction } from 'kysely';
import type { Database } from './schema.js';

export type Executor = Kysely<Database> | Transaction<Database>;

/**
 * Run fn in a transaction. Repositories take an `Executor` so the same function works
 * standalone or inside a caller's transaction.
 *
 * isolation: use 'serializable' for read-check-write invariants (capacity, balances) and retry
 * on 40001 with `retryOnSerializationFailure`. For simple row-level races prefer
 * `SELECT ... FOR UPDATE` (Kysely: `.forUpdate()`) or a constraint + ON CONFLICT.
 */
export async function withTransaction<T>(
  db: Kysely<Database>,
  fn: (trx: Transaction<Database>) => Promise<T>,
  opts: { isolation?: 'read committed' | 'repeatable read' | 'serializable' } = {},
): Promise<T> {
  let builder = db.transaction();
  if (opts.isolation) builder = builder.setIsolationLevel(opts.isolation);
  return builder.execute(fn);
}

export async function retryOnSerializationFailure<T>(fn: () => Promise<T>, attempts = 5): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      const code = (err as { code?: string }).code;
      if ((code === '40001' || code === '40P01') && i < attempts) {
        await new Promise((r) => setTimeout(r, 10 * 2 ** i + Math.random() * 10));
        continue;
      }
      throw err;
    }
  }
}
