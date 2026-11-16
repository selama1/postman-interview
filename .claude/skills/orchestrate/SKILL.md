---
name: orchestrate
description: How the main agent splits work between itself (Opus/Fable) and cheaper Sonnet/Haiku subagents — model tiers, parallel fan-out, the FOREGROUND prompt block, and how to verify subagent results. Use whenever a task has searching, test running, log scraping, bounded implementation or review that can be delegated, or independent parts that can run in parallel.
---

# Orchestrate: strong orchestrator, cheap workers

The main agent keeps **design, decisions, synthesis and judgment-heavy edits**. Everything that is
"find / verify / run and report back" goes to a cheaper subagent. A small task is not an
exemption: a 5-file grep sweep is still a Haiku job.

## Model tiers

| tier | use for | agent (.claude/agents) |
|---|---|---|
| **Main (Opus / Fable)** | schema + API contract design, choosing between options, synthesis of subagent results, edits that need judgment, final review, talking to the user | — |
| **Sonnet** | bounded implementation from a written spec (a route + its tests when the contract is fixed), lens reviews, interpreting a data profile, first-pass triage of failing tests | `implementer`, `lens-reviewer` |
| **Haiku** | locate code/usages, read & summarize files or docs, run test suites and report failures, scrape logs, mechanical multi-file edits (renames, import fixes) | `scout`, `test-runner` |

Decision rule: *if the step's output is a fact or a report → delegate. If it is a decision or a
design → keep it.* If a Haiku result will drive a decision, verify the 1–2 pivotal facts yourself
(open the file:line it cites) rather than upgrading the whole fan-out.

## Fan-out mechanics
- Independent subagents go out in **one message** (multiple Agent calls) so they run in parallel.
- Each prompt is self-contained: the goal, exact files/paths, the command recipe, what NOT to do,
  and the exact shape of the report you want back (e.g. "a table: file:line | finding").
- Writers never share files. Two implementers touching the same file = serialize them.
- Prefer one subagent per *independent* question, not one per file.
- Don't delegate the thing you'll have to redo: if the spec isn't written yet, write it first.

## The FOREGROUND block (paste into every subagent prompt)

```
FOREGROUND ONLY: do not use run_in_background and do not spawn sub-agents — do the work yourself
and return your findings as your final message. Long commands: foreground Bash with a timeout up
to 600000 ms. Long test runs: redirect output to a file (e.g. `pnpm test:report`, or
`... > .test-reports/run.log 2>&1`) and Read the file — never pipe through `tail`.
Docker/compose on this Windows host: use `node scripts/dc.mjs <args>` (it routes to WSL).
Never run git from WSL. Never write files with PowerShell (encoding corruption) — use the
Write/Edit tools. Do not commit.
```
Why: background-task notifications only wake the main conversation; a subagent that backgrounds
work parks and dies, or spawns orphan cascades.

## Recipes

**Parallel recon before designing** (Haiku ×2–3, one message):
- scout: "Where are list endpoints implemented and which pagination helper do they use? file:line table."
- scout: "Summarize docs/decisions.md and docs/followups/* — decisions + open items only."
- test-runner: "Run `pnpm test:report`; report pass/fail counts and NEW failures with first error lines."

**Implement after the contract is fixed** (Sonnet): give the zod schemas, route list, error codes,
SQL shape and the exact test names to write; tell it to copy test/fixtures/widgets.ts patterns and
to run `npx vitest run <its test file>` until green. You review the diff.

**Review** → skill `lens-review` (parallel Sonnet lenses + your aggregation). In interview mode,
only when the user asks for it.

## Interview mode: delegate for wall time (CLAUDE.md "Mode" rule 8)
The question is "does this finish sooner in parallel?", not "is this delegable?".
- **Split a resource into parallel pieces once its contract is fixed.** You write routes and
  repo; a Sonnet implementer writes the import cleaning-rule tests, or the second endpoint, from
  your spec, in the same message. Writers never share files.
- **Background, don't wait.** `pnpm test`, `pnpm test:e2e` and image rebuilds run with
  `run_in_background: true`. Keep editing, then read `.test-reports/*.log` when notified.
- **Don't delegate under about 2 minutes of work,** or a task whose output you'd re-read line
  by line. Briefing plus startup plus verification costs more.
- **What stays in main:** answering the user, decisions, the critical path, and the 1–2 checks
  the result hinges on.
- **Practice 01 lesson:** routes and import tests were written one after the other although they
  were independent, and 6 full-suite runs ran in the foreground. Together that was about 10
  minutes of the user waiting.

**Debug** → delegate log scraping / EXPLAIN collection to Haiku; keep hypothesis selection.

## Verify, don't trust
A subagent report is a claim. Before acting on it: check the diff (`git diff --stat`, open changed
files), re-run the decisive test yourself, and confirm cited file:line exists.
