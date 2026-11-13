---
name: lens-review
description: Parallel multi-lens code review of the current change — several narrow Sonnet reviewers (correctness, SQL/performance, API contract/errors, security/input, tests) each writing JSONL findings, then the main agent aggregates, dedupes, verifies and ranks. Use before committing a substantial feature, when asked to review, or to self-check a live-session change before presenting it.
---

# Lens review: narrow reviewers in parallel, one aggregator

Narrowness is the design: each lens checks ONE property and must not consult the others.

## 1. Scope
`git diff --stat main...HEAD` (or `git diff` for uncommitted). Write the list of changed files
and a 3-line summary of intent — every lens gets the same scope block.

## 2. Launch lenses in ONE message (Sonnet `lens-reviewer` agents, parallel)
Pick the lenses that apply (3–5 is typical):

| lens | the one property it checks |
|---|---|
| correctness | logic matches the stated intent; edge cases (empty, null, boundaries, duplicates, time zones) |
| sql-perf | every query has a supporting index for its filter/sort at 100× volume; no N+1; transactions short; keyset correctness |
| api-contract | schemas match behaviour; status codes; problem+json with code+detail+fix; pagination envelope; OpenAPI accuracy; docs/llms.txt updated |
| security-input | injection (raw sql with user input), mass assignment, authz on every route that needs it, data leakage in errors/logs. The checklist is skill `security-audit` §1–5 |
| ax-dx | the shape-only question (CLAUDE.md §9): would a client get it right from route, schema and errors alone? Silent outcomes, vague `detail`, missing `fix` |
| tests | each behaviour/error code has an HTTP-level test; tests would fail without the change; no shared-state flakiness |
| concurrency | read-check-write races, missing constraints/locks, retry on 40001, idempotency |

Prompt per lens (fill in):
```
You are the <lens> lens. Check ONLY this property: <property>. Do not report other issues.
Scope: <changed files + intent>. Read the changed code and whatever it calls.
Write findings to .reviews/<stamp>/<lens>.jsonl, one JSON object per line:
{"file":"...","line":N,"severity":"high|medium|low","title":"...","evidence":"why this is real (quote code)","fix":"concrete change"}
Then reply with the number of findings and the top 3 titles.
Only report what you can point to in code; no style nits. Zero findings is a valid answer.
<FOREGROUND block from skill orchestrate>
```

## 3. Aggregate (main agent)
- Read all `.reviews/<stamp>/*.jsonl`. Dedupe by (file, nearby line, same root cause).
- **Verify each high/medium finding yourself** (open the code; for runtime claims write a quick
  repro test). Drop what doesn't hold — a lens report is a claim, not a fact.
- Rank: high (wrong results, data loss, security, 500s) → medium → low.
- Fix high now (repro test first); medium: fix or queue via skill `followup`; low: list only.
- Summarize to the user: table of verified findings + what you did with each. `.reviews/` is
  scratch output (gitignored) — don't commit it.
