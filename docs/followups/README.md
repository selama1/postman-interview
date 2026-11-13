# Follow-up queue

One file per item: `docs/followups/<yyyy-mm-dd>-<slug>.md`. One file each so parallel sessions
never conflict. Commit new entries with the work that found them; list them in your final message.

Small items: don't queue — do them now while the context is warm.

## Entry format

```markdown
---
title: <one line>
severity: security | correctness | dx | cleanup
size: small | medium | large
area: <module / resource>
found_by: <session / skill / test that found it>
---

**Problem.** What is wrong or missing, with file:line evidence.

**Done when.** The observable result + the test that proves it.

**Notes.** Options considered, links, anything the implementer needs.
```

`size: large` or an open design question → the user decides before anyone starts.
Security items: also put a line at the top of your final message.

## Draining the queue (one batch, not one session per item)
Per item: implement → targeted tests → commit, deleting the entry file in that item's commit.
Then run the full gate (`pnpm test`, `pnpm test:e2e` if user-visible) once. An item that can't be
finished goes back with a `**Status.**` paragraph explaining where it stands.
Dedupe before adding: `git grep -il '<symbol or slug>' -- docs/followups/`.
