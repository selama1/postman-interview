---
name: ui-surface
description: Build a basic web UI on top of the API during the live session (a page to list, view or create books, a dashboard for an editor, a form). Covers the default shape (one static page served by the api at /ui, same origin, no build step), the thin-UI rule, test mode in the UI, the container pitfall, how to demo it, and the OPTIONAL Playwright test that runs on the host against the installed Edge/Chrome. Use for "add a UI", "a simple page for X", "show this in a browser", "a dashboard for the regulator".
---

# UI surface: thin page over the API, test mode included

The UI is a client like the SDK or CLI (CLAUDE.md §2c), so `client-surface` applies too. What is
specific to a browser page is below. Time box for a basic page: about 30 minutes.

## 0. Decide (default first, ask only if they want more)
| option | when | cost |
|---|---|---|
| **One static page served by the api at `/ui`** (default) | a basic list/detail/form page | no build step, same origin (no CORS), still two containers |
| Vite + React app | they ask for a richer UI, routing, components | build step, a third container or a build stage, CORS or a proxy |

State the default and why in one sentence. Switching is the user's call (§6), record it in
`docs/decisions.md`.

## 1. The thin-UI rule
Every rule lives in the API. The page only sends requests and renders responses: no validation
the server doesn't also do, no business logic, no derived numbers the API can't return. Then
the HTTP tests prove the behaviour and the UI cannot be wrong in a way they miss. If the page
needs a number, add it to the API (with its HTTP test) first.

## 2. Default shape
```
packages/service/public/ui/index.html    markup + <script type="module" src="app.js">
packages/service/public/ui/app.js        fetch + render, plain JS (no bundler)
packages/service/public/ui/style.css     optional
packages/service/src/http/ui.ts          registers @fastify/static at /ui/
```
- Add the dependency: `pnpm --filter service add @fastify/static@10.1.11 --offline`
  (in the store after `pnpm warm`; drop `--offline` if it complains). Fastify 5 compatible.
- `ui.ts`: `app.register(fastifyStatic, { root: path.resolve(import.meta.dirname, '../../public/ui'), prefix: '/ui/' })`.
  The path is relative to the compiled file: `src/http/ui.ts` and `dist/http/ui.js` both sit two
  levels under the package root. Register it in `app.ts` next to swagger-ui. Its routes stay out
  of OpenAPI by default (`schemaHide: true`).
- **Container pitfall:** `packages/service/package.json` has `"files": ["dist"]` and the
  Dockerfile ships `pnpm deploy` output, so `public/` is NOT in the image unless you add
  `"public"` to `files` (verified 2026-11-14). `pnpm dev` and the integration tests work either
  way. Only the container check in §4.2 catches it.

## 3. What the page must do
- **Errors the API's way:** on a non-2xx response, parse the problem+json and show `detail` and
  `fix` (and the `requestId` in small text). Never just "Something went wrong".
- **Test mode:** read `?testSession=<id>` from the page URL (or a field in a small "test" panel)
  and send it as `x-test-session` on every fetch. When absent, omit the header entirely (never
  send it empty: the server answers 400). A "new test session" button calls
  `POST /_test/sessions` and reloads with `?testSession=`. This is how the demo and the tests get
  empty data without touching the main DB.
- **Security:** render data with `textContent` / `createElement`, never `innerHTML` with API data
  (stored XSS through a author name). Same origin, so no CORS config. No secrets in the page.
- **States:** loading, empty ("no books yet"), error, data. Keyset pagination: a "next" button
  driven by the API's cursor, not page numbers.

## 4. Proof, in order of necessity
1. **HTTP integration test** (required): `GET /ui/` returns 200 `text/html` and `GET /ui/app.js`
   returns JavaScript, via `t.client`. The behaviour behind the page is already covered by the
   resource's HTTP tests.
2. **e2e journey check** (required, it catches the container pitfall): add to
   `scripts/e2e-journey.mjs` a check that `GET /ui/` on the built image returns 200 HTML. Run
   `pnpm test:e2e`.
3. **Demo** (required): open `http://localhost:3480/ui/?testSession=<id>` in the in-app browser
   (`mcp__Claude_Browser__*` tools), walk the flow, show an error state with its `fix`.
4. **Playwright test** (optional, only if asked or time allows): see §5.

## 5. Optional: one Playwright test on the host
Decision (docs/decisions.md, 2026-11-14): UI tests run on the host, never in the Docker test
image. The browser is the installed Edge or Chrome, so nothing is downloaded.
- `pnpm add -Dw @playwright/test@1.65.1 --offline` (store primed by `pnpm warm`).
- `playwright.config.ts` at the repo root:
  ```ts
  import { defineConfig } from '@playwright/test';
  export default defineConfig({
    testDir: 'packages/service/test/ui',
    use: {
      baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3480',
      // Installed browser, no download. Linux without Chrome: UI_BROWSER_CHANNEL=chromium, then `pnpm exec playwright install chromium`.
      channel: process.env.UI_BROWSER_CHANNEL ?? (process.platform === 'win32' ? 'msedge' : 'chrome'),
    },
  });
  ```
- One test per flow, each in its own test session (the same isolation as every other layer):
  ```ts
  test('a created book appears in the list', async ({ page, request }) => {
    const { id } = await (await request.post('/_test/sessions')).json();
    try {
      await page.goto(`/ui/?testSession=${id}`);
      // act through the page, assert what the user sees
    } finally {
      await request.delete(`/_test/sessions/${id}`);
    }
  });
  ```
- Script: `"test:ui": "playwright test"` against the running stack (`pnpm stack:up` first). Keep it out
  of `pnpm test` and out of the tests container. Locators: `getByRole` / `getByText`, not CSS
  classes (a CSS class can match two elements and Playwright refuses, in strict mode).
- Verified 2026-11-14: Playwright 1.65.1 + `channel: 'msedge'` headless against this stack, 2.3 s,
  no browser download.

## 6. Pitfalls
- Running pnpm in a directory outside this repo uses the global corepack pnpm, which may not be
  installed. Run from the repo, or give the temp `package.json` `"packageManager": "pnpm@11.8.0"`.
- `req.db` rule: the static route touches no DB, so it needs no exemption. Any JSON route added
  for the page is a normal resource route and follows `gen:resource` / CLAUDE.md §8.
- Don't add a UI framework, CSS framework or bundler for a basic page. Each one is time and a
  question the interviewers can ask.
