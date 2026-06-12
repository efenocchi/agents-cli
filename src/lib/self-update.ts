/**
 * Self-update install plumbing.
 *
 * The hard requirement: an upgrade must replace the copy that is currently
 * running. A bare `npm install -g` writes into the global prefix of whatever
 * `npm` PATH happens to resolve — on machines with more than one node
 * installation (nvm + Homebrew + vendored runtimes) that prefix can belong to
 * a different node than the one this copy lives under. The install then
 * "succeeds" while the running copy stays stale and re-prompts forever.
 *
 * So every step here is anchored to the running package root on disk, never
 * to PATH resolution.
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';

export const NPM_PACKAGE_NAME = '@phnx-labs/agents-cli';

/**
 * Derive the npm global prefix that owns the install at `packageRoot`.
 *
 * npm's global layout for a scoped package:
 *   POSIX:   <prefix>/lib/node_modules/@phnx-labs/agents-cli
 *   Windows: <prefix>/node_modules/@phnx-labs/agents-cli
 *
 * Throws when `packageRoot` is not inside a node_modules tree (e.g. running
 * from a source checkout) — there is no prefix to install into, and guessing
 * one is exactly the bug this module exists to prevent.
 */
export function deriveGlobalPrefix(packageRoot: string): string {
  const resolved = path.resolve(packageRoot);
  // Two levels up from the package root: the scope dir, then node_modules.
  const nodeModulesDir = path.dirname(path.dirname(resolved));
  if (path.basename(nodeModulesDir) !== 'node_modules') {
    throw new Error(
      `${resolved} is not an npm-managed install; reinstall with: npm install -g ${NPM_PACKAGE_NAME}`,
    );
  }
  const parent = path.dirname(nodeModulesDir);
  return path.basename(parent) === 'lib' ? path.dirname(parent) : parent;
}

/**
 * Install `spec` into an explicit global prefix. `--prefix` pins the
 * destination no matter which npm binary PATH resolves. `--ignore-scripts`
 * skips lifecycle scripts; the caller refreshes alias shims afterwards via
 * refreshAliasShims().
 */
export async function installPackageIntoPrefix(spec: string, prefix: string): Promise<void> {
  const { execFile } = await import('child_process');
  const { promisify } = await import('util');
  const execFileAsync = promisify(execFile);
  await execFileAsync('npm', ['install', '-g', '--prefix', prefix, spec, '--ignore-scripts']);
}

/** Read the version field of the package.json at `packageRoot`, fresh from disk. */
export function readInstalledVersion(packageRoot: string): string {
  return JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf-8')).version;
}

/**
 * Assert that the install at `packageRoot` now carries `expectedVersion`.
 * npm exiting 0 only proves it wrote *somewhere*; this proves it wrote *here*.
 */
export function verifyInstalledVersion(packageRoot: string, expectedVersion: string): void {
  const actual = readInstalledVersion(packageRoot);
  if (actual !== expectedVersion) {
    throw new Error(
      `npm reported success but ${packageRoot} is still ${actual} (expected ${expectedVersion}). ` +
        `Run manually: npm install -g --prefix ${deriveGlobalPrefix(packageRoot)} ${NPM_PACKAGE_NAME}@${expectedVersion}`,
    );
  }
}

/**
 * Re-run the freshly installed copy's postinstall in shims-only mode so the
 * bare-command aliases (secrets, sessions, ...) pick up the new entrypoint
 * and any aliases added in the new version. Best-effort: a failure here
 * leaves the previous shims in place, which still point at the (now
 * upgraded) package root.
 */
export function refreshAliasShims(packageRoot: string): void {
  spawnSync(process.execPath, [path.join(packageRoot, 'scripts', 'postinstall.js')], {
    env: { ...process.env, AGENTS_POSTINSTALL_SHIMS_ONLY: '1' },
    stdio: 'ignore',
  });
}
