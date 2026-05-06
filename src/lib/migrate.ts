/**
 * One-shot idempotent migrations for the FOUNDATION refactor.
 *
 * Called from postinstall and as a command-time fallback from agents view/use/pull.
 * Each migration is guarded by an existence check so re-running is safe.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const HOME = os.homedir();
const SYSTEM_DIR = path.join(HOME, '.agents-system');
const USER_DIR = path.join(HOME, '.agents');

/**
 * Move ~/.agents-system/agents.yaml -> ~/.agents/agents.yaml.
 * No-op if user file already exists or system file absent.
 * (This is also handled inline in state.ts readMeta, but is exposed here
 *  for explicit migration calls from postinstall / CLI entry points.)
 */
function migrateAgentsYaml(): void {
  const src = path.join(SYSTEM_DIR, 'agents.yaml');
  const dest = path.join(USER_DIR, 'agents.yaml');
  if (fs.existsSync(dest) || !fs.existsSync(src)) return;
  try {
    fs.mkdirSync(USER_DIR, { recursive: true, mode: 0o700 });
    fs.renameSync(src, dest);
    console.log('Migrated agents.yaml to ~/.agents/');
  } catch { /* best-effort */ }
}

/**
 * Delete ~/.agents-system/prompts.json (dead file — zero refs in src/).
 */
function deleteSystemPromptsJson(): void {
  const f = path.join(SYSTEM_DIR, 'prompts.json');
  if (!fs.existsSync(f)) return;
  try {
    fs.unlinkSync(f);
  } catch { /* best-effort */ }
}

/**
 * Move ~/.agents-system/config.json -> ~/.agents/teams/config.json.
 * The teams persistence layer already reads the legacy path as a fallback;
 * moving it here keeps the canonical location consistent.
 */
function migrateSystemConfigJson(): void {
  const src = path.join(SYSTEM_DIR, 'config.json');
  const dest = path.join(USER_DIR, 'teams', 'config.json');
  if (!fs.existsSync(src) || fs.existsSync(dest)) return;
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
    fs.copyFileSync(src, dest);
    fs.unlinkSync(src);
  } catch { /* best-effort */ }
}

/**
 * Move promptcuts.yaml from each repo root into hooks/ subdir.
 *   ~/.agents-system/promptcuts.yaml -> ~/.agents-system/hooks/promptcuts.yaml
 *   ~/.agents/promptcuts.yaml        -> ~/.agents/hooks/promptcuts.yaml
 * Idempotent: skips if dest already exists or src absent.
 */
function migratePromptcutsIntoHooks(): void {
  for (const root of [SYSTEM_DIR, USER_DIR]) {
    const src = path.join(root, 'promptcuts.yaml');
    const dest = path.join(root, 'hooks', 'promptcuts.yaml');
    if (fs.existsSync(dest) || !fs.existsSync(src)) continue;
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
      fs.renameSync(src, dest);
    } catch { /* best-effort */ }
  }
}

/**
 * Move installed agent versions from the legacy single-root layout
 * (~/.agents/versions/<agent>/<ver>/) into the system root
 * (~/.agents-system/versions/<agent>/<ver>/).
 *
 * Pre-split installs put binaries and home dirs under ~/.agents/. After the
 * split, the system code only scans ~/.agents-system/versions/, so without
 * this migration the versions become invisible to listInstalledVersions and
 * every command that depends on it (view, prune, run).
 *
 * Idempotent and non-destructive: if a same-named dest already exists we
 * leave the legacy copy in place so the user can reconcile manually.
 */
function migrateUserVersionsToSystem(): void {
  const userVersions = path.join(USER_DIR, 'versions');
  const sysVersions = path.join(SYSTEM_DIR, 'versions');
  if (!fs.existsSync(userVersions)) return;

  let movedCount = 0;
  let skippedCount = 0;

  let agentEntries: fs.Dirent[];
  try {
    agentEntries = fs.readdirSync(userVersions, { withFileTypes: true });
  } catch {
    return;
  }

  for (const agent of agentEntries) {
    if (!agent.isDirectory()) continue;
    const srcAgentDir = path.join(userVersions, agent.name);
    const dstAgentDir = path.join(sysVersions, agent.name);
    try {
      fs.mkdirSync(dstAgentDir, { recursive: true, mode: 0o700 });
    } catch { /* best-effort */ }

    let verEntries: fs.Dirent[];
    try {
      verEntries = fs.readdirSync(srcAgentDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const ver of verEntries) {
      if (!ver.isDirectory()) continue;
      const src = path.join(srcAgentDir, ver.name);
      const dst = path.join(dstAgentDir, ver.name);
      if (fs.existsSync(dst)) {
        skippedCount++;
        continue;
      }
      try {
        fs.renameSync(src, dst);
        movedCount++;
      } catch { /* best-effort, leave legacy in place */ }
    }
    try {
      if (fs.readdirSync(srcAgentDir).length === 0) fs.rmdirSync(srcAgentDir);
    } catch { /* best-effort */ }
  }

  try {
    if (fs.readdirSync(userVersions).length === 0) fs.rmdirSync(userVersions);
  } catch { /* best-effort */ }

  if (movedCount > 0) {
    console.log(`Migrated ${movedCount} version dir${movedCount === 1 ? '' : 's'} from ~/.agents/versions/ to ~/.agents-system/versions/`);
  }
  if (skippedCount > 0) {
    console.log(`Skipped ${skippedCount} version dir${skippedCount === 1 ? '' : 's'} already present in ~/.agents-system/versions/ (kept legacy copy at ~/.agents/versions/)`);
  }
}

/**
 * Move ~/. agents/runs/ -> ~/.agents/routines/runs/.
 * Runs now live inside routines directory for cleaner organization.
 */
function migrateRunsIntoRoutines(): void {
  const src = path.join(USER_DIR, 'runs');
  const dest = path.join(USER_DIR, 'routines', 'runs');
  if (!fs.existsSync(src) || fs.existsSync(dest)) return;
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
    fs.renameSync(src, dest);
  } catch { /* best-effort */ }
}

/**
 * Move ~/.agents/trash/ -> ~/.agents/.trash/.
 * Hide the trash directory.
 */
function migrateTrashToHidden(): void {
  const src = path.join(USER_DIR, 'trash');
  const dest = path.join(USER_DIR, '.trash');
  if (!fs.existsSync(src) || fs.existsSync(dest)) return;
  try {
    fs.renameSync(src, dest);
  } catch { /* best-effort */ }
}

/**
 * Move ~/.agents/backups/ -> ~/.agents/.backups/.
 * Hide the backups directory.
 */
function migrateBackupsToHidden(): void {
  const src = path.join(USER_DIR, 'backups');
  const dest = path.join(USER_DIR, '.backups');
  if (!fs.existsSync(src) || fs.existsSync(dest)) return;
  try {
    fs.renameSync(src, dest);
  } catch { /* best-effort */ }
}

/** Run all idempotent migrations. Safe to call multiple times. */
export function runMigration(): void {
  migrateAgentsYaml();
  deleteSystemPromptsJson();
  migrateSystemConfigJson();
  migratePromptcutsIntoHooks();
  migrateUserVersionsToSystem();
  migrateRunsIntoRoutines();
  migrateTrashToHidden();
  migrateBackupsToHidden();
}
