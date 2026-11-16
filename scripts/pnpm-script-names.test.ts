import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * A package script named like a pnpm built-in never runs: `pnpm <name>` runs the built-in.
 * Incident (2026-11-16): the documented `pnpm up` was pnpm's `update` alias. It bumped dependencies
 * and rewrote the lockfile instead of starting the compose stack, and reported success.
 *
 * Source: `pnpm help --all` (pnpm 11.8.0), commands and their aliases. Re-check when pnpm is upgraded.
 * `test` and `start` are left out on purpose: pnpm runs the package script of that name.
 */
const PNPM_BUILTINS = [
  'add', 'approve-builds', 'audit', 'bin', 'c', 'cache', 'cat-file', 'cat-index', 'clean', 'config',
  'create', 'dedupe', 'deploy', 'dlx', 'env', 'exec', 'fetch', 'find-hash', 'i', 'ignored-builds',
  'import', 'init', 'install', 'install-test', 'it', 'licenses', 'link', 'list', 'ln', 'ls',
  'outdated', 'pack', 'patch', 'patch-commit', 'patch-remove', 'prune', 'publish', 'rb', 'rebuild',
  'remove', 'rm', 'root', 'rt', 'run', 'runtime', 'self-update', 'stage', 'store', 'unlink', 'up',
  'update', 'why',
];

describe('package.json script names', () => {
  it('no script is shadowed by a pnpm built-in command (it would never run)', () => {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { scripts: Record<string, string> };
    const shadowed = Object.keys(manifest.scripts).filter((name) => PNPM_BUILTINS.includes(name));
    expect(
      shadowed,
      shadowed.map((n) => `"pnpm ${n}" runs pnpm's built-in "${n}", not the script "${manifest.scripts[n]}". Fix: rename the script (e.g. "stack:${n}") and update the docs that mention it.`).join('\n'),
    ).toEqual([]);
  });
});
