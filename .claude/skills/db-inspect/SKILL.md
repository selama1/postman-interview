---
name: db-inspect
description: Inspect Postgres directly — psql access to dev/test DBs, EXPLAIN (ANALYZE, BUFFERS) for slow queries, index advice, pg_stat_statements, locks and blocking, connection/pool state, table sizes. Use for slow endpoints, unexpected query results, deadlocks/lock waits, or to justify an index in the live session.
---

# DB inspection

## Access
- Dev DB (compose `db`): `pnpm db:psql` (= `node scripts/dc.mjs exec db psql -U app -d app`).
  One-off: `node scripts/dc.mjs exec -T db psql -U app -d app -c "<sql>"`.
- Test DB server: `node scripts/dc.mjs exec db-test psql -U app -d <t_... from KEEP_TEST_DB=1>`.
- Host tools: `postgres://app:app@localhost:15432/app` (dev), `...:55432/postgres` (test admin).

## Slow query workflow
1. Find it: slow-query warn lines in `pnpm dc logs api` (SQL + params + ms), or
   ```sql
   select calls, round(mean_exec_time::numeric,1) as mean_ms, round(total_exec_time::numeric) as total_ms, rows, left(query, 120)
   from pg_stat_statements order by total_exec_time desc limit 15;
   -- reset between experiments: select pg_stat_statements_reset();
   ```
2. Explain with the real params:
   `explain (analyze, buffers, format text) <query>;`
   Read: Seq Scan on a big table with a selective filter → index candidate; rows estimate vs
   actual off by 10×+ → `analyze <table>`; Sort with external merge → index matching ORDER BY or
   more work_mem; Nested Loop with huge inner loops → missing join index.
3. Index to match the access path: equality columns first, then range/sort column, then id for
   keyset: `create index concurrently ... on books (status, created_at, id);`
   Partial index for hot subsets: `... where status = 'in_review'`.
   `ILIKE '%x%'` → `create index ... using gin (name gin_trgm_ops);` (pg_trgm is installed).
4. Re-run EXPLAIN; quote before/after timings when explaining the tradeoff (write cost, size).
   Measure at realistic volume: generate rows with `insert ... select ... from generate_series(1, 200000)`.

## Locks / blocking
```sql
select pid, state, wait_event_type, wait_event, now()-query_start as age, left(query,100)
from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid();

select blocked.pid as blocked, blocking.pid as blocking, left(blocked.query,80) as blocked_q, left(blocking.query,80) as blocking_q
from pg_stat_activity blocked
join pg_stat_activity blocking on blocking.pid = any(pg_blocking_pids(blocked.pid));
```
Cancel: `select pg_cancel_backend(<pid>);` (terminate only if cancel fails).

## Sizes / health
```sql
select relname, n_live_tup, pg_size_pretty(pg_total_relation_size(relid)) from pg_stat_user_tables order by pg_total_relation_size(relid) desc;
select indexrelname, idx_scan, pg_size_pretty(pg_relation_size(indexrelid)) from pg_stat_user_indexes order by idx_scan;  -- unused indexes
```
Pool view from the app: `GET /health/db` → `pool {total, idle, waiting}` (waiting > 0 under load
= pool too small or long transactions).

## Rules
- Never change data in the dev DB to make a test pass; tests own their own DBs.
- Schema changes go through migrations, even "just an index" (so the container gets it).
