---
name: repro-test
description: Write a failing HTTP-level integration test that reproduces a bug or pins a new behaviour BEFORE changing code, and prove it red for the right reason. Use at the start of any bug fix, when a user reports wrong behaviour, and as step 2 of the feature loop.
---

# Repro-first test

The failing test is the proof you understand the problem. Unit tests of a piece are not proof
the flow works.

## 1. Pick the call path
Reproduce through HTTP exactly as the client hit it: same method/path/query/body/headers, same
actor if there are several (API key/role header). Not by calling the repo function directly.

## 2. Arrange data inside the test
Each test has its own empty, migrated DB. Arrange via the API (preferred: it's the real path) or
via `t.db.db` (Kysely) / `t.db.query(sql)` for bulk or for states the API can't create (legacy
rows, corrupted imports).

```ts
import { describe, expect, it } from 'vitest';
import { useTarget } from '../harness/server.js';

describe('shipments: bug #<n> — <symptom as the user saw it>', () => {
  const t = useTarget();
  it('<expected behaviour, stated as the rule>', async () => {
    await t.db!.query(`insert into ... values ...`);           // arrange (or t.client.post)
    const res = await t.client.get('/shipments', { status: 'lost' });
    expect(res).toHaveStatus(200);
    expect(res.body.items.map((s: any) => s.id)).toEqual([...]);
  });
});
```
Name the test after the RULE ("cancelled shipments are excluded from revenue"), not the ticket.

## 3. Prove it red — for the right reason
`npx vitest run <file> -t "<name>"`. Read the failure: the matcher prints the full exchange.
- Fails because of the bug → good, proceed.
- Fails because of setup (typo, wrong route, missing table) → fix the test, not the code.
- Passes → you haven't reproduced it. Re-read the report; vary input; check you're on the same
  code path (logs: `TEST_LOG_LEVEL=debug TEST_LOG_SQL=true`). Don't "fix" an unreproduced bug.

For a test that guards a regression class, optionally confirm red on the pre-fix tree:
`git stash` the fix → run → red → `git stash pop` → green.

## 4. Fix, then widen
Make it green with the general fix (CLAUDE.md §7 — fix the class). Then ask: what other inputs
hit the same class? Add one more case if cheap. Run `pnpm test:changed`, then `pnpm test`.

## 5. Report
In the final message: test name + file, "red before / green after", and which layers ran.
