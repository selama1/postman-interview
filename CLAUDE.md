# CLAUDE.md — Planet Express service

Interview project: Postgres + a TypeScript/Fastify service, both in Docker Compose. A live session
will hand over Planet Express data and feature requests (cargo, customers, stakeholders, a
regulator). The scaffold is deliberately data-agnostic. **Read `docs/llms.txt` first** — it is the
orientation manual (layout, commands, conventions, pitfalls).

Rules use the same format: rule → **Why** (the incident) → **How to apply**.

---

## Mode: interview (the default) or prep

**Interview mode is the default in this repo.** **Prep mode** (harness and tooling work, like
building this scaffold) applies only when the user says so: "prep mode", "we're preparing",
"harness work". It ends when they say "interview mode" or "I'm in the interview". If unsure, it's
interview mode. The session brief prints the mode. In prep mode, everything below this section
applies as written.

**Why:** the live session is about 45 minutes with follow-up questions. Full-suite reruns,
multi-lens reviews and probes nobody asked for leave the user waiting, and the user's own
auditing is worth more than the agent's thoroughness. Speed is the constraint; correctness stays
non-negotiable.

**Rules in interview mode** (they narrow, never replace, the principles below):
1. **Quick answer first, then offer more.** Answer in 1–3 minutes from what one pass shows, as
   a table, then offer the deeper probe ("want me to check X?"). For data: run `pnpm data:recon
   data/raw` once and answer from its summary. Don't run follow-up probes unasked.
2. **Tight test loop.** While iterating, run only the affected test file (`npx vitest run <file>`,
   or `pnpm test:changed`). Run `pnpm test` plus `pnpm test:e2e` **once per deliverable**, at the point
   you'd say "done", not after each step. §3 still holds: no "done" without them.
3. **Fix-or-queue (§11) with a stricter bar.** Fix only what blocks the current answer. Say
   everything else in one line ("found X, queued") and queue it in `docs/followups/`.
4. **No multi-agent review unless asked.** At most a one-line self-check of the riskiest point
   before saying done. Run `lens-review` only on request.
5. **Fewer blocking questions.** For a decision with a sound default, state it in one line ("I'm
   rejecting orphans; say if you'd rather keep them") and proceed. Ask (§6) only when no default
   is defensible, or the choice is costly to reverse. Batch any open questions into one ask.
6. **Sanity-check implausible numbers before reporting them.** Ask "is this the data or our
   conversion?" when a reject or anomaly category exceeds a few dozen rows.
   - **Why:** a large reject category is often our own artifact, e.g. date-only values read as
     midnight make every same-day pair look out of order. Reviews and row accounting miss it.
7. **Short replies.** Lead with the answer. Tables over prose, no recaps of earlier turns.
   Narrate tradeoffs in one sentence each, so the user can repeat them to the interviewers.

8. **Buy wall time with parallelism, never with waiting.** Wall-clock time is the critical
   resource. Agent tokens are second, and the user's attention is the one thing never to waste.
   - **Split independent pieces** that take more than about 3 minutes each (a resource's routes vs.
     its import rule tests; two endpoints with a fixed contract): main keeps the critical path and
     the judgment, and a Sonnet subagent takes the other piece from a written spec, in the same
     message.
   - **Don't delegate small tasks** (under about 2 minutes, or anything you would need to re-check
     line by line). Briefing plus a 30–60 s start plus verifying costs more than doing it.
   - **Long runs go in the background** (`pnpm test`, `pnpm test:e2e`, a rebuild,
     `run_in_background`). Start the next independent edit while they run; read the log when
     they finish.
   - **Delegate for cost too:** big outputs (logs, test output, profiles, wide greps) go to a
     Haiku agent that returns a summary, instead of flowing through the main model.
   - **Model tiers stay as in Orchestration:** Haiku for find, run and report; Sonnet for bounded
     code or review from a spec; main for decisions and synthesis. Verify the 1–2 facts a
     subagent's result hinges on before building on it.
   - **Main owns every shared resource** (git, the dev stack, migrations and staging on the dev
     DB, `.env`) unless a prompt hands one over explicitly. One writer per file. Ownership table:
     skill `orchestrate`.
   - **Why:** running independent pieces one after the other, and waiting in the foreground on
     full-suite runs, costs minutes of the user's 45.

9. **Doc first, then reviewable slices** (the live round's real format). The first deliverable
   is a design doc the user steers (skill `design-doc`): the agent drafts it in about 3 minutes,
   marks every choice Proposed, and writes **no code until the user says approved**. Then each
   slice of about 10 minutes ends with skill `slice-review` (the lines to read, the
   assumptions, the proof), and the agent waits for "next".
   - **Why:** in the live round the interviewers first watch the user and agent write the
     doc, then watch how the user manages and reviews the AI's output. Code before the design
     discussion, or code the user never read, fails both.

**Before the interview:** this directory is a clean clone of `origin/main` and nothing else.
`pnpm preflight` checks it (only `main`, no stray untracked or ignored files, empty `data/`).
Prep and harness work happen in a separate clone and reach this one only through `origin/main`.

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
- **How to apply:** skill `client-surface` (contract table, required test cases, Postman wiring);
  skill `ui-surface` for a web page (thin UI, `?testSession=`, container check, optional Playwright).

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
  know HTTP. New resources start from `pnpm gen:resource`, which encodes this shape; edit its
  output rather than hand-copying `test/fixtures/widgets.ts`.
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

### 11. Issues you find on the way: fix it now or queue it, never ignore it
Any bug, flake, security gap, misleading error or doc drift you notice, related to the task
or not, gets exactly one of two outcomes:
- **Fix it now** if it is small: a clear cause, a fix of minutes, and it doesn't stall or
  destabilise the main task. It gets its own commit and its own regression test (§7), separate
  from the main change.
- **Queue it** otherwise: one file in `docs/followups/` (skill `followup`), with file:line
  evidence and a "done when".
- **Never** drop a potentially impactful issue because "it's not mine", "it's pre-existing" or
  "the test passed on retry". A flake is a bug until shown otherwise.
- **Why:** user's rule across projects. (2026-11-13) a "flaky" fixtures test turned out to be a
  reaper deleting other instances' live sessions. It was found only because the unrelated red
  run was chased, not retried.
- **How to apply:** list what you fixed in passing and what you queued in the final message,
  with security items first. Don't spawn sessions or chips for follow-ups unless asked; the
  queue is the mechanism. In a live session, say "found X, fixing it now (2 min)" or "found X,
  queued it" so the interviewers see the triage.

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
- `main` = the vanilla interview submission, and the only branch in this clone.
- `origin` = the PUBLIC GitHub repo `selama1/postman-interview` (the submission link): `main`
  only. The `pre-commit` and `pre-push` hooks refuse `practice/` paths on `main` and pushes of `practice*` branches.
  Never bypass them with `--no-verify`; that call is the user's.
- Commit when the work is complete and tested — don't wait to be asked. One commit per coherent
  unit. Stage only relevant files; leave `git status` clean. **Never push unless asked.**
- Commit subject: `area: behaviour, phrased as an outcome` (e.g. `shipments: list is keyset-paginated and filterable by status`).
  Body: Cause/Fix (for bugs), tradeoffs taken (cite principle 5 exceptions), `Tests:` listing the
  layers/files that prove it.
- Never commit `.env*`, data dumps (`data/raw/`), or files you haven't read.

## Environment gotchas (Windows host)
- Docker Engine runs **inside WSL Ubuntu**, not Windows. `pnpm dc ...` / `scripts/dc.mjs` routes
  `docker compose` through `wsl -e` automatically. Run **git from Windows**, never from WSL on
  `/mnt/c` (line-ending churn).
- **WSL idles out** when no Windows-side wsl process is alive, stopping dockerd → containers stop.
  (2026-11-13: `db` vanished mid-session; `api` restarted, `db` didn't.) Fixed with
  `restart: unless-stopped` on all services, and `scripts/dc.mjs` now starts a detached keep-alive
  (`pe-keepalive`) on any up/start through WSL, so `pnpm stack:up` covers it. `pnpm preflight` checks it.
- **Before the live session:** `pnpm warm` (once, on good Wi-Fi: images and pnpm store local,
  the stack starts offline), then `pnpm preflight` that morning (go/no-go with fixes).
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
