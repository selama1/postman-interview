---
name: triage
description: Classify a reported problem before fixing it. Is it a server bug, a missing capability (gap), an AX/DX problem (the API's shape, errors or docs teach the wrong model), or a client misunderstanding (usually AX/DX in disguise)? Then route it to the right fix. Use when the user, an interviewer, a test or a client reports "X doesn't work", "I expected Y", "the API returned Z", or hands over a list of asks.
---

# Triage: classify, then route

Two minutes here saves fixing the wrong thing. Output a one-line verdict per issue before
touching code.

## 0. Split and reproduce
- **Split welded reports.** "Search is slow and returns the wrong authors" is two issues.
  Triage each separately.
- **Reproduce at the reporter's call path** (same request, headers, actor; skill `repro-test`).
  Keep the `x-request-id`. If it doesn't reproduce, the verdict is "needs re-diagnosis": ask
  for the exact request, don't guess.

## 1. Classify (first match wins)
| class | test | route to |
|---|---|---|
| **Server bug** | the server violates its own contract: wrong data, 500, a documented behaviour that doesn't happen | skill `debug` → root cause → fix + regression test (CLAUDE.md §7) |
| **Gap** | the contract never promised it, and the ask is legitimate (missing filter, endpoint, field) | skill `feature`. If scope or contract is ambiguous, it's a decision for the user (§6). Out of scope now → skill `followup` |
| **AX/DX issue** | the server did what it promised, but the shape, name, response or error made the wrong usage natural or the right one undiscoverable | fix the **shape first** (CLAUDE.md §9), then the error (§4), then the docs |
| **Client misunderstanding** | the client used it wrongly, and the right usage was clearly signalled in shape and errors | answer it, and point to the signal they missed. Rare: before choosing this class, apply the shape-only question. If it fails, reclassify as AX/DX |

**A misunderstanding is presumed AX/DX** until the shape-only question passes: "from the route,
schema and error responses alone, would a careful client have done it right?"

## 2. AX/DX fixes, strongest first
1. **Shape:**
   - rename to encode intent;
   - a typed discriminator instead of an overloaded field;
   - make the wrong call impossible (schema rejects it) or loud (refusal naming the right call);
   - responses name the branch taken (`created` vs `already_existed`, `skipped: [{row, reason}]`).
2. **Error** (§4):
   - a stable `code`;
   - `detail` with the exact state ("author 42 has no books in 2026-Q3", not "not found");
   - `fix` quoting the request to make instead.
   
   Silent outcomes (empty 200, `null`, silently dropped rows) become explicit.
3. **Docs** (second line): the OpenAPI description on the route, `docs/llms.txt` §4/§7. Only for
   what the shape can't carry: multi-call invariants, security framing, why.

Every AX/DX fix gets a test asserting the new signal: the error code and its `fix`, or the
discriminator value.

## 3. Report (one line per issue, then act)
`<issue> → <class>: <evidence (request id / test name)> → <route: fix | feature | decision | followup | answer>`

In a live session, say the classification out loud before fixing. "This is AX/DX, not a bug:
the API did what it says, but the 200 with an empty list hid that the date filter was
ignored" reads as judgment.
