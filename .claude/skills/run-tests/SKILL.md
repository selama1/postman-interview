---
name: run-tests
description: Choose and run the right test layer (unit, live integration, e2e), read failures, and triage them against the known baseline. Use whenever you need to run tests, a run is red, or you need to know whether a failure is yours.
---

# Running tests

## Preconditions
- Test DB up: `pnpm db:test:up` (compose `db-test`, port 55432). If it's down the integration
  global setup FAILS with that exact fix — tests are never skipped.
- Windows: docker lives in WSL. If containers vanished, WSL idled out → rerun the up command.
- Once API keys exist (CLAUDE.md §2d): tests authenticate only with a **test key** from
  `TEST_API_KEY`. Global setup refuses to start on a missing or `sk_live_` key. Never "fix" that
  by pointing it at a live key or setting `allowLiveKey`.

## Pick the layer
| situation | command |
|---|---|
| inner loop while editing | `pnpm test:changed` (import graph + scripts/test-map.tsv; unmapped → ALL) |
| one file / one test | `npx vitest run <path> -t "<name>"` |
| before committing (the gate) | `pnpm test` (typecheck + unit + integration). Interview mode: once per deliverable, not per step |
| anything user-visible / container / migrations | `pnpm test:e2e` |
| long run, or a red run to triage | `pnpm test:report` (logs to .test-reports/, baseline diff) |

Delegate full-suite runs to the `test-runner` subagent (Haiku) when you don't need to watch them.

## Reading failures
- HTTP matchers print the whole exchange: request, response body, status, **x-request-id**.
- More context: `TEST_LOG_LEVEL=debug TEST_LOG_SQL=true npx vitest run <file> -t "<name>"`
  prints request logs + every SQL statement with params and timings.
- Inspect the data the test left: `KEEP_TEST_DB=1 npx vitest run <file> -t "<name>"` → prints a
  psql URL for that test's database (`psql "<url>"` via `pnpm dc exec db-test psql ...`).
- Global setup error = environment, not code: read its Fix line.

## Is it mine? (baseline triage)
`pnpm test:report` compares against `.test-reports/baseline.json`:
- **NEW** failures → yours until proven otherwise. A/B: `git stash` → rerun that file → if it
  still fails, it predates your change (record it, don't silently baseline it).
- **KNOWN** failures → pre-existing, which does not mean ignorable (CLAUDE.md §11): small → fix
  now in its own commit; otherwise make sure it is in `docs/followups/`.
- Update the baseline only deliberately (`pnpm test:report --set-baseline`) and say so.
- Flaky? Run the single test 5× (`--repeat=5` / loop). Flaky is a bug: usually shared state
  (missing `uniq()` on e2e), ordering assumptions without ORDER BY, or timestamps.

## Rules
- Never pipe long runs through `tail` (buffers until exit) — read the log file.
- Don't run two full integration runs at once on the same machine unless needed (they're
  isolated, but share CPU and the test server's connection limit).
- When a test passes where you expected red, suspect the test/setup before celebrating.
- Report which layers ran and their counts; never "tests pass" without the layer.
