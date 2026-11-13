#!/usr/bin/env node
// `docker compose` that works from Windows PowerShell, WSL, Linux and macOS.
// - Uses `docker` when it's on PATH.
// - On Windows without docker (Docker Engine lives in WSL), runs it through `wsl -e docker compose`
//   (wsl maps the current C:\... directory to /mnt/c/... automatically). Set WSL_DISTRO to pick one.
// - WSL shuts its VM down when no Windows-side wsl process is alive, which stops dockerd and every
//   container. So when routing through WSL and the command starts something (up/start/restart/run),
//   this ensures a detached keep-alive (`pe-keepalive`, a named `sleep infinity`) is running.
//   Opt out with WSL_KEEPALIVE=0; stop it with: wsl -e pkill -f pe-keepalive
import { spawn, spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const has = (cmd) => spawnSync(cmd, ['--version'], { stdio: 'ignore', shell: process.platform === 'win32' }).status === 0;

let cmd = 'docker';
let full = ['compose', ...args];
if (!has('docker')) {
  if (process.platform === 'win32') {
    cmd = 'wsl';
    const distro = process.env.WSL_DISTRO ? ['-d', process.env.WSL_DISTRO] : [];
    full = [...distro, '-e', 'docker', 'compose', ...args];
    if (process.env.WSL_KEEPALIVE !== '0' && args.some((a) => ['up', 'start', 'restart', 'run'].includes(a))) {
      const alive = spawnSync('wsl', [...distro, '-e', 'pgrep', '-f', 'pe-keepalive'], { stdio: 'ignore' }).status === 0;
      if (!alive) {
        spawn('wsl', [...distro, '-e', 'bash', '-c', 'exec -a pe-keepalive sleep infinity'], {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        }).unref();
        console.error('[dc] started WSL keep-alive (pe-keepalive) so the containers survive WSL idle shutdown');
      }
    }
  } else {
    console.error('docker not found on PATH.\nFix: install Docker (Desktop, Engine or Podman with podman-docker).');
    process.exit(127);
  }
}
const r = spawnSync(cmd, full, { stdio: 'inherit' });
process.exit(r.status ?? 1);
