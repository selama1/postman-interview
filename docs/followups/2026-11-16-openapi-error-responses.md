---
title: OpenAPI documents only the 200 response of each route
severity: dx
size: medium
area: src/http (errors, query, pagination)
found_by: lens review (api-contract)
---

- **Evidence:** routes declare `response: { 200: ... }` only, so `/openapi.json` shows no 400/404
  problem+json bodies, though every route returns them (`code`, `detail`, `fix`, `requestId`).
  Also: `csvList` renders as `anyOf[string, array]` with no enum, and timestamps are plain strings
  with no `date-time` format.
- **Seen in:** an api-contract lens review, 2026-11-16.
- **Fix:** a shared `Problem` zod schema in `src/http/errors.ts`, plus a helper
  `withErrors({ 200: X }, [400, 404])` that routes use. Have `csvList` emit the enum, and use an
  ISO timestamp schema with `format: date-time`.
- **Done when:** a test reads `/openapi.json` and asserts that a list route documents 400 with the
  problem schema, and that an enum filter lists its values.
