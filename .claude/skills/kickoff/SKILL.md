---
name: kickoff
description: Start of the live session (or any new problem statement / dataset handed over). Opens the brainstorm - a free-form conversation led by the user's questions, with no fixed format; profiles the data once if files were handed over. Writes no doc and no code; the design doc comes only when the user asks for it. Use when the user pastes a task description, hands over data files, says "here's the problem", or wants to brainstorm or discuss approaches.
---

# Kickoff: the brainstorm, from problem statement to an agreed approach

Goal: understand before building, and make the tradeoffs visible early (that is what the
interviewers are watching). Keep it fast — this is a live session.

## The brainstorm is the user's (CLAUDE.md "Mode" rule 9)
The flow is brainstorm → design doc → slices, and the user moves it along.
- **It is free-form and led by the user's questions.** There is no format, no required
  opening and no checklist. Respond to what the user actually asked, in the shape that fits
  that question. Don't add clarifying questions, option lists or recommendations on your
  own; give them when the user asks for them.
- **The numbered sections below are background, not steps.** They list things worth having in
  mind (what to notice in a problem statement, the decisions that usually come up, what a
  sliced plan looks like). Draw on them when the conversation gets there. Never walk through
  them, and never present them as a list to the user unprompted.
- **Data is the one automatic action:** if data files were handed over, run the recon in §2
  once, so the conversation rests on facts.
- **The boundaries are the only fixed rules.** Write no design doc, code, migration or
  `docs/decisions.md` entry, and don't steer toward the doc. The brainstorm ends when the
  user asks for the doc (skill `design-doc`). It may be two messages or twenty.
- Remember what the user settled, in their words. The doc marks those Decided (user).

## 1. What to notice in the problem statement
The actors (customers? stakeholders? regulator?), the entities, the operations each actor
needs, explicit constraints, and **what is ambiguous**. Have this read ready; share the parts
the user asks about or that bear on their question. A written restatement only if they ask.

## 2. Recon the data (parallel)
If data was provided: put files in `data/raw/`, then run `pnpm data:recon data/raw` once. It
loads every file and prints one summary: anomalies, duplicates, references and orphans, and the
decisions they raise. Answer from that summary (interview mode, CLAUDE.md "Mode"). Go deeper with
skill `data-recon` (per-table `data:profile`, SQL probes) only when asked or when a finding is
unclear.
If an API/schema description was provided instead, list entities/fields/relationships from it.

## 3. Decisions that usually come up
These are the user's (CLAUDE.md principle 6). Know the tradeoffs, so you can answer when the
user asks about one. Typical ones:
- identity: natural key from data vs surrogate id (+ unique constraint on the natural key)
- dirty data: reject / quarantine (report by `_row`) / coerce — per anomaly class from the profile
- money/units: numeric as string, integer minor units, unit normalisation
- time: timestamptz, timezone of source timestamps, ambiguous date formats
- list endpoints: keyset vs offset pagination; which filters/sorts; totals or not
- authz/audience separation if multiple actors (API key per actor? role claim? separate routes?).
  If keys are introduced, they follow CLAUDE.md §2d: live vs test environment on every key.
  Only the actor/role axis is a decision to ask about.
- immutability/audit for regulator-facing data
These come up as the conversation reaches them. They are recorded in `docs/decisions.md` as
the user's when the design doc is approved, not during the brainstorm.

## 4. What a sliced plan looks like (for the doc, later)
```
Phase A (now): <smallest end-to-end slice: one migration, one resource, list+get, e2e journey>
  Verify: repro tests red->green (names); while iterating only the affected test file;
          pnpm test + pnpm test:e2e once, when the phase is done
Phase B: <next slice>
Phase C: <stretch> — or queue in docs/followups/
```
Prefer a thin vertical slice that works end-to-end through the container over broad half-built
layers. Each phase ends committed and green.

When the user asks for the doc, what the brainstorm settled is written as the design doc (skill
`design-doc`), in `docs/design/<slug>.md`, and the user steers it. No code before the user
approves it.

## 5. Go (after the doc is approved)
Run skill `feature` for each slice, and end each one with skill `slice-review`. Use
`orchestrate` to parallelize recon and bounded implementation once contracts are fixed.
