---
name: slice-review
description: Hand each built slice to the user for review in under 2 minutes - what changed, the few lines worth reading, the risks, the proof, and what was not done. Use at the end of every slice in the live session (after skill feature's green step), and whenever the user asks "what did you change", "walk me through it", or "what should I check".
---

# Slice review: make the agent's output easy to audit

In the live round the interviewers watch **how the user manages and reviews the AI's output**.
The agent's job is to make that review fast and honest: point the user at the risky lines, not
at everything.

## After each slice, before the next one

Post this, and nothing longer:

```markdown
### Slice <n>: <outcome in one line> — <commit sha>

| File | What changed | Look at |
|---|---|---|
| src/.../routes.ts | new GET /x, zod schema | [routes.ts:42](path:42) the 404 branch |
| ... | | |

**Read these 2–3 lines first:** the places where a wrong guess would hurt, as clickable
file:line links (a business rule, a SQL query, a status code, an auth or scope check).

**Assumptions I made:** the choices not in the design doc, one line each. These are the ones to
overrule.

**Proof:** red then green `<test name>`; layers run (integration / e2e). Not run: <...>.

**Not done / queued:** <...>, or none.

Say *next* for slice <n+1>, or point at a line to change.
```

## Rules
- **Stop after the review.** Don't start the next slice until the user says next (or answers
  the review). A minute of user reading is the point, not lost time.
- **Lead with risk, not volume.** At most 3 "read first" lines. Pick them by "what would break
  a client, or the regulator, if this guess were wrong".
- **Every assumption is listed.** If a choice was made without the user, it shows up here.
  Silent decisions are the failure mode the interviewers look for.
- **Show the diff on request:** `git show --stat <sha>`, then the hunks for the files the user
  names. Don't dump the whole diff unasked.
- **When the user finds a problem:** say whether it's a bug, a misunderstanding or a design
  gap (skill `triage`), fix it with a test that fails first (skill `repro-test`), and add the
  fix to the next slice review.
- **Keep it on the slice.** Tooling notes, follow-ups and refactors go in one line under "Not
  done / queued".
