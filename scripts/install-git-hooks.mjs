// Points git at the versioned hooks in .githooks/ (runs on `pnpm install` via "prepare").
// Idempotent; silently skips outside a git checkout (e.g. inside the Docker build).
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

if (!existsSync('.git')) process.exit(0);
try {
  execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { stdio: 'ignore' });
} catch {
  // git not on PATH: hooks are optional
}
