# data:load silently drops extra CSV fields

- **Evidence:** `scripts/data/load.ts` parses CSV with `columns: true, relax_column_count: true`.
  A row with more fields than the header loses the extras without a word, which breaks the loader's
  "lossless" promise. (A row with fewer fields is fine: the missing ones are NULL.)
- **Seen in:** none so far. The 2026-11-16 practice dataset has consistent field counts, checked
  per row. Found while fixing the JSON key-union bug.
- **Fix:** keep the extras in an `_extra` text column (JSON array) and print a WARN with the
  count and sample `_row`s, so the profile surfaces it.
- **Done when:** an integration test in `test/integration/data-load.test.ts` loads a CSV with an
  extra field and finds it in `_extra`, and the CLI output warns.
