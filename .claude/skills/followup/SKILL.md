---
name: followup
description: Record out-of-scope work you noticed (bug, missing test, cleanup, security concern) as a one-file entry in docs/followups/, or drain the queue in one batch. Use instead of spawning new sessions/task chips, and when the user says "drain/clear the follow-ups".
---

# Follow-up queue

Format and rules: `docs/followups/README.md`. Summary:

## Add
1. Is it small (minutes) and related? → do it now instead, while the context is warm.
2. Dedupe: `git grep -il '<symbol or keyword>' -- docs/followups/`.
3. Write `docs/followups/<yyyy-mm-dd>-<slug>.md` with frontmatter (title, severity
   security|correctness|dx|cleanup, size small|medium|large, area, found_by) and sections
   **Problem** (file:line evidence), **Done when** (observable result + proving test), **Notes**.
4. Commit it with the work that found it. List new entries in your final message; security items
   go at the top of the message.

## Drain (one batch)
1. `ls docs/followups/` → order: security, correctness, then size small→large. Skip `size: large`
   or design-open items: ask the user first.
2. Per item: repro test (skill `repro-test`) → fix → targeted tests → commit that deletes the entry
   file in the same commit.
3. After all items: `pnpm test` once, `pnpm test:e2e` if anything user-visible changed.
4. Unfinished item: leave the file, add a `**Status.**` paragraph (what was tried, where it stands).
