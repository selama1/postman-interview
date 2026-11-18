---
name: kickoff
description: Start of the live session (or any new problem statement / dataset handed over). Opens the brainstorm - restates the problem, profiles the data, and discusses approaches and decisions with the user, who leads. Writes no doc and no code; the design doc comes only when the user asks for it. Use when the user pastes a task description, hands over data files, says "here's the problem", or wants to brainstorm or discuss approaches.
---

# Kickoff: the brainstorm, from problem statement to an agreed approach

Goal: understand before building, and make the tradeoffs visible early (that is what the
interviewers are watching). Keep it fast — this is a live session.

## The brainstorm is the user's (CLAUDE.md "Mode" rule 9)
The flow is brainstorm → design doc → slices, and the user moves it along.
- Steps 1–2 below are the opening reply. After that, follow the user: answer what they ask,
  clarify, and when they ask for approaches give 2–3 with a recommendation and a one-line
  tradeoff each.
- Steps 3–4 are material to bring into the conversation as it reaches them, not a script to
  run through. Don't dump every decision at once.
- Write no design doc, code, migration or `docs/decisions.md` entry during the brainstorm, and
  don't ask "shall I write the doc?". The brainstorm ends when the user asks for the doc
  (skill `design-doc`). It may be two messages or twenty.
- Keep track of what the user settled, in their words. The doc marks those Decided (user).

## 1. Restate (1–2 min)
Write back, in 5–8 bullets: the actors (customers? stakeholders? regulator?), the entities, the
operations each actor needs, explicit constraints, and **what is ambiguous**. Ask only the
questions whose answers change the design; offer a default for each so the session doesn't stall.

## 2. Recon the data (parallel)
If data was provided: put files in `data/raw/`, then run `pnpm data:recon data/raw` once. It
loads every file and prints one summary: anomalies, duplicates, references and orphans, and the
decisions they raise. Answer from that summary (interview mode, CLAUDE.md "Mode"). Go deeper with
skill `data-recon` (per-table `data:profile`, SQL probes) only when asked or when a finding is
unclear.
If an API/schema description was provided instead, list entities/fields/relationships from it.

## 3. Decisions to confirm (the important part)
Draft the decisions that are the user's (CLAUDE.md principle 6), each with options + your
recommendation + one-line tradeoff. Typical ones:
- identity: natural key from data vs surrogate id (+ unique constraint on the natural key)
- dirty data: reject / quarantine (report by `_row`) / coerce — per anomaly class from the profile
- money/units: numeric as string, integer minor units, unit normalisation
- time: timestamptz, timezone of source timestamps, ambiguous date formats
- list endpoints: keyset vs offset pagination; which filters/sorts; totals or not
- authz/audience separation if multiple actors (API key per actor? role claim? separate routes?).
  If keys are introduced, they follow CLAUDE.md §2d: live vs test environment on every key.
  Only the actor/role axis is a decision to ask about.
- immutability/audit for regulator-facing data
Raise the ones the conversation has reached, with your default for each. They are recorded in
`docs/decisions.md` as the user's when the design doc is approved, not during the brainstorm.

## 4. Phased plan with verification
```
Phase A (now): <smallest end-to-end slice: one migration, one resource, list+get, e2e journey>
  Verify: repro tests red->green (names); while iterating only the affected test file;
          pnpm test + pnpm test:e2e once, when the phase is done
Phase B: <next slice>
Phase C: <stretch> — or queue in docs/followups/
```
Prefer a thin vertical slice that works end-to-end through the container over broad half-built
layers. Each phase ends committed and green.

When the user asks for the doc, what steps 1–4 produced is written as the design doc (skill
`design-doc`), in `docs/design/<slug>.md`, and the user steers it. No code before the user
approves it.

## 5. Go (after the doc is approved)
Run skill `feature` for each slice, and end each one with skill `slice-review`. Use
`orchestrate` to parallelize recon and bounded implementation once contracts are fixed.
