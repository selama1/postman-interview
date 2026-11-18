---
name: data-recon
description: Load an unfamiliar dataset (CSV/TSV/JSON/NDJSON) losslessly into the staging schema, profile it (types, nulls, keys, foreign keys, anomalies), and turn the findings into schema decisions and a migration that imports clean rows and reports rejects. Use when data files are handed over, before designing tables.
---

# Data recon: facts before schema

## 0. One command first
`pnpm data:recon data/raw` loads every file losslessly and prints one summary, also saved to
`data/out/recon.md`. It covers mixed shapes, a proven or ambiguous slash-date order, case
variants, duplicate keys (identical vs conflicting), likely references with orphan counts, and
names used instead of codes. In interview mode, answer from this summary and stop. Steps 1–2 are
for depth on request.

## 1. Load raw (lossless)
```
pnpm db:up                                   # dev DB
pnpm data:load data/raw/<file>.csv           # -> staging.<file>  (all TEXT + _row)
pnpm data:load data/raw/x.json --table authors --replace
```
Several files → fan out: one Haiku `scout` per file running load + profile, returning the
markdown report (skill `orchestrate`). Load all files before profiling so FK detection sees them.

## 2. Profile
`pnpm data:profile staging.<table>` → also saved to `data/out/profile-staging.<table>.md`.
Read in this order:
1. **Candidate keys** — a natural key? (Then: surrogate id + UNIQUE on it, or use it as PK.)
2. **Inferred types + "not <type>" samples** — the values that break the cast are your import
   rules (e.g. `n/a` in prices, `01/02/2026` dates).
3. **Flags** — mixed types, mixed date formats, padded values, case variants (`Published` vs
   `published `), placeholder nulls, constants.
4. **Candidate FKs** with orphan counts — orphans decide: FK + reject orphans, or nullable FK.
5. Distinct counts on low-cardinality text → enum-like → CHECK constraint (or lookup table).

## 3. Decide (with the user when it's theirs — CLAUDE.md §6)
Per anomaly class choose: **reject** (exclude + report by `_row`), **coerce** (trim/lower/parse
with a documented rule), or **keep raw** (nullable). Units/currency normalisation. Timezone of
naive timestamps. Record in `docs/decisions.md`.
- **Mixed precision:** a date-only value (`6/18/2024`) is not midnight. Any comparison with a
  full timestamp must allow the same day: compare `::date` when either side was date-only, or
  keep a precision flag. Left unchecked, it fills a reject category with false "X before Y" rows.
- **Implausible counts:** before reporting a reject category over a few dozen rows, check it
  isn't produced by our own conversion (CLAUDE.md "Mode" rule 6).

## 4. Shape it: migration for the schema, `importFromStaging` for the data
Migration = the real table with constraints (`pnpm gen:resource` writes it in the house shape).
Data = a spec file run with `pnpm data:import <spec.ts>`. It uses `importFromStaging` in
src/db/import.ts. Write the spec from the `ImportSpec` type and its JSDoc example. Per column:
`{ from, type, required, normalize, oneOf, check, ref, default }`, plus `key` / `onDuplicate` /
`dateOrder`.
- Set-based (50k rows in ~3 s) and one transaction. Every bad row lands in `import_rejects` with
  its source row, ALL its reasons and the raw row. `import_runs` holds the counts.
- Spec mistakes throw `IMPORT_SPEC_INVALID` before touching data, listing the valid names.
- `dateOrder` (default MDY) and the duplicate policy are the user's decisions per dataset
  (CLAUDE.md §6). Record them in docs/decisions.md.
- Inspect: `select source_row, reasons, raw from import_rejects where import_id = '<id>' order by source_row`.
- Parents before children (`ref` checks the parent table), so a spec file may export an array.

## 5. Verify
- Row accounting: `inserted + updated + rejected + skippedDuplicates = total`. The report prints
  it, and a CHECK on `import_runs` enforces it.
- A repro-style test for each cleaning rule (fresh DB, insert the dirty staging rows, run the
  import SQL, assert outcome) — keeps the rules honest when they change.
- Spot-check via the API once the resource exists.
