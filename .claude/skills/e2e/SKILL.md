---
name: e2e
description: Prove behaviour end-to-end through the real docker compose stack (rebuilt image, migrations applied in the container, real HTTP) — run the journey and e2e suite, extend the journey for new flows, and diagnose stack failures. Use before saying any user-visible work is done, after migrations/Dockerfile/compose changes, and to demo.
---

# End-to-end through the container

`pnpm test:e2e` = `scripts/e2e.mjs`:
1. `docker compose up -d --build --wait` (image rebuilt from the working tree; db healthy first;
   api runs migrations on start; healthcheck on /health/db).
2. `scripts/e2e-journey.mjs` — PASS/FAIL/WARN line per check, markdown report in
   `.e2e-reports/journey-<stamp>.md`, exit 0 only if every CRITICAL check passes.
3. `vitest --project e2e` — `test/e2e/**` + every shared `test/scenarios/**` against
   E2E_BASE_URL (default http://localhost:3480).
Flags: `--no-build` (tests-only changes), `--down` (tear down afterwards).

**Isolation on the stack:** `useTarget()` in e2e mode opens an API test session per test
(`POST /_test/sessions`, header `x-test-session`), so scenarios get an empty migrated DB on the
real container too — no `uniq()` gymnastics, `paginationContract`-style "exactly these rows"
assertions hold. Manual: `curl -X POST localhost:3480/_test/sessions` then add
`-H 'x-test-session: <id>'` to any request. Any SDK/CLI/Postman collection ships with a
`testSession` option and is tested the same way — skill `client-surface`.

**Test key (once auth exists, CLAUDE.md §2d):** e2e, the journey and client tests send a
`sk_test_` key from `TEST_API_KEY` on every request, as well as the session header. Then a
request that loses its session (bug, blank variable) is refused with 403 instead of reaching
real data. `e2e-global-setup` and `e2e-journey.mjs` check the key prefix first and exit with the
fix if it is live or missing.

## Extending the journey for a new feature
In `scripts/e2e-journey.mjs` under "feature journeys", walk the flow as a client would:
create what you read (unique names: `${Date.now()}`), then list/filter/page, then the error path.
```js
const s = await call('POST', '/books', { ... });
check('create book -> 201 + location', s.status === 201 && s.headers.get('location'), `status ${s.status}`);
const l = await call('GET', `/books?authorId=${aid}`);
check('list by author includes it', l.json?.items?.some((x) => x.id === s.json?.id));
```
Non-critical observations (latency budgets, warnings) → `check(name, ok, detail, false)`.
Also prefer putting reusable journeys in `test/scenarios/*.test.ts` — they run on both targets.

## When e2e fails but integration passes
That gap is the point of e2e. Usual causes:
- image is stale → you ran `--no-build` after a src change
- migration not applied / failed on start → `pnpm dc logs api` (look for "Migration ... failed")
- env differs (NODE_ENV=production hides internal error detail; LOG_FORMAT=json)
- data from earlier runs on the shared dev DB (test assumed empty tables → use `uniq()`)
- container networking (service uses `db:5432`, host uses `localhost:15432`)
Diagnose with skill `debug` (start from the x-request-id in the failure output →
`pnpm dc logs api | grep <id>`).

## Demo / interviewer path
`docker compose up --build` then `pnpm verify` (or `curl localhost:3480/health/db`, or `sh scripts/smoke.sh`), `/docs` for
Swagger UI, `/openapi.json` to import into Postman.
