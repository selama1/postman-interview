# Planet Express — service + database

A PostgreSQL database and a TypeScript (Fastify) backend service, both containerised and started
with one command. The scaffolding is in place: query builder, migrations, config validation,
structured logging, error conventions, OpenAPI and a live-DB test harness. There is no business
schema yet; that comes with the data.

## Run it

Requirements: Docker with Compose v2 (Docker Desktop, Docker Engine, or Podman with the docker shim).

```bash
docker compose up --build
```

This starts:
- `db` — PostgreSQL 17 on `localhost:5432` (user/password/db: `app`/`app`/`app`)
- `api` — the service on `localhost:3000`. It waits for the DB to be healthy, applies migrations,
  then serves.

## Verify the connection

```bash
curl http://localhost:3000/health/db
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
call it again.

Other endpoints:
- `GET /health`: liveness (no DB call)
- `GET /docs`: Swagger UI
- `GET /openapi.json`: OpenAPI 3.1. In Postman: *Import → Link →* `http://localhost:3000/openapi.json`

With Node 22+ and pnpm you can also run `pnpm install && pnpm verify`. It prints the same
response and exits 0 only when connected.

## Stack

| concern | choice |
|---|---|
| language/runtime | TypeScript (strict), Node 24 |
| HTTP | Fastify 5 |
| validation + API schema | zod 4 → request validation and OpenAPI from one definition |
| DB access | Kysely (type-safe SQL query builder) + `pg` |
| migrations | Kysely migrator, applied on container start (`MIGRATE_ON_START`) |
| config | env vars validated at startup (`packages/service/src/config.ts`, `.env.example`) |
| logging | pino; JSON in containers, per-request `x-request-id`, slow-query logging |
| errors | RFC 9457 problem+json with `code`, `detail` (reason) and `fix` |
| tests | Vitest: unit · integration (live Postgres, new empty DB per test) · e2e (against this compose stack) |

## Development

```bash
pnpm install
cp .env.example .env
pnpm up                 # compose stack (build + wait for healthy)
pnpm db:test:up         # throwaway Postgres for the integration tests (port 55432)
pnpm test               # typecheck + unit + integration
pnpm test:e2e           # rebuild + journey + e2e suite against the stack
pnpm dev                # service with hot reload against the compose DB
pnpm migrate:make <name>
```

Layout, conventions and pitfalls: [docs/llms.txt](docs/llms.txt). Working agreements:
[CLAUDE.md](CLAUDE.md).
