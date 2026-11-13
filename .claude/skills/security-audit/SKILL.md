---
name: security-audit
description: Quick security audit of the repo or the current change, time-boxed (~10 min) for a live session. Covers secrets, SQL/query injection, input validation, authz and data scoping (incl. RLS), data exposure, resource limits, test-mode exposure, container and dependencies. Use when the user asks for a security check or audit, before presenting a feature that adds auth, multi-user data or raw SQL, and as the security lens in lens-review.
---

# Security audit (time-boxed)

Goal: find the issues that matter in 10 minutes, verify each, fix the high ones with a repro
test, queue the rest. Every finding carries evidence (file:line or command output). No
theoretical issues and no "consider adding X" without a concrete risk.

Delegate the greps (Haiku `scout`, one message, report hits with file:line). Judge the hits
yourself: a grep hit is a lead, not a finding.

## 1. Secrets stay secret
- `git ls-files | grep -E '(^|/)\.env($|\.)|\.pem$|\.key$'`: only `.env.example` may match.
- History: `git grep -nIE 'sk_live_|gh[pousr]_[A-Za-z0-9]{20}|AKIA[0-9A-Z]{16}|BEGIN [A-Z ]*PRIVATE KEY' $(git rev-list --all)`.
- Secrets come only from env via `config.ts`. No real secret as a default in code or compose. Dev
  defaults (`app`/`app`) must be obviously dev.
- Logs: `logger.ts` redaction covers `authorization`, `cookie`, `x-api-key`, `*.password`,
  `*.token`. Any new secret-bearing field or header gets added there.
- Errors: in production an INTERNAL error never returns a stack trace or SQL. Check `errors.ts`
  and `NODE_ENV=production` behaviour.

## 2. Injection (SQL and query)
- All SQL goes through Kysely builders or the `sql` template tag, which binds parameters.
  Grep `src/` for leaks:
  `sql\.raw|sql\.(ref|id|table|lit)\(|\.query\(\s*\`[^\`]*\$\{|\+\s*req\.|whereRef\(.*req\.`
  Any user-controlled value in `sql.raw`/`sql.ref`/template-string SQL is HIGH.
- Identifiers from input (sort column, filter field) only through an allowlist (`parseSort`,
  `csvList(allowed)`), never interpolated.
- `LIKE`/`ILIKE` user text goes through `likeEscape`. Otherwise `%` and `_` are wildcards (a
  correctness and DoS issue).
- Database names and identifiers built in code go through `quoteDb` and a name regex
  (`SAFE_DB_NAME`).
- Other query languages (JSONPath, regex, `to_tsquery`): user text must not be able to change
  the query's structure. Use `plainto_tsquery`/`websearch_to_tsquery`, and keep regex fixed.

## 3. Input validation and mass assignment
- Every route declares zod schemas for `params`, `querystring` and `body`. Check that strings
  have max lengths and numbers have bounds.
- Inserts and updates map from an explicit DTO; never spread `req.body` into a table row. Check
  that server-owned columns (`id`, `created_at`, owner, role, status transitions) cannot be set
  by the client.
- List endpoints cap `limit` (`MAX_LIMIT`). No endpoint returns an unbounded result set.

## 4. Authorization and data scoping (when there is more than one actor)
- Every data route resolves the actor first and scopes **in the query** (`where customer_id =
  actor`), never by filtering after the fetch. Another actor's resource → **404**, not 403, so
  existence doesn't leak.
- Test with two actors: actor B gets 404 or an empty list for each of actor A's resources, for
  list, get, update and delete. That makes one `describe.each(actors)` HTTP test per resource.
- **RLS**, when chosen (decision is the user's, CLAUDE.md §6). The full option is policies on
  each table using `current_setting('app.actor_id', true)`:
  - Set it with `select set_config('app.actor_id', $1, true)` **inside the request's
    transaction** (equivalent to `SET LOCAL`). A plain `SET` leaks across pooled connections.
  - The app connects as a role that does not own the tables, or uses `FORCE ROW LEVEL
    SECURITY`; owners bypass RLS otherwise.
  - Policies are migrations, so they apply to every test DB and session automatically.
  - Application-level scoping is the cheaper option. Say which one you chose and why.
- Regulator / redacted views: redaction happens in the query or the DTO, with a test asserting
  that the redacted fields are absent (not just null).
- Test mode: `/_test/*` absent when `TEST_SESSIONS_ENABLED=false`; the header refused when off;
  a blank header refused. Once keys exist, see CLAUDE.md §2d.

## 5. Resource limits
- `statement_timeout` is set (`DB_STATEMENT_TIMEOUT_MS`), the pool is bounded, and Fastify's
  body limit is the default 1 MB unless deliberately raised.
- Expensive endpoints (reports, exports): bounded by date range or pagination. Rate limiting is
  a follow-up unless the session asks for it; name it.

## 6. Container and dependencies
- The runtime image runs as non-root (`USER node`) and installs from the lockfile only.
- `pnpm audit --prod`: report high/critical, with whether the vulnerable path is reachable.
- Published ports: the DB uses dev credentials. Exposing it on all interfaces is a LAN-exposure
  finding for anything beyond a laptop demo.

## 7. Report
Table: severity (high = exploitable now / data exposure; medium = exploitable under a plausible
condition; low = hardening), finding, evidence, fix. Fix highs now, each with a test that fails
first. Queue mediums with skill `followup`, naming the principle 5 exception. List lows. Say
what was **not** checked in the time box.
