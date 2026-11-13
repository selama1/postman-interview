# Empty `x-test-session` header silently falls through to the main DB

- **Found:** 2026-11-13, while writing the `client-surface` skill.
- **State:** `registerRequestDb` (packages/service/src/http/test-mode.ts) treats a present-but-empty
  header (`x-test-session: `) the same as no header, so the request runs against the main DB.
- **Why it matters:** an empty header almost always means an unset client variable (Postman
  `{{testSession}}`, CLI env var). A test run that thinks it is isolated would read and write real
  data — the exact failure test mode exists to prevent (CLAUDE.md §4: fail loudly, never silently).
- **Full fix:** header present with an empty/whitespace value → 400 `TEST_SESSION_INVALID`,
  `fix: "omit the header for the main DB, or set it to an id from POST /_test/sessions"`.
  Write the repro test first, in `test/integration/test-mode.test.ts`. Once test keys exist (CLAUDE.md §2d),
  a test key without a usable session is refused anyway — this closes the gap before auth lands.
- **Size:** small (one branch + one test).
