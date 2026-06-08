import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const CLAUDE_PROJECTS_ROOT = path.join(os.homedir(), '.claude', 'projects');

// Mirrors swarmify's workspaceToClaudeFolder: replace / and . with -
export function claudeWorkspaceFolder(cwd: string): string {
  return cwd.replace(/[\/.]/g, '-');
}

async function discoverClaudeProjectRoots(): Promise<string[]> {
  // agents-cli isolates per-version state: each installed claude version writes
  // session files under <ver-home>/.claude/projects/, NOT the symlinked
  // ~/.claude/projects/. Walk every version dir + include the symlink target.
  const roots = new Set<string>([CLAUDE_PROJECTS_ROOT]);
  const versionsRoot = path.join(os.homedir(), '.agents', '.history', 'versions', 'claude');
  try {
    const versions = await fs.promises.readdir(versionsRoot);
    for (const v of versions) {
      const r = path.join(versionsRoot, v, 'home', '.claude', 'projects');
      try {
        await fs.promises.access(r);
        roots.add(r);
      } catch {
        /* skip versions without projects dir */
      }
    }
  } catch {
    /* skip */
  }
  return [...roots];
}

export async function claudeSessionDirs(cwd: string): Promise<string[]> {
  const folder = claudeWorkspaceFolder(cwd);
  const roots = await discoverClaudeProjectRoots();
  return roots.map((r) => path.join(r, folder));
}

// Legacy single-root helper kept for any single-version-aware caller.
export function claudeSessionDir(cwd: string): string {
  return path.join(CLAUDE_PROJECTS_ROOT, claudeWorkspaceFolder(cwd));
}

export async function snapshotSessions(cwd: string): Promise<Set<string>> {
  const dirs = await claudeSessionDirs(cwd);
  const all = new Set<string>();
  for (const d of dirs) {
    try {
      const files = await fs.promises.readdir(d);
      for (const f of files) {
        if (f.endsWith('.jsonl')) all.add(`${d}/${f}`);
      }
    } catch {
      /* dir may not exist */
    }
  }
  return all;
}

export interface NewSession {
  sessionId: string;
  latencyMs: number;
  file: string;
}

export async function awaitNewSession(
  cwd: string,
  before: Set<string>,
  timeoutMs: number,
  pollMs = 50,
): Promise<NewSession | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const dirs = await claudeSessionDirs(cwd);
    for (const dir of dirs) {
      try {
        const files = await fs.promises.readdir(dir);
        for (const f of files) {
          if (!f.endsWith('.jsonl')) continue;
          const fullPath = `${dir}/${f}`;
          if (before.has(fullPath)) continue;
          return {
            sessionId: f.replace(/\.jsonl$/, ''),
            latencyMs: Date.now() - start,
            file: fullPath,
          };
        }
      } catch {
        /* dir may not exist yet */
      }
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return null;
}
