/**
 * Process liveness / control, platform-aware.
 */
import { execFileSync } from 'child_process';

/**
 * Forcefully terminate a process AND its descendant tree.
 *
 * Windows: `taskkill /F /T /PID` — the only reliable way to take down the whole
 * tree (a bare TerminateProcess leaves children orphaned, which is exactly the
 * "stop reported success but the tree is still alive" bug). POSIX: SIGKILL to the
 * pid (matching the existing hard-kill behavior; callers that own a process group
 * can pass the negative pid). Best-effort — never throws; an already-exited
 * process counts as success.
 */
export function killTree(pid: number): void {
  if (!pid || pid <= 0) return;
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' });
    } catch { /* already gone, or no such pid */ }
  } else {
    try {
      process.kill(pid, 'SIGKILL');
    } catch { /* already gone */ }
  }
}

/**
 * Is a process with this PID currently alive?
 *
 * Uses the signal-0 probe, which is cross-platform in Node (Windows included —
 * it maps to OpenProcess). Returns false on any error (no such process, or no
 * permission to signal it), matching the long-standing call sites that treat a
 * throw from `process.kill(pid, 0)` as "not running".
 */
export function isAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
