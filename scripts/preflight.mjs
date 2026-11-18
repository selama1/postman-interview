#!/usr/bin/env node
// Go/no-go check for the live session. Run it the morning of (and again 10 minutes before).
//
//   pnpm preflight            everything, including the full test suite (~1 min)
//   pnpm preflight --quick    skip the test suite
//
// Each line is PASS / WARN / FAIL; WARN and FAIL say what to do. Exit 0 = GO.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const win = process.platform === 'win32';
const quick = process.argv.includes('--quick');
const rows = [];
const add = (status, name, detail = '', fix = '') => {
  rows.push({ status, name, detail, fix });
  const tag = status === 'PASS' ? 'PASS' : status === 'WARN' ? 'WARN' : 'FAIL';
  console.log(`${tag}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (fix && status !== 'PASS') console.log(`      Fix: ${fix}`);
};
const run = (cmd, args, opts = {}) => {
  // pnpm is a .cmd shim on Windows: run it through cmd.exe explicitly (no shell:true + args).
  const [c, a] = win && cmd === 'pnpm' ? ['cmd', ['/d', '/s', '/c', cmd, ...args]] : [cmd === 'node' ? process.execPath : cmd, args];
  const r = spawnSync(c, a, { encoding: 'utf8', timeout: opts.timeout ?? 120_000 });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
};
const dockerOnPath = run('docker', ['--version']).ok;
const viaWsl = win && !dockerOnPath;
const docker = (...a) => (viaWsl ? run('wsl', ['-e', 'docker', ...a]) : run('docker', a));

console.log('== Preflight: is this machine ready for the live session? ==\n');

// --- repo ---
const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD']).out;
add(branch === 'main' ? 'PASS' : 'FAIL', 'on branch main', branch, 'git switch main (other work belongs in a separate clone)');
// The interview clone holds main and nothing else: no other branch, worktree or stash, and no
// untracked or ignored files beyond the regenerable and personal ones below. Anything else could
// be read by the agent during the session.
const extraBranches = run('git', ['for-each-ref', '--format=%(refname:short)', 'refs/heads']).out.split(/\r?\n/).filter((b) => b && b !== 'main');
add(extraBranches.length ? 'FAIL' : 'PASS', 'only main in this clone', extraBranches.join(', '),
  'move them to the practice clone (git push <practice clone> <branch>), then git branch -D <branch>');
const worktrees = run('git', ['worktree', 'list', '--porcelain']).out.split(/\r?\n/).filter((l) => l.startsWith('worktree ')).length;
add(worktrees > 1 ? 'FAIL' : 'PASS', 'no linked worktrees', worktrees > 1 ? `${worktrees - 1} linked` : '', 'git worktree list; remove them (their work belongs in a separate clone)');
const stashes = run('git', ['stash', 'list']).out;
add(stashes ? 'FAIL' : 'PASS', 'no stashes', stashes ? `${stashes.split('\n').length} stash(es)` : '', 'git stash list; apply them in the practice clone or drop them');
// Test reports are allowed: in this clone they come only from this clone's own runs (pnpm test,
// pnpm test:e2e), so they hold nothing from elsewhere.
const ALLOWED_EXTRA = /^(\.env|\.claude\/settings\.local\.json|(packages\/[^/]+\/)?node_modules\/|\.test-reports\/|\.e2e-reports\/)/;
const extra = run('git', ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory']).out
  .concat('\n', run('git', ['ls-files', '--others', '--exclude-standard', '--directory']).out)
  .split(/\r?\n/).filter((p) => p && !ALLOWED_EXTRA.test(p));
add(extra.length ? 'FAIL' : 'PASS', 'no stray untracked or ignored files', extra.slice(0, 5).join(', ') + (extra.length > 5 ? ` (+${extra.length - 5})` : ''),
  'git clean -ndx shows them; move what you need to the practice clone, then remove them (data/ must be empty before the session)');
const dirty = run('git', ['status', '--porcelain']).out;
add(dirty ? 'WARN' : 'PASS', 'working tree clean', dirty ? `${dirty.split('\n').length} change(s)` : '', 'commit or stash before the session so every live diff is yours');
const fetched = run('git', ['fetch', '--quiet', 'origin'], { timeout: 15_000 }).ok;
if (fetched) {
  const behind = run('git', ['rev-list', '--count', 'HEAD..origin/main']).out;
  const ahead = run('git', ['rev-list', '--count', 'origin/main..HEAD']).out;
  add(behind === '0' && ahead === '0' ? 'PASS' : 'WARN', 'in sync with GitHub', `ahead ${ahead}, behind ${behind}`,
    'push (ahead) or pull (behind) so the repo they clone is what you run');
} else add('WARN', 'in sync with GitHub', 'could not reach origin', 'check the network; the session itself does not need it after pnpm warm');

// --- toolchain ---
const nodeMajor = Number(process.versions.node.split('.')[0]);
add(nodeMajor >= 24 ? 'PASS' : 'FAIL', 'Node 24+', process.versions.node, 'install Node 24 (nvm install 24 / winget install OpenJS.NodeJS)');
const pnpmV = run('pnpm', ['--version']);
add(pnpmV.ok ? 'PASS' : 'FAIL', 'pnpm available', pnpmV.out.split('\n')[0], 'corepack enable');
add(existsSync('node_modules') ? 'PASS' : 'FAIL', 'dependencies installed', '', 'pnpm install');

// --- docker ---
const info = docker('info', '--format', '{{.ServerVersion}}');
add(info.ok ? 'PASS' : 'FAIL', 'Docker daemon reachable', info.ok ? `server ${info.out}${viaWsl ? ' (in WSL)' : ''}` : info.out.split('\n').pop(),
  viaWsl ? 'wsl -e sudo service docker start (or open the WSL distro once)' : 'start Docker (sudo systemctl start docker / Docker Desktop)');
if (viaWsl) {
  const ka = run('wsl', ['-e', 'pgrep', '-f', 'pe-keepalive']).ok;
  add(ka ? 'PASS' : 'WARN', 'WSL keep-alive running', '', 'it starts with pnpm stack:up; without it WSL idles out and stops the containers');
}
for (const img of ['postgres:17-alpine', 'node:24-alpine', 'node:24-bookworm-slim']) {
  const has = docker('image', 'inspect', img, '--format', '{{.Id}}').ok;
  add(has ? 'PASS' : 'WARN', `image cached: ${img}`, '', 'pnpm warm (on good Wi-Fi) so the stack starts offline');
}
// Optional UI tests (skill ui-surface) drive an installed browser, so nothing is downloaded live.
const browserPaths = {
  win32: ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'],
  darwin: ['/Applications/Microsoft Edge.app', '/Applications/Google Chrome.app'],
  linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/microsoft-edge', '/opt/google/chrome/chrome'],
}[process.platform] ?? [];
const browser = browserPaths.find((p) => existsSync(p));
add(browser ? 'PASS' : 'WARN', 'browser for optional UI tests', browser ?? 'no Edge/Chrome found',
  'install Chrome or Edge, or set UI_BROWSER_CHANNEL=chromium and run pnpm exec playwright install chromium');
const root = docker('info', '--format', '{{.DockerRootDir}}').out || '/var/lib/docker';
const df = viaWsl ? run('wsl', ['-e', 'df', '-Pk', root]) : run('df', ['-Pk', root]);
const availKb = Number(df.out.split('\n').pop()?.trim().split(/\s+/)[3]);
if (Number.isFinite(availKb)) {
  const gb = availKb / 1024 / 1024;
  add(gb >= 5 ? 'PASS' : 'WARN', 'disk space for Docker', `${gb.toFixed(1)} GB free`, 'docker system prune (and empty the recycle bin) to get above 5 GB');
}

// --- stack ---
const up = run('node', ['scripts/dc.mjs', '--profile', 'test', 'up', '-d', '--wait', '--no-build'], { timeout: 240_000 });
add(up.ok ? 'PASS' : 'FAIL', 'stack up (db, api, db-test)', '', `run sh scripts/smoke.sh for a diagnosis${up.out ? ` — last output: ${up.out.split('\n').pop()}` : ''}`);
const smokeCmd = viaWsl ? ['wsl', ['-e', 'sh', 'scripts/smoke.sh', '--no-build']] : ['sh', ['scripts/smoke.sh', '--no-build']];
const smoke = run(smokeCmd[0], smokeCmd[1], { timeout: 300_000 });
const summary = smoke.out.split('\n').find((l) => / passed, \d+ failed/.test(l)) ?? '';
add(smoke.ok ? 'PASS' : 'FAIL', 'smoke test', summary.trim(), 'run sh scripts/smoke.sh and follow its per-check diagnosis');

// --- tests ---
if (!quick) {
  const t = run('pnpm', ['test'], { timeout: 600_000 });
  const counts = t.out.split('\n').filter((l) => /Tests\s+\d+/.test(l)).pop()?.trim() ?? '';
  add(t.ok ? 'PASS' : 'FAIL', 'pnpm test (typecheck + unit + integration)', counts, 'pnpm test:report and read .test-reports/*.log');
} else add('WARN', 'pnpm test', 'skipped (--quick)', 'run without --quick at least once today');

// --- Claude Code ---
if (existsSync('docs/claude-settings.proposed.json')) {
  const same = existsSync('.claude/settings.json') &&
    readFileSync('.claude/settings.json', 'utf8').replace(/\s/g, '') === readFileSync('docs/claude-settings.proposed.json', 'utf8').replace(/\s/g, '');
  add(same ? 'PASS' : 'WARN', 'Claude settings match the proposal', '',
    'copy docs/claude-settings.proposed.json to .claude/settings.json (fewer permission prompts live)');
}

const fails = rows.filter((r) => r.status === 'FAIL').length;
const warns = rows.filter((r) => r.status === 'WARN').length;
console.log(`\n${fails ? 'NO-GO' : 'GO'}: ${rows.length - fails - warns} pass, ${warns} warn, ${fails} fail.${fails ? ' Fix the FAIL lines above.' : ''}`);
process.exitCode = fails ? 1 : 0;
