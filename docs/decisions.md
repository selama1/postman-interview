# Decisions log

Decisions made **with the user** (or by the user) are recorded here so no session relitigates
them. Newest first. Format:

```
## YYYY-MM-DD — <decision, as a statement>
- Context: <what forced the choice>
- Options: <A (chosen) / B / C — one line each with the tradeoff>
- Decided by: user | proposed by Claude, approved by user
- Consequences: <what this commits us to; what would make us revisit>
```

---

## 2026-11-13 — API test mode: `x-test-session` routes a request to an isolated per-session DB
- Context: user wants apps using the API (e2e, SDK, Postman) to test against clean data too,
  like XCiteDB's x-test-session; built as scaffolding before any business API exists.
- Options: database per session cloned from the migrated template (chosen: unbreakable isolation,
  ~100 ms) / schema per session via search_path (cheaper, leaks through pooled connections) /
  transaction-per-session (can't span requests).
- Decided by: user (requirement), mechanism proposed by Claude and approved.
- Consequences: handlers must use `req.db` (static test enforces). Enabled in compose, default off;
  header refused when off. Non-Postgres state must key on the session.

## 2026-11-13 — Integration tests run live against Postgres, one empty DB per test
- Context: user strongly prefers live tests over mocks; tests must start from an empty DB.
- Options: template-cloned DB per test (chosen) / transaction rollback per test (hides commit
  behaviour, breaks with app-managed transactions) / TRUNCATE between tests (shared DB, no parallelism).
- Decided by: user (requirement), mechanism proposed by Claude and approved.
- Consequences: tests need `db-test` up (they fail loudly, never skip). ~50–150 ms per test setup.

## 2026-11-13 — Stack: TypeScript, Fastify 5, Kysely, zod 4, Postgres 17, Vitest, Docker (WSL engine)
- Context: pre-assessment asks for a familiar stack with ORM/query builder, logging, config, migrations.
- Options: Kysely (chosen: typed SQL, explainable tradeoffs) / Prisma or Drizzle ORM / raw pg.
- Decided by: proposed by Claude, approved by user.
- Consequences: no ORM magic; SQL is visible and reviewable in the live session.
