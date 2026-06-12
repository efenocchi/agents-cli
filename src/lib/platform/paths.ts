/**
 * Path classification + normalization, platform-aware.
 */
import * as os from 'os';

/** Windows drive-letter absolute path: `C:\` or `C:/`. */
const WIN_DRIVE_RE = /^[a-zA-Z]:[\\/]/;

/**
 * Does this positional argument look like a filesystem path (vs a search term)?
 *
 * POSIX markers (`.`, `./`, `../`, `/`, `~`) are recognized on every platform —
 * identical to the long-standing behavior. Windows-only shapes (drive-letter
 * `C:\…`, UNC `\\…`, backslash-relative `.\` / `..\`) are recognized ONLY on
 * win32, so a literal `C:\repo` typed on macOS/Linux still resolves as a search
 * term — i.e. no behavior change off Windows.
 */
export function looksLikePath(query: string, platform: NodeJS.Platform = process.platform): boolean {
  if (
    query === '.' ||
    query.startsWith('./') ||
    query.startsWith('../') ||
    query.startsWith('/') ||
    query.startsWith('~')
  ) {
    return true;
  }
  if (platform === 'win32') {
    return (
      WIN_DRIVE_RE.test(query) ||
      query.startsWith('\\\\') ||
      query.startsWith('.\\') ||
      query.startsWith('..\\')
    );
  }
  return false;
}

/**
 * Normalize a path for comparison/prefix-matching: backslashes folded to forward
 * slashes and lowercased on Windows (its filesystem is case-insensitive). On
 * POSIX the input is returned unchanged, so callers behave exactly as before.
 */
export function toComparablePath(p: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return p.replace(/\\/g, '/').toLowerCase();
  return p;
}

/**
 * Canonical home directory. Use this instead of `process.env.HOME`, which is
 * unset on Windows (where the home is `USERPROFILE`); `os.homedir()` resolves
 * correctly on all three platforms.
 */
export function homeDir(): string {
  return os.homedir();
}

/**
 * Is this a Windows absolute path — a drive-letter root (`C:\`, `C:/`) or a UNC
 * share (`\\server\share`)? Used by local-source parsing to recognize a native
 * Windows path that the POSIX `/`, `./`, `../` prefixes miss. Caller decides
 * whether to apply it (typically gated on win32).
 */
export function isWindowsAbsolutePath(p: string): boolean {
  return WIN_DRIVE_RE.test(p) || p.startsWith('\\\\');
}
