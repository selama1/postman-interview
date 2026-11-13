#!/usr/bin/env node
// `docker compose` that works from Windows PowerShell, WSL, Linux and macOS.
// - Uses `docker` when it's on PATH.
// - On Windows without docker (Docker Engine lives in WSL), runs it through `wsl -e docker compose`
//   (wsl maps the current C:\... directory to /mnt/c/... automatically). Set WSL_DISTRO to pick one.
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const has = (cmd) => spawnSync(cmd, ['--version'], { stdio: 'ignore', shell: process.platform === 'win32' }).status === 0;

let cmd = 'docker';
let full = ['compose', ...args];
if (!has('docker')) {
  if (process.platform === 'win32') {
    cmd = 'wsl';
    full = [...(process.env.WSL_DISTRO ? ['-d', process.env.WSL_DISTRO] : []), '-e', 'docker', 'compose', ...args];
  } else {
    console.error('docker not found on PATH.\nFix: install Docker (Desktop, Engine or Podman with podman-docker).');
    process.exit(127);
  }
}
const r = spawnSync(cmd, full, { stdio: 'inherit' });
process.exit(r.status ?? 1);
