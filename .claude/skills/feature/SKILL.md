---
name: feature
description: The main build loop for any new endpoint, resource, report or behaviour change — contract first, failing HTTP-level test, migration, implementation, green, e2e, docs, commit. Use for "add X", "expose Y", "support Z", or any change a client of the API would notice.
---

# Feature loop

Each loop delivers one thin vertical slice that works through the container. Steps 1–2 are the
main agent's; steps 4–5 can go to a Sonnet `implementer` once the contract is written (skill
`orchestrate`).

## 1. Contract (write it down before code)
- Routes: method, path, purpose. Request zod schema (body/query/params), response schema, status
  codes, error codes (`code` + `fix` text) for every failure the client can hit.
- Data: tables/columns/constraints/indexes this needs. Which invariants are DB constraints.
- Tradeoffs worth saying out loud (pagination style, consistency, N+1, index cost). If a choice is
  the user's, ask (CLAUDE.md §6) and record in `docs/decisions.md`.

## 2. Tests first (repro-first — skill `repro-test`)
In `packages/service/test/integration/<resource>.test.ts`:
- contract packs where they fit: `crudContract`, `validationContract`, `paginationContract`,
  `uniqueRaceContract` (see `harness-widgets.test.ts` for the exact usage);
- a journey via `runScenario` for the business flow;
- explicit tests for each business rule and each error code from step 1.
Run them: `npx vitest run packages/service/test/integration/<resource>.test.ts`. They must FAIL
for the right reason (404 route / missing behaviour), not for a typo.
If the flow should also hold on the deployed stack, put the journey in `test/scenarios/` (runs
on both targets; use `uniq()` names, don't assume empty tables).

## 3. Migration
`pnpm migrate:make <name>` → edit. Conventions in docs/llms.txt §5 (identity ids,
`timestamptz(3)`, NOT NULL, CHECK/UNIQUE/FK, `(sort_col, id)` indexes, `set_updated_at` trigger).
Write `down()`. The test template rebuilds automatically on the next test run.
Add the table interface to `src/db/schema.ts`.

## 4. Implement
Copy the shape of `test/fixtures/widgets.ts`: route plugin with zod schemas, `toDto`, keyset
list with allowlisted sort + explicit filters, `notFound`/`badRequest`, constraints doing the
uniqueness/reference work. Register in `src/http/routes/index.ts`. Multi-statement invariants:
`withTransaction` (+ `forUpdate()` or serializable + retry).

## 5. Green
- The new test file green → `pnpm test:changed` → `pnpm test` (typecheck + all unit/integration).
- Look at one real response by hand (`curl -i` or `t.client` output) — shape, headers, problem body.

## 6. End-to-end
Add the flow to `scripts/e2e-journey.mjs` (a `check()` per step, critical by default).
`pnpm test:e2e` (rebuilds the image, applies the migration in the container, runs journey +
scenarios). Not done until this is green.

## 7. Docs + commit
- docs/llms.txt §4 API surface: one line per new route → `pnpm docs:check`.
- New pitfall discovered? add it to §7. New decision? `docs/decisions.md`.
- Commit (don't wait to be asked): `area: outcome` subject; body with tradeoffs and
  `Tests:` (files + layers run). Out-of-scope findings → skill `followup`.

## Done checklist (say it in the final message)
- [ ] failing test seen red, now green (name it)
- [ ] `pnpm test` green · [ ] `pnpm test:e2e` green
- [ ] docs:check green · [ ] committed · [ ] follow-ups listed (or none)
