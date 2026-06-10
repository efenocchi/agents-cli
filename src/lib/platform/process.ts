/**
 * Process liveness / control, platform-aware.
 */

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
