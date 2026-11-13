#!/usr/bin/env node
/**
 * Inner-loop test selection (an accelerator, NOT a merge gate — `pnpm test` gates commits).
 *
 *   pnpm test:changed            changes vs HEAD (staged + unstaged + untracked)
 *   pnpm test:changed main       changes vs a base ref
 *   pnpm test:changed --dry      print the plan only
 *
 * Signals:
 *   1. Import graph: `vitest related <changed source files>` finds every test that (transitively)
 *      imports a changed file.
 *   2. scripts/test-map.tsv rules for dependencies the import graph cannot see (migrations, SQL,
 *      compose, config). Rule kinds: all | project:<name> | files:<glob-ish prefix>.
 * Fail-safe: a changed file that matches nothing and is not imported by any test -> run ALL.
 * Over-running is safe; missing a regression is not. When the log says "unmapped -> ALL",
 * add a rule to test-map.tsv.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const dry = argv.includes('--dry');
const base = argv.find((a) => !a.startsWith('--'));

const git = (...a) => execFileSync('git', a, { encoding: 'utf8' }).split('\n').map((s) => s.trim()).filter(Boolean);
const changed = [
  ...new Set([
    ...(base ? git('diff', '--name-only', `${base}...HEAD`) : []),
    ...git('diff', '--name-only', 'HEAD'),
    ...git('ls-files', '--others', '--exclude-standard'),
  ]),
].filter((f) => existsSync(f));

if (!changed.length) {
  console.log('select-tests: no changes -> nothing to run');
  process.exit(0);
}

const rules = readFileSync('scripts/test-map.tsv', 'utf8')
  .split('\n')
  .filter((l) => l.trim() && !l.startsWith('#'))
  .map((l) => {
    const [pattern, action] = l.split('\t').map((s) => s.trim());
    return { re: new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '§').replace(/\*/g, '[^/]*').replace(/§/g, '.*')}$`), pattern, action };
  });

let runAll = false;
const projects = new Set();
const sources = [];
const testFiles = [];
for (const f of changed) {
  const rule = rules.find((r) => r.re.test(f));
  if (rule) {
    console.log(`  ${f}  -> rule ${rule.pattern} => ${rule.action}`);
    if (rule.action === 'all') runAll = true;
    else if (rule.action.startsWith('project:')) projects.add(rule.action.slice(8));
    else if (rule.action === 'ignore') continue;
    continue;
  }
  if (/\.test\.ts$/.test(f)) testFiles.push(f);
  else if (/\.(ts|mjs|js|json)$/.test(f) && /^(packages|scripts)\//.test(f)) sources.push(f);
  else {
    console.log(`  ${f}  -> unmapped -> ALL (add a rule to scripts/test-map.tsv)`);
    runAll = true;
  }
}

const vitest = (args) => {
  console.log(`\n$ vitest ${args.join(' ')}`);
  if (dry) return 0;
  return spawnSync('npx', ['vitest', ...args], { stdio: 'inherit', shell: process.platform === 'win32' }).status ?? 1;
};

let code = 0;
if (runAll) {
  code = vitest(['run', '--project', 'unit', '--project', 'integration']);
} else {
  for (const p of projects) code ||= vitest(['run', '--project', p]);
  if (sources.length || testFiles.length) {
    code ||= vitest(['related', '--run', '--project', 'unit', '--project', 'integration', ...sources, ...testFiles]);
  }
}
process.exit(code);
