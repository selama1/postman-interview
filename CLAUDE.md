# CLAUDE.md — Planet Express service

Interview project: Postgres + a TypeScript/Fastify service, both in Docker Compose. A live session
will hand over Planet Express data and feature requests (cargo, customers, stakeholders, a
regulator). The scaffold is deliberately data-agnostic. **Read `docs/llms.txt` first** — it is the
orientation manual (layout, commands, conventions, pitfalls).

Rules use the same format: rule → **Why** (the incident) → **How to apply**.

---

## Operating principles

### 1. Repro first, at the user's call path
A bug fix or cross-layer change lands with an HTTP-level integration test that FAILS on the
current code. That red run is the proof the problem is understood. Unit tests alone are never
cited as proof that a feature works.
- **Why:** pieces passing in isolation ≠ the flow working. (2026-11-13: the harness built its DB
  pool by hand and silently dropped `statement_timeout`; only the HTTP-level timeout test caught it.
  Fix was one shared `createDbFromConfig` for prod and tests — no second copy.)
- **How to apply:** skill `repro-test`. Write the test via `useTarget()` + `t.client`, run it, see it
  red for the *right* reason, then fix. Never claim "tests pass" without saying which layer ran.

### 2. Live tests against a real Postgres, empty DB per test — no DB mocks
Integration tests run against the `db-test` container. Each test gets its own database cloned
from the sealed, migrated template (`freshDb()` / `useTarget()`).
- **Why:** mocks prove the mock. Template cloning makes real-DB isolation cheap (~50–150 ms).
- **How to apply:** if `db-test` is down, tests FAIL with the fix (`pnpm db:test:up`) — never skip
  or mock around it. Mocks are fine only for pure logic (unit project).

### 2b. Every route reads `req.db` — API test mode is on by construction
Clients isolate themselves with `x-test-session` (POST /_test/sessions → empty migrated DB). It
works for every endpoint only because handlers use `req.db`, never `app.db`.
- **Why:** e2e, SDK and Postman-collection tests need the same "empty DB" guarantee against the
  real container that integration tests get in-process (same idea as XCiteDB's test sessions).
- **How to apply:** pass `req.db` into repo functions (they take an `Executor`). The static test
  `req-db.static.test.ts` fails on `app.db` in routes. Non-DB state a handler keeps (caches, jobs,
  webhooks) must key on `req.testSession`.

### 2c. Every client surface ships test mode by default
Any SDK, CLI, Postman collection or example client exposes `testSession` (plus create/delete/list
session helpers and a `forTest()` convenience) from its first commit, and its own tests run with
one test session per test against the real server.
- **Why:** a client without test mode can only be tested against shared state or mocks. The
  isolation the server offers is worthless if the client can't reach it.
- **How to apply:** skill `client-surface` (contract table, required test cases, Postman wiring).

### 2d. API keys are environment-scoped: live vs test (design rule — not built yet)
When auth is added, every key carries an environment in its prefix and record
(`sk_live_…` / `sk_test_…`, stored as `key_env`), modelled on XCiteDB.
- A **test key** may only touch data inside a test session: on data routes without
  `x-test-session` → 403 `TEST_KEY_OUTSIDE_TEST_CONTEXT` (fix: create a session with
  `POST /_test/sessions` and send the header). It may call the `/_test/*` lifecycle routes.
- A **live key** never needs the header for live data. In deployment, `/_test/*` requires a test
  key, which closes a gap XCiteDB left open (a live key could create test sessions there). Keys
  that test sessions create, or are created inside one, are always `test`.
- Clients refuse a live key for test-session work unless explicitly overridden (`allowLiveKey`),
  and warn when a test key is configured without a session.
- **Tests authenticate with a test key, always** (integration, e2e, scenarios, SDK/CLI/Postman
  tests, probes). This gives two independent layers: the session isolates the data, and the key
  makes the server refuse anything outside a session. Either layer alone stops a production write.
  - The harness reads the key only from `TEST_API_KEY`, never from the app's own key variable,
    and never falls back to a live key. Global setup (integration and e2e) FAILS before any test
    runs if the key isn't `sk_test_…`. The failure names the variable and the fix ("set
    TEST_API_KEY to a test key; live keys are never used by tests"). Test suites never set
    `allowLiveKey`.
  - Integration tests mint their test key inside each fresh DB. e2e gets one from `.env`.
  - A test that must exercise live-key behaviour (e.g. "live key on `/_test/*` → 403") mints that
    key inside its own isolated DB or session. It is never a real production key.
- **Why:** a test suite or a mis-set environment variable must never be able to mutate production
  data or trigger real side effects (emails, webhooks). Making "test" a property of the credential
  means the failure is a loud 403, not silent writes to real data. Tests are the most likely
  source of such writes, so they get both layers (user's rule, 2026-11-13).
- **How to apply:** don't build auth until the session needs it. When it does, implement this
  model rather than a single key type, and record the choice in `docs/decisions.md`.

### 3. Never say "done/ready" without the layer that proves it
"Done" = `pnpm test` green (typecheck rides `pretest`) **and**, for anything user-visible,
`pnpm test:e2e` green against the rebuilt container. State which layers ran.
- **Why:** a working dev server proves nothing about the image the interviewers will run.
- **How to apply:** skill `e2e`. If you could not run a layer, say so explicitly — don't round up.

### 4. Every failure states the reason AND the fix
API errors are problem+json with `code`, `detail` (exact state), `fix` (what to do), `requestId`.
The same applies to scripts, test-harness errors, and messages you write to the user.
- **How to apply:** throw `AppError`/helpers from `src/http/errors.ts`; prefer DB constraints
  (mapped centrally to 409/422) over app-level pre-checks. When fixing an opaque failure, the fix
  isn't done until the next person hitting it is told why and how without reading source.

### 5. Full solution, not the stopgap
Ship the proper solution unless (1) it's unrealistic in the time, (2) it has measurable serious
drawbacks, or (3) its benefit is marginal. If you take an exception, **name which one** and record
the deferred full solution in `docs/followups/`.
- **Why:** stopgaps in a live session read as not knowing the right answer. Naming the tradeoff
  reads as judgment.

### 6. Ask before decisions that are the user's
Schema shape for ambiguous data, API contract choices with real tradeoffs (pagination style,
error semantics, auth model), anything costly to reverse. Present 2–3 options with a
recommendation; record the answer in `docs/decisions.md` as **theirs**.
- **How to apply:** decisions already made are listed in `docs/decisions.md` — don't relitigate them.

### 7. Fix the class, not the instance: root cause, idiomatic fix, permanent regression test
Don't patch the symptom. Trace to the most general root cause and fix it the way this codebase
already does that kind of thing: a DB constraint instead of a pre-check, the shared helper
instead of a second copy, the central error mapping instead of a local try/catch. No
sample-specific rules (special-casing one bad row, a regex for one value). State the general
rule the fix encodes.
- **Regression test at the right level, kept forever:** the minimal reproducer that failed
  before and passes after, at the user's call path (HTTP, §1). If the root cause is pure logic,
  add a unit test for the class too. Container, env or migration-on-start causes add an e2e
  journey check. Never delete a regression test to get green.
- **Why:** (2026-11-13) a test flake was really a reaper judging other instances' sessions by
  its own TTL. Fixing "the flaky test" would have hidden a production bug. Fixing the class
  (expiry stored with the session) removed both.
- **How to apply:** skills `debug` → `repro-test`. Commit body: symptom → root cause → why this
  fix is general → tests.

### 8. Code shape: separated concerns, small surfaces, abstraction only at real seams
- **Layers:** route (HTTP: schemas, status codes, actor) → service function (rules; pure where
  possible) → repo (SQL; takes an `Executor`). Routes don't hold business rules, and repos don't
  know HTTP. Follow `test/fixtures/widgets.ts` before inventing a new shape.
- **Surfaces:** few, explicit, typed. Domain names, options objects over positional booleans,
  one obvious way to do each thing.
- **Seams:** the DB seam already exists. Kysely plus repo functions over `Executor` means
  swapping Postgres for another SQL engine touches the dialect and repo SQL, not handlers. Don't
  add interfaces, factories or plugin systems with one implementation "for later". In an
  interview, name the seam and the swap cost instead of building it.
- **DRY by knowledge, not by text:** one source of truth per fact (zod schema → validation +
  OpenAPI + types; `config.ts`; `createDbFromConfig`; `errors.ts`). Two similar-looking
  paths that will diverge can stay separate. A duplicated *rule* gets extracted.
- **Why:** the interviewers read the diff live. Clear layers and named tradeoffs read as
  judgment; speculative abstraction reads as time lost.

### 9. The code is the signal (AX/DX): shape first, docs second
Clients (humans, and AI agents writing against the API/SDK) follow the shape, not the docs.
Names, parameter shapes, return types, discriminators and the error body are the **first line
of defence**. `docs/llms.txt`, OpenAPI descriptions and the README are the **second**, and only
catch readers who go look.
- **The shape-only question:** if a client only saw the route, its schema and its error
  responses (or the SDK signature and its JSDoc), would it write correct code? If not, fix the
  shape before the docs.
- **Apply it:**
  - typed discriminators over prose (`status: 'delivered' | 'lost'`, not "check the notes field");
  - names that encode intent and constraints;
  - responses that name the branch taken (no silent success: `created` vs `already_existed`);
  - refusals that name the right alternative (§4: `code` + `detail` with the exact state +
    `fix` quoting the call to make).
- **Triage before fixing** a reported problem (skill `triage`): server bug, gap, AX/DX issue, or
  client misunderstanding. A misunderstanding is usually an AX/DX bug: the shape or the error
  taught the wrong model, so fix that, not just the client.
- **Why:** the user's XCiteDB rule ("the code is the signal"), learned from agents writing
  `register → login` flows that broke on a branch the return type hid.

### 10. Security baseline: secure while coding, quick audit on request
- Secrets only through env and `config.ts`, never in code, logs, errors or commits. New
  secret-bearing fields go into the logger's redaction list.
- Raw SQL only via Kysely or `sql` templates (bound parameters). Identifiers from input only
  through allowlists. `LIKE` input through `likeEscape`.
- Every input is validated (zod, with bounds). No spreading of request bodies into rows.
  Server-owned columns are never client-settable.
- Multi-actor data: scope in the query, return 404 for others' rows, and prove it with a
  two-actor test. RLS versus app-level scoping is the user's decision (§6).
- **How to apply:** skill `security-audit` (10-minute time box) when asked, before presenting
  auth or multi-user features, and as the security lens of `lens-review`. Report what was not
  checked.

---

## Orchestration (skill `orchestrate`)
- **Main agent (Opus/Fable):** design, contracts, schema, decisions, synthesis, final review, edits
  that need judgment.
- **Sonnet subagents:** bounded implementation from a written spec, reviewer lenses, data-profile
  interpretation, first-pass test-failure triage.
- **Haiku subagents:** find/grep/read-and-report, run suites and summarize, log scraping,
  mechanical edits.
- Rule: *find/verify/run and report back → delegate. decide/design → keep.* "It's one small file"
  is not an exemption for searches. Launch independent subagents in ONE message (parallel).
- Every subagent prompt includes the FOREGROUND block (see `.claude/skills/orchestrate/SKILL.md`).
- Verify the 1–2 facts your decision hinges on yourself instead of trusting a summary.

## Git
- `main` = the vanilla interview submission. **Practice code never lands on main** (the
  `pre-commit` hook blocks `practice/` paths on main). Practice lives on the `practice` branch /
  `C:\devel\postman-interview-practice` worktree, one `practice/<nn>-<slug>` branch per attempt.
- `origin` = the PUBLIC GitHub repo `selama1/postman-interview` (the submission link): `main`
  only. **Practice work stays local, never pushed.** The `pre-push` hook blocks practice branches
  and any commit containing `practice/`. Never bypass it with `--no-verify`; that call is the user's.
- Commit when the work is complete and tested — don't wait to be asked. One commit per coherent
  unit. Stage only relevant files; leave `git status` clean. **Never push unless asked.**
- Commit subject: `area: behaviour, phrased as an outcome` (e.g. `shipments: list is keyset-paginated and filterable by status`).
  Body: Cause/Fix (for bugs), tradeoffs taken (cite principle 5 exceptions), `Tests:` listing the
  layers/files that prove it.
- Never commit `.env*`, data dumps (`data/raw/`), or files you haven't read.

## Follow-ups go in the queue, not in new sessions
Out-of-scope work you notice → one file `docs/followups/<yyyy-mm-dd>-<slug>.md` (skill
`followup`). Small ones: just do them now while context is warm. List new entries in your final
message. Don't spawn sessions/chips for follow-ups unless asked.

## Environment gotchas (Windows host)
- Docker Engine runs **inside WSL Ubuntu**, not Windows. `pnpm dc ...` / `scripts/dc.mjs` routes
  `docker compose` through `wsl -e` automatically. Run **git from Windows**, never from WSL on
  `/mnt/c` (line-ending churn).
- **WSL idles out** when no Windows-side wsl process is alive, stopping dockerd → containers stop.
  (2026-11-13: `db` vanished mid-session; `api` restarted, `db` didn't.) Fixed with
  `restart: unless-stopped` on all services; for long sessions keep a `wsl -e sleep infinity`
  running in a background terminal.
- **PowerShell 5.1 file writes corrupt UTF-8** (`Set-Content` = ANSI; em dash → `â€”`). Write files
  with the Write/Edit tools or Python with `encoding='utf-8', newline=''` — never PowerShell.
- `process.exit()` right after `fetch` on Windows can trip a libuv assertion (exit 127): set
  `process.exitCode` instead.
- Long test runs: never pipe through `tail` (buffers until exit). Use `pnpm test:report` (writes
  `.test-reports/*.log`) and read the log.

## Pointers
- Orientation + conventions + pitfalls: `docs/llms.txt`
- Decisions log: `docs/decisions.md` · Follow-up queue: `docs/followups/`
- Reference resource (copy this shape): `packages/service/test/fixtures/widgets.ts` and its test
  `packages/service/test/integration/harness-widgets.test.ts`
- Skills: `.claude/skills/*` · Subagents: `.claude/agents/*`
