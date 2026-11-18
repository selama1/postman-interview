---
name: sdk-cli
description: The live round's "app of your choice" (decided by the user, 2026-11-18) - a typed TypeScript SDK plus a CLI built on it, serving both people and agents. Use in the live session once the design doc is approved, or when asked to build, extend or demo the Planet Express SDK or CLI. Contract and test-mode rules come from skill client-surface; this skill is the recipe, the design-doc decisions and the slice plan.
---

# SDK + CLI: the live build

Nothing here exists on `main` before the session (the email says client components wait for the
live portion). This is the plan to build them in about 30 minutes, in reviewable slices.
**Contract, test mode and required tests: skill `client-surface`. Follow it.**

## The pitch (one line each, for the design doc's Goal and the interviewers)
- **One SDK, two audiences:** humans get a readable table, agents get `--json` with stable
  exit codes and the server's `code` + `fix` on errors. Same code path, different printer.
- **The spec is the source of truth:** SDK types are generated from `/openapi.json`, so a
  server change that breaks a client fails typecheck, not production. That is how Postman
  thinks about APIs.
- **Test mode is in the client from the first commit** (`forTest()`, `--test-session`), so the
  client's own tests run against the real server with isolated data.

## Decisions for the design doc (each Proposed, with the recommendation first)
| Decision | Recommendation | Alternatives | Tradeoff in one line |
|---|---|---|---|
| Types | Generated from `/openapi.json` (`openapi-typescript`, cached by `pnpm warm`) + a hand-written ergonomic layer | Import zod types from `service`; fully generated client | Generated types stay true to the wire; importing server types couples the SDK to server internals |
| HTTP | Built-in `fetch`, zero runtime deps | axios / ky / openapi-fetch | Fewer deps for users to audit; we write retries ourselves (small) |
| Errors | One `PlanetExpressError` with `status`, `code`, `detail`, `fix`, `requestId`; narrow on `code` | Error subclass per code | One class with a typed `code` union is easier for agents to handle; subclasses rot when codes are added |
| Lists | Async iterator over keyset pages, plus `listPage()` for one page | Arrays only | Iterator hides the cursor; `listPage()` keeps control for UIs |
| Retries | Only GETs and keyed POSTs (`Idempotency-Key`), on 429/503, with backoff | None; retry everything | A retried POST without a key can duplicate a write |
| CLI parsing | `node:util` `parseArgs`, zero deps | commander / yargs / oclif | Enough for ~6 commands; name the switch cost if it grows |
| CLI output | Table by default, `--json` for machines; errors as problem+json on stderr | JSON only | Serves both people and agents with one code path |
| Exit codes | 0 ok · 1 server refused (4xx) · 2 usage error · 3 unreachable / 5xx | 0/1 only | Agents and scripts branch on the cause without parsing text |
| Auth | Only what the service has (none today); `apiKey` option reserved per §2d | Add auth now | Building auth is a separate slice; say so instead of half-building it |

The commands follow the actors the assignment names; confirm them with the user in the doc:
- **customer:** `pe track <shipmentId>` (status + timeline);
- **stakeholder:** `pe shipments list --status ... --customer ...` (paginated);
- **regulator:** `pe audit export --from --to` (NDJSON stream of events, immutable history);
- **ops / agent:** `pe events post <shipmentId> --type ... --idempotency-key ...`;
- **test mode:** `pe test-session create|delete|list`.
Build only what the data and routes in the session support. Cut the rest in "Out of scope".

## Layout
```
packages/sdk/   package.json (name @planet-express/sdk, type module, no runtime deps)
  src/generated.ts     openapi-typescript output (pnpm gen:sdk-types), committed
  src/client.ts        PlanetExpress class: options, request(), test-session header, retries
  src/errors.ts        PlanetExpressError + isProblem()
  src/resources/*.ts   one file per resource: thin, typed methods
  test/*.test.ts       live tests, Client.forTest() per test (client-surface §2)
packages/cli/   package.json (bin: pe), depends on workspace:@planet-express/sdk
  src/main.ts          parseArgs, dispatch, exit codes
  src/print.ts         table vs --json, problem+json on stderr
  test/*.test.ts       spawns the CLI against the stack with --test-session
```
- Generate types: `npx openapi-typescript http://localhost:<API_PORT>/openapi.json -o
  packages/sdk/src/generated.ts`. Add it as `gen:sdk-types` in the root `package.json`. Add a
  test that fails when the committed file differs from a fresh generation (drift check).
- Add both packages to the vitest projects (or a `clients` project) so `pnpm test` runs them.
- The CLI never speaks HTTP: if a command needs a call the SDK lacks, add it to the SDK first.

## Slices (each ends with skill `slice-review`)
1. **SDK core** (about 10 min): client options, `request()`, problem+json error, test-session
   header, `testSessions` helpers and `forTest()`, plus one read method. Tests: client-surface
   cases 1–3.
2. **The resources the doc chose** (about 10 min): typed methods, keyset iterator. Test: case 4
   (pagination walks every row once).
3. **CLI** (about 10 min): `pe track` + one list command, `--json`, exit codes. Tests: spawn
   the CLI, assert stdout JSON, the stderr problem body and the exit code for a 404.
4. **Stretch:** the write command with `--idempotency-key` and retry, regulator export,
   README "Testing your integration". Otherwise queue them.

## Demo script (2 minutes, at the end)
1. `pe track SHP-0000001` → table; then `--json | jq .status`.
2. `pe track SHP-9999999; echo $?` → the problem body with `fix`, exit 1.
3. `pe test-session create` → `pe --test-session <id> shipments list` → empty: isolated data.
4. Show the drift check: change a response field name, and SDK typecheck goes red.

## Talking points for the SDK-team questions
- Generated vs hand-written SDKs: generate the types and transport, hand-write the ergonomics
  (iterators, `forTest`, error narrowing). A fully generated surface reads like the spec, not
  like the domain.
- Versioning: semver on the SDK; additive server changes are minor; the drift check and
  contract tests guard breaking ones.
- Agents as users: stable `code` values, `fix` text, `--json`, and exit codes are the agent's
  "docs". The code is the signal (CLAUDE.md §9).
