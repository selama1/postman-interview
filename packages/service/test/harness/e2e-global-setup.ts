import { testEnv } from './env.js';

/**
 * E2E global setup: the compose stack must be up and connected to its DB. Fail loudly with the
 * fix — never skip. `pnpm test:e2e` brings the stack up first; this guards direct
 * `vitest --project e2e` runs.
 */
export default async function setup() {
  const url = `${testEnv.e2eBaseUrl.replace(/\/$/, '')}/health/db`;
  let detail = '';
  for (let i = 0; i < 20; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (res.ok) return;
      detail = `HTTP ${res.status}: ${await res.text()}`;
    } catch (err) {
      detail = String((err as Error & { cause?: { code?: string } }).cause?.code ?? (err as Error).message);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`E2E target ${url} is not healthy (${detail}).\nFix: pnpm stack:up   (docker compose up -d --build --wait), then retry.`);
}
