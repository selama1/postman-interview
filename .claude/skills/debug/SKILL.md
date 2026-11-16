---
name: debug
description: Systematic debugging of wrong responses, 500s, slow endpoints, flaky tests or a stack that won't come up — reproduce, verify the code path is even running, trace by request id, isolate with A/B, then fix the class with a regression test. Use when something misbehaves and the cause isn't obvious within a minute.
---

# Debug protocol

Order matters: cheap certainty first, hypotheses second, code changes last. If the report
came from a client ("it returns the wrong thing"), run skill `triage` first. It may be a gap or
an AX/DX issue, not a bug.

## 0. Is it even on?
Before asking why a feature misbehaved, confirm it executed:
- right process/image? (`pnpm dc ps`, image rebuilt after the change? `--no-build` is a classic)
- route registered? (`/openapi.json` lists it; ROUTE_NOT_FOUND says no)
- migration applied? (`GET /health/db` → migrations.latest / pending)
- config value what you think? (config.ts is the only reader; log it at startup if in doubt)

## 1. Reproduce
Integration test first (skill `repro-test`) — deterministic, own DB, full logs available.
If it only reproduces on the stack: `curl -i` it, keep the `x-request-id` from the response.

## 2. Gather evidence (delegate scraping to a Haiku `scout` when it's bulky)
- Request trace: every log line for one request shares `reqId`:
  `pnpm dc logs api --since 10m | grep <x-request-id>`
- SQL: `LOG_SQL=true LOG_LEVEL=debug` (compose: `LOG_SQL=true LOG_LEVEL=debug pnpm stack:up`);
  in tests `TEST_LOG_LEVEL=debug TEST_LOG_SQL=true`. Slow queries are always logged at warn.
- Error body: problem+json `code` tells you the layer — VALIDATION_FAILED (zod), CONFLICT/
  REFERENCE_VIOLATION (constraint), RESPONSE_SCHEMA_MISMATCH (handler returned wrong shape),
  QUERY_TIMEOUT (statement_timeout), INTERNAL (unhandled — the log has the stack under that reqId).
- DB state: skill `db-inspect` (psql, EXPLAIN ANALYZE, locks, pg_stat_statements).
- Container: `pnpm dc ps`, `pnpm dc logs db`, healthcheck status.

## 3. Hypotheses → cheapest discriminating check
List 2–3 candidate causes. For each, the one observation that would rule it in/out. Run the
cheapest first. Don't change code to "see if it helps".

## 4. Isolate
- **A/B the suspect change:** `git stash` (or check out the previous commit in a scratch worktree)
  → rerun the single repro → same failure on both sides = not your change.
- **Disposable probe:** one question, one script: `scripts/probes/<question>.ts` (run with
  `npx tsx`). Bisect inputs (which row/field triggers it?). Delete or keep with a header comment
  saying what it answered.
- Concurrency suspicion: `pnpm probe:hammer <path> -n 200 -c 50`, or `race()` in a test.

## 5. Fix the class, prove it
Fix the root cause generally (no special-casing the bad row). The repro test goes red → green.
Add the invariant as a test if it's a new class. If the original symptom was an opaque error,
improve the error itself (reason + fix) so the next person isn't debugging blind.

## 6. Write it down
Commit body: symptom → cause → fix → tests. Non-obvious environment gotchas → CLAUDE.md
(dated) or docs/llms.txt §7 pitfalls.

## Stack won't come up (quick table)
| symptom | check | usual fix |
|---|---|---|
| `api` restarting | `pnpm dc logs api` | ConfigError (message lists var + fix) / migration failed |
| `db` missing/exited | `pnpm dc ps -a` | WSL idled out → `pnpm stack:up`; host port taken → `DB_PORT=<free> pnpm stack:up` (or `API_PORT=`); `sh scripts/smoke.sh` diagnoses it |
| health/db 503 | response `detail` | DB down or DATABASE_URL wrong |
| ECONNRESET from Windows | `pnpm dc ps` | container restarting; wait for healthy (`--wait`) |
| tests: "test database unreachable" | — | `pnpm db:test:up` |
