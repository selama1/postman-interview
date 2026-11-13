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

## 2026-11-13 — API keys, when added, are environment-scoped (live vs test); clients ship test mode
- Context: user wants the XCiteDB model of separate deployment and test keys captured as a rule
  now, without building auth before the live session needs it.
- Options:
  - Environment-scoped keys (chosen): a test key can only work inside a test session, and in
    deployment `/_test/*` requires a test key.
  - A single key type gated only by `TEST_SESSIONS_ENABLED`: a misconfigured client silently hits
    real data.
  - Separate test deployment only: no per-request guarantee.
- Decided by: user (requirement and model). The `/_test/*`-needs-test-key tightening was
  proposed by Claude.
- Consequences: CLAUDE.md §2c/§2d and skill `client-surface`. Revisit if the session's auth
  model (e.g. per-actor roles) needs a different credential shape. The env axis still applies.

## 2026-11-13 — API test mode: `x-test-session` routes a request to an isolated per-session DB
- Context: user wants apps using the API (e2e, SDK, Postman) to test against clean data too,
  like XCiteDB's x-test-session; built as scaffolding before any business API exists.
- Options: database per session cloned from the migrated template (chosen: unbreakable isolation,
  ~100 ms) / schema per session via search_path (cheaper, leaks through pooled connections) /
  transaction-per-session (can't span requests).
- Decided by: user (requirement), mechanism proposed by Claude and approved.
- Follow-up (same day): named fixtures as sealed templates (seed once, clone per session/test);
  DELETE made instant (rename + background drop) after measuring 22 s for 40 synchronous drops.
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
