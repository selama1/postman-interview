---
name: client-surface
description: Build or change anything that consumes the HTTP API: a TypeScript SDK, a CLI, a Postman collection or environment, or an example script. Test mode (test sessions + test keys) is part of the client from the first commit, not added later. Use for "build an SDK", "add a CLI", "export a Postman collection", "make a client for X", or when a new endpoint must be surfaced in an existing client.
---

# Client surfaces (SDK / CLI / Postman) — test mode on by default

A client that can't run against an isolated DB can't be tested honestly: its tests either share
state (flaky, order-dependent) or mock the server (prove the mock). So every client surface
ships with test mode as a first-class option, and its own tests use it. CLAUDE.md §2c.

## 1. The contract every client exposes
| Concern | SDK (constructor option) | CLI (flag / env) | Postman (variable) |
|---|---|---|---|
| base URL | `baseUrl` | `--base-url` / `PE_BASE_URL` | `{{baseUrl}}` |
| credential | `apiKey` | `--api-key` / `PE_API_KEY` | `{{apiKey}}` |
| test session | `testSession` | `--test-session` / `PE_TEST_SESSION` | `{{testSession}}` |
| request id | `requestId` per call (optional) | `--request-id` | pre-request script |

- `testSession` set → every request carries `x-test-session`. Unset → header omitted entirely
  (never sent empty).
- Session helpers, exactly mirroring the server: `client.testSessions.create({ fixture? })`,
  `.delete(id)`, `.list()`, `client.fixtures.list()`; plus a convenience
  `Client.forTest({ baseUrl, apiKey, fixture? })` that creates a session and returns a client
  bound to it with a `dispose()` that deletes it.
- **Key environment** (once auth exists — CLAUDE.md §2d): the client never rewrites a key. It
  warns when a `sk_test_` key is configured without `testSession` (the server will answer 403
  `TEST_KEY_OUTSIDE_TEST_CONTEXT`), and `testSessions.create` / `forTest()` refuse a `sk_live_` key
  unless `allowLiveKey: true` is passed (env override `PE_ALLOW_LIVE_KEY_IN_TESTS=1`). The refusal
  happens before the network call and uses the same `code`/`fix` wording the server would.
- Errors: surface the server's problem+json as a typed error (`status`, `code`, `detail`, `fix`,
  `requestId`) — don't flatten it into a string. Retries: idempotent methods on 503/429/
  `RETRYABLE_CONFLICT` only; never on 4xx auth errors.
- Pagination: an async iterator over keyset pages (`for await (const s of client.shipments.list())`).

## 2. Tests for the client (live, isolated)
- The client's tests run against the compose stack (or `startTestServer`) and open one test
  session per test via `Client.forTest(...)` — same isolation model as `useTarget()` in e2e mode.
- Once auth exists, the client's tests authenticate with a test key from `TEST_API_KEY` only.
  Setup refuses a missing or `sk_live_` key before any request, and no test passes
  `allowLiveKey` (CLAUDE.md §2d).
  No HTTP mocks for anything the real server can answer.
- Required cases, per client surface:
  1. a request with `testSession` sees only that session's data (two sessions, two views);
  2. a request without it hits the main DB (or is refused when only a test key is configured);
  3. a problem+json error round-trips with `code` + `fix` + `requestId` intact;
  4. pagination walks every row exactly once (seed N via a fixture, assert N);
  5. (once auth exists) live key in `forTest()` → refused locally; test key without a session
     on a data route → 403 `TEST_KEY_OUTSIDE_TEST_CONTEXT`; live key on `/_test/*` in
     deployment → 403.
- Postman: the collection has a "Test mode" folder whose first request creates a session and
  stores `{{testSession}}`, and whose last deletes it; every request sends `x-test-session:
  {{testSession}}`. Postman sends a header even when its variable is empty, so a collection-level
  pre-request script removes the header when `testSession` is empty (production environment).
  The server answers a blank header with 400 `TEST_SESSION_INVALID`, so a forgotten variable
  fails loudly instead of touching real data.

## 3. Where things go
- SDK: `packages/sdk` (own `package.json`, built types, no runtime deps beyond `fetch`).
- CLI: `packages/cli`, built on the SDK — the CLI never speaks HTTP itself.
- Postman: generated from `/openapi.json` + a small post-processing script that adds the test-mode
  folder and variables (`scripts/postman/`), not hand-edited JSON.
- Docs: one "Testing your integration" section per client showing the `forTest` flow.

## Done checklist
- [ ] test-session option + helpers present · [ ] client tests use per-test sessions
- [ ] required cases 1–4 (and 5 once auth exists) green · [ ] `pnpm test` + `pnpm test:e2e` green
