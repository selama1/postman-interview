#!/usr/bin/env node
/**
 * Full E2E: (re)build + start the compose stack, wait until healthy, run the journey script,
 * then the vitest e2e project (test/e2e + the shared test/scenarios) against it.
 *
 *   pnpm test:e2e              build, up, journey, vitest e2e (stack left running for inspection)
 *   pnpm test:e2e --no-build   skip the image rebuild (faster when only tests changed)
 *   pnpm test:e2e --down       tear the stack down afterwards
 *
 * Exit code is non-zero if any stage fails. Never claim a feature works end-to-end without this.
 */
import { spawnSync } from 'node:child_process';

// Honour repo-root .env (ports / E2E_BASE_URL / COMPOSE_PROJECT_NAME overrides, e.g. a second clone running side by side).
try {
  process.loadEnvFile('.env');
} catch {
  /* no .env: defaults */
}

const args = new Set(process.argv.slice(2));
const run = (cmd, argv, env = {}) => {
  console.log(`\n$ ${cmd} ${argv.join(' ')}`);
  return spawnSync(cmd, argv, { stdio: 'inherit', shell: process.platform === 'win32', env: { ...process.env, ...env } }).status ?? 1;
};

let code = run('node', ['scripts/dc.mjs', 'up', '-d', '--wait', ...(args.has('--no-build') ? [] : ['--build'])]);
if (code !== 0) {
  console.error('\nFAIL: stack did not come up healthy.\nFix: pnpm dc logs api / pnpm dc logs db, then see .claude/skills/debug.');
  process.exit(code);
}
const journey = run('node', ['scripts/e2e-journey.mjs']);
const suite = run('npx', ['vitest', 'run', '--project', 'e2e'], { TEST_TARGET: 'e2e' });
if (args.has('--down')) run('node', ['scripts/dc.mjs', 'down']);
code = journey || suite;
console.log(`\nE2E ${code ? 'FAIL' : 'PASS'} (journey: ${journey ? 'FAIL' : 'PASS'}, vitest e2e: ${suite ? 'FAIL' : 'PASS'})`);
process.exit(code);
