/**
 * Kysely table types. One interface per table, keyed by table name in `Database`.
 *
 * Conventions (see docs/llms.txt § Database):
 * - Generated<T>     columns the DB fills (serial/identity, defaults like now()).
 * - ColumnType<S,I,U> when select/insert/update types differ.
 * - Postgres `numeric`/`bigint` come back from `pg` as strings — type them `string` (or parse
 *   explicitly in the mapper), never silently `number`.
 * - Optional: regenerate from the live dev DB with `pnpm --filter service db:types` (kysely-codegen)
 *   when a dataset has many columns; then hand-tune.
 *
 * Intentionally empty in the vanilla scaffold: business tables arrive with the data.
 */
export interface Database {}
