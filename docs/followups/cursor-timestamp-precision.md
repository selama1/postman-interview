# Keyset cursors truncate timestamps to milliseconds

- **Evidence:** `packages/service/src/http/pagination.ts` `encodeCursor` stores a Date with
  `toISOString()`, and `pg` parses `timestamptz` into a JS Date (ms precision). A row whose sort
  timestamp has microseconds compares as "less than" its own cursor value, so a page boundary on
  it can repeat or skip rows.
- **Seen in:** none so far. The 2026-11-16 practice data has 0 sub-ms `booked_at` (checked). Found
  by the sql-perf and correctness review lenses.
- **Fix:** either declare sortable timestamps `timestamptz(3)` (the llms.txt pitfall-3 convention,
  enforced in gen:resource), or carry timestamp cursor values as text from SQL (`to_char(...)` /
  `::text`) instead of through a JS Date.
- **Done when:** an integration test with two rows 1 µs apart on the sort column pages through
  them exactly once each.
