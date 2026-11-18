---
name: design-doc
description: The first deliverable of the live-coding round. The user and the agent write a design / implementation doc together before any code. The agent drafts fast, the user steers and decides, and nothing is built until the user says "approved". Use when the interviewer or user asks for a design doc, an implementation plan, "plan it first", or hands over the problem and data at the start of the live session.
---

# Design doc: plan with the user, then build

The interviewers watch **how the user works with the agent** on this doc, then judge the plan.
The doc must read as the user's: the agent proposes, the user decides. Speed matters, but this
step is not to be rushed into code.

## Protocol (what the user sees)

1. **Skeleton in about 3 minutes.** Run `pnpm data:recon data/raw` if data was handed over
   (skill `kickoff` §2). Then write `docs/design/<slug>.md` from the template below, filled in
   from the prompt and the recon. Every decision is marked **Proposed**, with options and a
   recommendation.
2. **Show it and stop.** Reply with a short table, not the whole doc:
   - the 3–5 decisions to make, each with your recommendation and a one-line tradeoff;
   - the open questions, batched;
   - the link to the file.
   End with: "Steer any of these, or say *approved*." **Write no code, migration or test
   until the user says approved** (or a clear equivalent: "go", "build it").
3. **Iterate in place.** For each user change, edit the doc section and change the decision from
   **Proposed** to **Decided (user)**, noting why in their words. Reply with what changed only
   (one or two lines), not the whole doc again. If the change ripples, say where ("this moves
   pagination into slice 2").
4. **Push back when it matters.** If the user's choice has a cost they may not have seen, say
   it in one sentence, then do what they chose. Don't argue twice.
5. **On approval:** copy each **Decided (user)** item into `docs/decisions.md` as the user's,
   commit the doc (`design: <app> plan approved`), then build slice 1 (skill `feature`), and
   end every slice with skill `slice-review`.

## Template (keep it under two screens)

```markdown
# <App name>: design

## Goal
One paragraph: who uses it (customer / stakeholder / regulator / agent), what job it does for
them, and what "working" means at the end of this session.

## Users and surface
| Actor | Needs | Surface (route / tool / page) |

Why this surface: one sentence (e.g. "an MCP server because the user is an agent").

## Data
Tables touched or added, keys, the constraints that enforce the rules. Data issues from recon
and what we do with each (reject / quarantine / coerce), with row counts.

## Decisions
| # | Decision | Options | Recommendation | Status |
Status is **Proposed** or **Decided (user): <reason>**.

## Out of scope (said out loud)
What we won't build today, and why (time, marginal value). Queue those in docs/followups/.

## Slices
Each slice takes about 10 minutes, ends committed and green, and can be reviewed on its own.
1. <smallest end-to-end slice> — proof: <test names / e2e check>
2. ...

## Risks and how we'd know
The 2–3 things most likely to be wrong, and the test or check that would catch each.

## Open questions
```

## What makes a good doc here
- **Starts from the users and the data**, not from the stack. The stack is already decided.
- **Decisions have options and a recommendation.** A plain list of choices reads as indecision;
  a recommendation the user overrules shows that the user leads.
- **Slices are vertical** (one route through the DB to a test) and small enough to review.
- **The regulator gets an explicit answer:** audit trail, immutability, retention, or why not.
- **Says what is not being built.** Scope cuts read as judgment.
- **States the proof** for each slice before it is built.

## Anti-patterns (seen in practice)
- Code before approval. In practice 02, building before the design discussion was the main
  criticism.
- A 5-page doc. The interviewers have 45 minutes; two screens at most.
- Pre-deciding user choices silently. Every real choice shows up in the Decisions table.
- Re-pasting the whole doc after each edit. Show the diff in one or two lines.
