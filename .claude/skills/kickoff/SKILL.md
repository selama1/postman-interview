---
name: kickoff
description: Start of the live session (or any new problem statement / dataset handed over). Turns the prompt + data into a recorded understanding, a profiled dataset, decisions to confirm with the user, and a phased plan with verification — before writing feature code. Use when the user pastes a task description, hands over data files, or says "here's the problem".
---

# Kickoff: from problem statement to a plan in ~10 minutes

Goal: understand before building, and make the tradeoffs visible early (that is what the
interviewers are watching). Keep it fast — this is a live session.

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
Ask them in one compact message. Record answers in `docs/decisions.md` as the user's.
In interview mode, state the default for each and proceed. Ask only where no default is defensible.

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

## 5. Go
Run skill `feature` for each slice. Use `orchestrate` to parallelize recon and bounded
implementation once contracts are fixed.
