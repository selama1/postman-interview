#!/usr/bin/env node
// SessionStart hook: a short orientation brief injected into every Claude session in this repo.
// Fast (<1s typical), never fails the session: every probe is best-effort with a short timeout.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';

// Honour repo-root .env (ports / E2E_BASE_URL / COMPOSE_PROJECT_NAME overrides, e.g. in a practice worktree).
try {
  process.loadEnvFile('.env');
} catch {
  /* no .env: defaults */
}

const sh = (cmd, args, timeout = 1500) => {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
};

const lines = [];
const branch = sh('git', ['branch', '--show-current']) || '(detached)';
const dirty = (sh('git', ['status', '--porcelain']) ?? '').split('\n').filter(Boolean).length;
lines.push(`[session-brief] branch: ${branch}${dirty ? ` · ${dirty} uncommitted change(s)` : ' · clean'}`);
if (branch === 'main') lines.push('  main = vanilla interview submission: no practice/ code here (pre-commit hook enforces).');
if (branch.startsWith('practice')) lines.push('  practice branch: problems in practice/problems/, never merge into main.');

const fu = existsSync('docs/followups') ? readdirSync('docs/followups').filter((f) => /^\d{4}-\d{2}-\d{2}-.*\.md$/.test(f)) : [];
if (fu.length) lines.push(`  follow-up queue: ${fu.length} item(s) in docs/followups/`);

try {
  const res = await fetch(`${(process.env.E2E_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '')}/health/db`, { signal: AbortSignal.timeout(800) });
  const body = await res.json();
  lines.push(`  stack: api ${res.status === 200 ? 'UP' : `HTTP ${res.status}`}${body?.migrations ? ` · migrations ${body.migrations.executed} applied, ${body.migrations.pending.length} pending` : ''}`);
} catch {
  lines.push(`  stack: api not reachable at ${process.env.E2E_BASE_URL ?? 'http://localhost:3000'}`+'  (start with `pnpm up`; tests need `pnpm db:test:up`)');
}
lines.push('  Read docs/llms.txt before coding. Skills: kickoff, feature, repro-test, run-tests, e2e, debug, db-inspect, data-recon, lens-review, orchestrate, followup, client-surface.');
console.log(lines.join('\n'));
