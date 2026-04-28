import * as path from 'path';

/**
 * Resolve base + name while preventing path-traversal attacks.
 * Rejects path separators, null bytes, dot-prefixed names, and
 * any resolved path that escapes the base directory.
 * Allows spaces, unicode, and other common filename characters.
 */
export function safeJoin(base: string, name: string): string {
  if (
    !name ||
    name === '.' || name === '..' ||
    name.startsWith('.') ||
    /[\/\\\x00]/.test(name) ||
    name.length > 255
  ) {
    throw new Error(`Invalid name: ${name}`);
  }
  const resolved = path.resolve(base, name);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) throw new Error(`Path escape: ${name}`);
  return resolved;
}
