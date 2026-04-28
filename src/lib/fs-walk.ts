import * as fs from 'fs';
import * as path from 'path';

/** Walk a directory recursively for files with a given extension. */
export function walkForFiles(dir: string, ext: string, limit: number): string[] {
  const results: { path: string; mtime: number }[] = [];

  function walk(d: string, depth: number) {
    if (depth > 5) return;
    let entries: string[];
    try {
      entries = fs.readdirSync(d);
    } catch {
      return;
    }

    for (const entry of entries) {
      const full = path.join(d, entry);
      const stat = safeStatSync(full);
      if (!stat) continue;

      if (stat.isDirectory()) {
        walk(full, depth + 1);
      } else if (entry.endsWith(ext)) {
        results.push({ path: full, mtime: stat.mtimeMs });
      }
    }
  }

  walk(dir, 0);

  results.sort((a, b) => b.mtime - a.mtime);
  return results.slice(0, limit).map(r => r.path);
}

function safeStatSync(p: string): fs.Stats | null {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}
