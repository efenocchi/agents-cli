/**
 * Executable resolution, platform-aware.
 */
import { execFileSync } from 'child_process';

/** PATH-search command for the platform: `where` on Windows, else `which`. */
export function whichCommand(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'where' : 'which';
}

/**
 * Resolve an executable name to its absolute path via the OS PATH search, or
 * `null` if not found. On Windows `where` can return several lines (one per
 * PATHEXT match, e.g. `agents.cmd` and `agents.ps1`) — the first is the one the
 * shell would actually run, matching `which` semantics on POSIX.
 */
export function findExecutable(name: string, platform: NodeJS.Platform = process.platform): string | null {
  try {
    const out = execFileSync(whichCommand(platform), [name], { encoding: 'utf-8' });
    const first = out.trim().split(/\r?\n/)[0]?.trim();
    return first || null;
  } catch {
    return null;
  }
}
