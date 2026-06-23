/**
 * Windows User PATH + execution-policy primitives.
 *
 * The single place that mutates the Windows User PATH via the .NET environment
 * API (which writes the registry AND broadcasts WM_SETTINGCHANGE — the correct
 * analog of editing a shell rc file: no `setx` truncation, no manual step).
 * Consumers: `shims.ts` (shims dir) and `scripts/postinstall.js` (npm global-bin
 * dir, so the `agents` command itself resolves).
 *
 * Leaf module — imports only `child_process` and `path` so it is cheap to load
 * from the npm lifecycle script without pulling the rest of the CLI.
 */
import { execFileSync } from 'child_process';
import * as path from 'path';

export interface WinPathResult {
  success: boolean;
  /** True when `dir` was already the first PATH entry (no write performed). */
  alreadyPresent?: boolean;
  error?: string;
}

/**
 * Prepend `dir` to the Windows User PATH. Idempotent: a no-op when `dir` is
 * already first; moves it to the front when it exists but is positioned later
 * (e.g. appended by an older install) so it overrides conflicting entries.
 * `dir` is passed via an env var so it is never interpolated into the script
 * text.
 */
export function prependToWindowsUserPath(dir: string): WinPathResult {
  const script = [
    '$d = $env:AGENTS_WINPATH_DIR',
    "$u = [Environment]::GetEnvironmentVariable('Path','User')",
    "if ($null -eq $u) { $u = '' }",
    "$parts = @($u -split ';' | Where-Object { $_ -ne '' })",
    // Already first — nothing to do
    "if ($parts.Count -gt 0 -and $parts[0] -eq $d) { 'present' } else {",
    // Remove any existing occurrence then prepend, matching POSIX `export PATH="${dir}:$PATH"`
    "  $newParts = @($d) + @($parts | Where-Object { $_ -ne $d })",
    "  [Environment]::SetEnvironmentVariable('Path', ($newParts -join ';'), 'User')",
    "  'added'",
    '}',
  ].join('\n');
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf-8',
      env: { ...process.env, AGENTS_WINPATH_DIR: dir },
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    return { success: true, alreadyPresent: out.includes('present') };
  } catch (err) {
    return { success: false, error: `Could not update the Windows user PATH: ${(err as Error).message}` };
  }
}

/**
 * The effective PowerShell execution policy (e.g. `Restricted`, `RemoteSigned`),
 * or null if it can't be determined (PowerShell missing / errored).
 */
export function getEffectiveExecutionPolicy(): string | null {
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', 'Get-ExecutionPolicy'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

/**
 * Whether a policy blocks running unsigned local `.ps1` scripts — which is what
 * npm and agents-cli generate (`npm.ps1`, `agents.ps1`). Under these the bare
 * `agents` / `npm` commands fail in PowerShell with a security error even when
 * on PATH. Pure — testable on any host.
 */
export function blocksLocalScripts(policy: string | null): boolean {
  if (!policy) return false;
  const p = policy.trim().toLowerCase();
  return p === 'restricted' || p === 'allsigned';
}

/**
 * Resolve the npm global-bin directory (where the generated `agents` /
 * `agents.cmd` launchers live, and where npm expects PATH to point) from the
 * package entrypoint. On Windows npm places bin launchers directly in the
 * prefix root, so the bin dir is the prefix itself.
 *
 * entry = `<prefix>/node_modules/@phnx-labs/agents-cli/dist/index.js` → `<prefix>`
 */
export function npmGlobalBinFromEntry(entryJsPath: string): string {
  return path.resolve(path.dirname(entryJsPath), '..', '..', '..', '..');
}
