#!/usr/bin/env node
/**
 * Run tests with output captured to files and compare failures against the known baseline.
 *
 *   pnpm test:report                      unit + integration
 *   pnpm test:report -- --project e2e     any vitest args after --
 *   pnpm test:report --set-baseline       record current failures as the known baseline
 *
 * Writes .test-reports/<stamp>.json (vitest JSON) and <stamp>.log (full console output).
 * Prints NEW failures (not in baseline) separately from KNOWN ones, so a red run caused by a
 * pre-existing failure is never blamed on the current change, and a real regression is never
 * hidden behind "it was already red". Exit 1 only on NEW failures.
 *
 * Never pipe a long test run through `tail` (it buffers until exit); read the .log instead.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const setBaseline = argv.includes('--set-baseline');
const passthru = argv.filter((a) => a !== '--set-baseline' && a !== '--');
const vitestArgs = passthru.length ? passthru : ['--project', 'unit', '--project', 'integration'];

mkdirSync('.test-reports', { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const jsonOut = `.test-reports/${stamp}.json`;
const logOut = `.test-reports/${stamp}.log`;

const r = spawnSync('npx', ['vitest', 'run', ...vitestArgs, '--reporter=default', '--reporter=json', `--outputFile.json=${jsonOut}`], {
  encoding: 'utf8',
  shell: process.platform === 'win32',
  maxBuffer: 256 * 1024 * 1024,
});
writeFileSync(logOut, `${r.stdout ?? ''}\n${r.stderr ?? ''}`);

if (!existsSync(jsonOut)) {
  console.error(`No JSON report produced (vitest exit ${r.status}). See ${logOut}`);
  console.error((r.stderr ?? '').split('\n').slice(-30).join('\n'));
  process.exit(1);
}
const report = JSON.parse(readFileSync(jsonOut, 'utf8'));
const failures = [];
for (const file of report.testResults ?? []) {
  for (const t of file.assertionResults ?? []) {
    if (t.status === 'failed') failures.push(`${file.name.replace(/\\/g, '/').replace(/^.*?packages\//, 'packages/')} > ${t.fullName}`);
  }
  if (file.status === 'failed' && !(file.assertionResults ?? []).some((t) => t.status === 'failed')) {
    failures.push(`${file.name.replace(/\\/g, '/').replace(/^.*?packages\//, 'packages/')} > (file failed to run: ${String(file.message ?? '').split('\n')[0]})`);
  }
}

const baselinePath = '.test-reports/baseline.json';
if (setBaseline) {
  writeFileSync(baselinePath, `${JSON.stringify({ recordedAt: new Date().toISOString(), failures }, null, 2)}\n`);
  console.log(`Baseline recorded: ${failures.length} known failure(s) -> ${baselinePath}`);
  process.exit(0);
}
const known = new Set(existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, 'utf8')).failures : []);
const fresh = failures.filter((f) => !known.has(f));
const stillKnown = failures.filter((f) => known.has(f));
const fixed = [...known].filter((f) => !failures.includes(f));

console.log(`\n${report.numPassedTests}/${report.numTotalTests} passed · log: ${logOut} · json: ${jsonOut}`);
if (stillKnown.length) console.log(`KNOWN (baseline) failures: ${stillKnown.length}\n${stillKnown.map((f) => `  - ${f}`).join('\n')}`);
if (fixed.length) console.log(`FIXED since baseline (update it with --set-baseline): ${fixed.length}\n${fixed.map((f) => `  + ${f}`).join('\n')}`);
if (fresh.length) {
  console.log(`NEW failures: ${fresh.length}\n${fresh.map((f) => `  ! ${f}`).join('\n')}`);
  process.exit(1);
}
console.log(fresh.length || stillKnown.length ? '' : 'All green.');
