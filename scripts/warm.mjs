#!/usr/bin/env node
// Make the stack startable without network: pull/build every image, prime the pnpm store, then
// prove it (offline pnpm install + `up --no-build`). Run once before the session, on good Wi-Fi.
//
//   pnpm warm
//
// Why: conference/office Wi-Fi or a Docker Hub rate limit must not be able to break the live
// session. After this, `docker compose up --no-build` and `pnpm install --offline` need no network.
import { spawnSync } from 'node:child_process';

const win = process.platform === 'win32';
const results = [];
const step = (name, cmd, args, fix) => {
  process.stdout.write(`… ${name}\n`);
  // pnpm is a .cmd shim on Windows: run it through cmd.exe explicitly (no shell:true + args).
  const [c, a] = win && cmd === 'pnpm' ? ['cmd', ['/d', '/s', '/c', cmd, ...args]] : [cmd === 'node' ? process.execPath : cmd, args];
  const r = spawnSync(c, a, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  const ok = r.status === 0;
  results.push({ name, ok, fix, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n').slice(-6).join('\n') });
  return ok;
};
const dc = (...a) => ['scripts/dc.mjs', ...a];

step('pull Postgres image (db, db-test)', 'node', dc('--profile', 'test', 'pull', '--ignore-buildable', 'db', 'db-test'),
  'check the network / Docker Hub login (docker login), then re-run pnpm warm');
// The build caches the base image as layers, not as a named image; pull it so an offline REBUILD
// (after a code change) finds node:24-alpine locally too.
const dockerOnPath = spawnSync('docker', ['--version'], { stdio: 'ignore' }).status === 0;
const [dk, dkArgs] = win && !dockerOnPath ? ['wsl', ['-e', 'docker']] : ['docker', []];
step('pull the api base image (node:24-alpine)', dk, [...dkArgs, 'pull', 'node:24-alpine'],
  'check the network / Docker Hub login (docker login), then re-run pnpm warm');
step('pull the test-runner base image (node:24-bookworm-slim)', dk, [...dkArgs, 'pull', 'node:24-bookworm-slim'],
  'check the network / Docker Hub login (docker login), then re-run pnpm warm');
step('build the api image (dependency layers)', 'node', dc('build', 'api'),
  'read the build error above; if it is a network failure, re-run pnpm warm');
step('build the tests image (pnpm test:docker runs every layer in it)', 'node', dc('--profile', 'test', 'build', 'tests'),
  'read the build error above; if it is a network failure, re-run pnpm warm');
step('prime the pnpm store', 'pnpm', ['install', '--frozen-lockfile', '--prefer-offline'],
  'run pnpm install and read its error');
step('prove: pnpm install works offline', 'pnpm', ['install', '--frozen-lockfile', '--offline'],
  'something is missing from the store; run pnpm install with network, then pnpm warm again');
step('prove: stack starts without building or pulling', 'node', dc('--profile', 'test', 'up', '-d', '--wait', '--no-build', '--pull', 'never'),
  'an image is missing locally; re-run pnpm warm with network');

console.log('');
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`);
  if (!r.ok) {
    console.log(`      Fix: ${r.fix}`);
    if (r.out) console.log(r.out.replace(/^/gm, '        | '));
  }
}
const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `\nWARM-UP INCOMPLETE: ${failed} step(s) failed.` : '\nWARM: images and packages are local; the stack starts with no network.');
process.exitCode = failed ? 1 : 0;
