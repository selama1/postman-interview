---
name: data-recon
description: Load an unfamiliar dataset (CSV/TSV/JSON/NDJSON) losslessly into the staging schema, profile it (types, nulls, keys, foreign keys, anomalies), and turn the findings into schema decisions and a migration that imports clean rows and reports rejects. Use when data files are handed over, before designing tables.
---

# Data recon: facts before schema

## 1. Load raw (lossless)
```
pnpm db:up                                   # dev DB
pnpm data:load data/raw/<file>.csv           # -> staging.<file>  (all TEXT + _row)
pnpm data:load data/raw/x.json --table customers --replace
```
Several files → fan out: one Haiku `scout` per file running load + profile, returning the
markdown report (skill `orchestrate`). Load all files before profiling so FK detection sees them.

## 2. Profile
`pnpm data:profile staging.<table>` → also saved to `data/out/profile-staging.<table>.md`.
Read in this order:
1. **Candidate keys** — a natural key? (Then: surrogate id + UNIQUE on it, or use it as PK.)
2. **Inferred types + "not <type>" samples** — the values that break the cast are your import
   rules (e.g. `n/a` in weights, `01/02/2026` dates).
3. **Flags** — mixed types, mixed date formats, padded values, case variants (`Delivered` vs
   `delivered `), placeholder nulls, constants.
4. **Candidate FKs** with orphan counts — orphans decide: FK + reject orphans, or nullable FK.
5. Distinct counts on low-cardinality text → enum-like → CHECK constraint (or lookup table).

## 3. Decide (with the user when it's theirs — CLAUDE.md §6)
Per anomaly class choose: **reject** (exclude + report by `_row`), **coerce** (trim/lower/parse
with a documented rule), or **keep raw** (nullable). Units/currency normalisation. Timezone of
naive timestamps. Record in `docs/decisions.md`.

## 4. Shape it with a migration
```ts
// up(): create the real table with constraints, then import with explicit casts
await sql`
  insert into shipments (external_id, customer_id, weight_kg, shipped_at, status)
  select btrim(shipment_id), c.id, nullif(lower(btrim(weight_kg)), 'n/a')::numeric,
         <date normalisation>, lower(btrim(status))
  from staging.shipments s join customers c on c.external_id = btrim(s.customer_id)
  where <row passes all rules>`.execute(db);
```
Import migrations make the container reproducible only if the raw data is in the image/volume —
for the live session it's usually simpler to: migration = schema only; a script
`scripts/data/import-<name>.ts` (idempotent, `on conflict do nothing`) for the data, and a
`staging` → real-table SQL that also writes rejects to `staging.<table>_rejects(_row, reason)`.
Say which approach you took and why.

## 5. Verify
- Row accounting: `imported + rejected = source rows` (assert it in the import script output).
- A repro-style test for each cleaning rule (fresh DB, insert the dirty staging rows, run the
  import SQL, assert outcome) — keeps the rules honest when they change.
- Spot-check via the API once the resource exists.
