import { sql, type Kysely } from 'kysely';

/**
 * Baseline: generic helpers only — no business tables (those arrive with the data).
 * - set_updated_at(): attach as a BEFORE UPDATE trigger on any table with updated_at.
 * - pg_trgm: trigram indexes for ILIKE '%term%' search (`CREATE INDEX ... USING gin (col gin_trgm_ops)`).
 * - staging schema: raw dataset imports land here (scripts/data/load.ts) before being shaped
 *   into real tables by a migration.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS pg_trgm`.execute(db);
  await sql`CREATE SCHEMA IF NOT EXISTS staging`.execute(db);
  await sql`
    CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      NEW.updated_at = now();
      RETURN NEW;
    END;
    $$
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP FUNCTION IF EXISTS set_updated_at()`.execute(db);
  await sql`DROP SCHEMA IF EXISTS staging CASCADE`.execute(db);
}
