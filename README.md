# Planet Express — service + database

[![ci](https://github.com/selama1/postman-interview/actions/workflows/ci.yml/badge.svg)](https://github.com/selama1/postman-interview/actions/workflows/ci.yml)

A PostgreSQL database and a TypeScript (Fastify) backend service, both containerised and started
with one command. The scaffolding is in place: query builder, migrations, config validation,
structured logging, error conventions, OpenAPI and a live-DB test harness. There is no business
schema yet; that comes with the data.

## Quickstart (fresh machine)

You need **Docker with Compose v2** and **curl**. Docker Desktop on macOS or Windows, or Docker
Engine on Linux. Node is not needed.

```bash
git clone https://github.com/selama1/postman-interview.git
cd postman-interview
docker compose up --build -d --wait
curl http://localhost:3480/health/db
```

A `200` with `"status":"ok"` means the service ran a real query on Postgres.

**Smoke test.** One command checks the whole path and explains any failure: prerequisites, build,
health, the DB round trip, migrations, error format and test mode.

```bash
sh scripts/smoke.sh              # add --failover to also stop the DB and watch the service recover
```

```
PASS  GET /health/db -> 200: service ran a real query on Postgres 17.12 (database "app", 10.2 ms)
...
15 passed, 0 failed, 0 warning(s)
SMOKE TEST PASSED: the service is up and talking to Postgres. API: http://localhost:3480
```

When a check fails, the script prints *what happened*, the *likely cause* and *how to fix it*,
with the relevant command output or container log lines. Run it on Windows from Git Bash with
Docker Desktop, or inside WSL if Docker runs there.

**Stop:** `docker compose down`. That keeps the dev data; add `-v` to delete it. The containers
restart with Docker until you stop them.

## What runs

`docker compose up` starts two containers:
- `db`: PostgreSQL 17, on host port **15432** (user/password/db: `app`/`app`/`app`)
- `api`: the service, on host port **3480**. It waits for the DB to be healthy, applies
  migrations, then serves.

The host ports are non-standard on purpose, so a local Postgres (5432/5433) or a dev server
(3000/8080) does not clash with them. Inside the Docker network the service reaches the database
at `db:5432`, so host ports never affect the connection. To use other host ports, set
`API_PORT` / `DB_PORT` in the shell or in `.env`.

## Verify the connection

```bash
curl http://localhost:3480/health/db
```

Expected response (200):

```json
{
  "status": "ok",
  "latencyMs": 10.2,
  "database": "app",
  "serverVersion": "17.12",
  "serverTime": "2026-11-13T07:52:12.556Z",
  "migrations": { "executed": 1, "pending": [], "latest": "0000_baseline" },
  "pool": { "total": 1, "idle": 1, "waiting": 0 }
}
```

The endpoint runs a real query through the service's connection pool. It returns the server
version, current database and migration state. If the database is unreachable it returns **503**
with the reason and how to fix it. To check the failure path, run `docker compose stop db` and
call it again, or use `sh scripts/smoke.sh --failover`.

Other endpoints:
- `GET /health`: liveness (no DB call)
- `GET /docs`: Swagger UI
- `GET /openapi.json`: OpenAPI 3.1. In Postman: *Import → Link →* `http://localhost:3480/openapi.json`

### Test mode

The compose stack runs with **API test mode** on. Any client can get an isolated, empty, migrated
database and use it with one header:

```bash
curl -X POST http://localhost:3480/_test/sessions          # -> {"id":"ts_...","expiresAt":...}
curl -H "x-test-session: ts_..." http://localhost:3480/health/db   # runs against that session's DB
curl -X DELETE http://localhost:3480/_test/sessions/ts_...
```

Sessions can also start from a named fixture (`POST /_test/sessions` with body
`{"fixture":"<name>"}`, list with `GET /_test/fixtures`). The fixture is seeded once and then
cloned, so each session costs the same as an empty one.

It is off by default and must stay off for any deployment that holds real data
(`TEST_SESSIONS_ENABLED=false`). When it is off, a request that carries the header is rejected
rather than served from real data. A header sent with an empty value is always rejected.

## Troubleshooting

`sh scripts/smoke.sh` diagnoses all of these itself. This table is the quick reference.

| Symptom | Cause | Fix |
|---|---|---|
| `port is already allocated` / `address already in use` | another program uses 3480 or 15432 | stop it, or `API_PORT=<port>` / `DB_PORT=<port>` (shell or `.env`) |
| `permission denied ... docker.sock` (Linux) | user not in the `docker` group | `sudo usermod -aG docker $USER`, then log in again |
| `Cannot connect to the Docker daemon` | daemon not running | `sudo systemctl start docker`, or start Docker Desktop |
| `unknown flag: --wait` / `docker: 'compose' is not a docker command` | Compose v1 or no plugin | install `docker-compose-plugin` (or update Docker Desktop) |
| Postgres exits: `database files are incompatible` | old data volume from another Postgres version | `docker compose down -v` (drops only this stack's dev data) |

## Stack

| concern | choice |
|---|---|
| language/runtime | TypeScript (strict), Node 24 (inside the image) |
| HTTP | Fastify 5 |
| validation + API schema | zod 4 → request validation and OpenAPI from one definition |
| DB access | Kysely (type-safe SQL query builder) + `pg` |
| migrations | Kysely migrator, applied on container start (`MIGRATE_ON_START`) |
| config | env vars validated at startup (`packages/service/src/config.ts`, `.env.example`) |
| logging | pino; JSON in containers, per-request `x-request-id`, slow-query logging |
| errors | RFC 9457 problem+json with `code`, `detail` (reason) and `fix` |
| tests | Vitest: unit · integration (live Postgres, new empty DB per test) · e2e (against this compose stack) |

## Development

Development and the test suite run on the host and need Node 24 and pnpm (`corepack enable`).

```bash
pnpm install
cp .env.example .env
pnpm up                 # compose stack (build + wait for healthy)
pnpm db:test:up         # throwaway Postgres for the integration tests (host port 55432)
pnpm test               # typecheck + unit + integration
pnpm test:e2e           # rebuild + journey + e2e suite against the stack
pnpm verify             # same check as curl /health/db, exit code 0 only when connected
pnpm preflight          # go/no-go checklist before a demo (add --quick to skip the test suite)
pnpm warm               # pull/build/prime everything so the stack starts without network
pnpm dev                # service with hot reload against the compose DB
pnpm migrate:make <name>
```

Layout, conventions and pitfalls: [docs/llms.txt](docs/llms.txt). Working agreements:
[CLAUDE.md](CLAUDE.md).
