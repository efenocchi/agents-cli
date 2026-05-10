/**
 * One-shot idempotent migrations for the FOUNDATION refactor.
 *
 * Called from postinstall and as a command-time fallback from agents view/use/pull.
 * Each migration is guarded by an existence check so re-running is safe.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as yaml from 'yaml';

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
 * Move installed agent versions from the legacy system-root layout
 * (~/.agents-system/versions/<agent>/<ver>/) into the user root
 * (~/.agents/versions/<agent>/<ver>/).
 *
 * Earlier installs (and an inverted prior version of this migrator) put
 * binaries and home dirs under ~/.agents-system/. The current architecture
 * keeps all operational state (versions, sessions, shims, trash) under
 * ~/.agents/, and getVersionsDir() in state.ts resolves there. Without this
 * migration the legacy versions become invisible to listInstalledVersions
 * and every command that depends on it (view, prune, run, sync) writes a
 * second copy to ~/.agents/versions/ while the agent CLIs keep reading the
 * stale ~/.agents-system/versions/ copy via the existing ~/.<agent> symlink.
 *
 * Idempotent and non-destructive: if a same-named dest already exists we
 * leave the legacy copy in place so the user can reconcile manually.
 */
function migrateSystemVersionsToUser(): void {
  const sysVersions = path.join(SYSTEM_DIR, 'versions');
  const userVersions = path.join(USER_DIR, 'versions');
  if (!fs.existsSync(sysVersions)) return;

  let movedCount = 0;
  let skippedCount = 0;

  let agentEntries: fs.Dirent[];
  try {
    agentEntries = fs.readdirSync(sysVersions, { withFileTypes: true });
  } catch {
    return;
  }

  for (const agent of agentEntries) {
    if (!agent.isDirectory()) continue;
    const srcAgentDir = path.join(sysVersions, agent.name);
    const dstAgentDir = path.join(userVersions, agent.name);
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
    if (fs.readdirSync(sysVersions).length === 0) fs.rmdirSync(sysVersions);
  } catch { /* best-effort */ }

  if (movedCount > 0) {
    console.log(`Migrated ${movedCount} version dir${movedCount === 1 ? '' : 's'} from ~/.agents-system/versions/ to ~/.agents/versions/`);
  }
  if (skippedCount > 0) {
    console.log(`Skipped ${skippedCount} version dir${skippedCount === 1 ? '' : 's'} already present in ~/.agents/versions/ (kept legacy copy at ~/.agents-system/versions/)`);
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

/**
 * Fold ~/.agents/hooks.yaml into ~/.agents/agents.yaml under a `hooks:` key,
 * then delete the standalone hooks.yaml. Single user file to sync.
 *
 * On collision (a hook name already exists in agents.yaml hooks:), the
 * existing agents.yaml entry wins and the standalone copy is dropped — this
 * matches the behavior a user would get if they had already migrated
 * manually and edited agents.yaml.
 *
 * Idempotent: skips if hooks.yaml is absent or unparseable.
 */
function foldUserHooksYamlIntoAgentsYaml(): void {
  const hooksFile = path.join(USER_DIR, 'hooks.yaml');
  if (!fs.existsSync(hooksFile)) return;

  let hooks: Record<string, unknown>;
  try {
    const raw = fs.readFileSync(hooksFile, 'utf-8');
    const parsed = yaml.parse(raw) as Record<string, unknown> | null;
    hooks = parsed && typeof parsed === 'object' ? parsed : {};
  } catch { return; }

  const metaFile = path.join(USER_DIR, 'agents.yaml');
  let meta: Record<string, unknown> = {};
  if (fs.existsSync(metaFile)) {
    try {
      const raw = fs.readFileSync(metaFile, 'utf-8');
      const parsed = yaml.parse(raw) as Record<string, unknown> | null;
      if (parsed && typeof parsed === 'object') meta = parsed;
    } catch { return; }
  }

  const existingHooks = (meta.hooks as Record<string, unknown> | undefined) ?? {};
  const merged: Record<string, unknown> = { ...hooks, ...existingHooks };
  meta.hooks = merged;

  const header = `# agents-cli metadata
# Auto-generated - do not edit manually
# https://github.com/phnx-labs/agents-cli

`;
  try {
    fs.mkdirSync(USER_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(metaFile, header + yaml.stringify(meta), 'utf-8');
    fs.unlinkSync(hooksFile);
    console.log('Folded ~/.agents/hooks.yaml into ~/.agents/agents.yaml (hooks: section)');
  } catch { /* best-effort */ }
}

/**
 * Delete ~/.agents/linear.json. The linear-cli now manages its own
 * credentials in the OS keychain; this file was a legacy plaintext store.
 */
function deleteUserLinearJson(): void {
  const f = path.join(USER_DIR, 'linear.json');
  if (!fs.existsSync(f)) return;
  try {
    fs.unlinkSync(f);
  } catch { /* best-effort */ }
}

/**
 * Delete ~/.agents/prompts.json. Dead file with zero refs in src/ (the
 * system-repo copy was cleared by deleteSystemPromptsJson; this is the
 * matching cleanup at the user layer).
 */
function deleteUserPromptsJson(): void {
  const f = path.join(USER_DIR, 'prompts.json');
  if (!fs.existsSync(f)) return;
  try {
    fs.unlinkSync(f);
  } catch { /* best-effort */ }
}

/**
 * Delete ~/.agents/config.json. The canonical teams config is at
 * ~/.agents/teams/config.json (teams/persistence.ts). If the canonical
 * file exists we just unlink the legacy copy; otherwise migrate first.
 */
function cleanupUserConfigJson(): void {
  const legacy = path.join(USER_DIR, 'config.json');
  if (!fs.existsSync(legacy)) return;
  const canonical = path.join(USER_DIR, 'teams', 'config.json');
  try {
    if (!fs.existsSync(canonical)) {
      fs.mkdirSync(path.dirname(canonical), { recursive: true, mode: 0o700 });
      fs.copyFileSync(legacy, canonical);
    }
    fs.unlinkSync(legacy);
  } catch { /* best-effort */ }
}

/**
 * Remove an empty ~/.agents/runs/ directory left over after the
 * migrateRunsIntoRoutines() rename. Some older code paths re-created the
 * empty parent; this trims it once it has no contents.
 */
function cleanupEmptyTopLevelRuns(): void {
  const dir = path.join(USER_DIR, 'runs');
  if (!fs.existsSync(dir)) return;
  try {
    if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  } catch { /* best-effort */ }
}

/**
 * Move ~/.agents-system/aliases.json -> ~/.agents/aliases.json.
 * Aliases are per-user state and were previously written to the system root
 * by mistake. Idempotent: skips if dest already exists or src absent.
 */
function migrateAliasesToUser(): void {
  const src = path.join(SYSTEM_DIR, 'aliases.json');
  const dest = path.join(USER_DIR, 'aliases.json');
  if (fs.existsSync(dest) || !fs.existsSync(src)) return;
  try {
    fs.mkdirSync(USER_DIR, { recursive: true, mode: 0o700 });
    fs.renameSync(src, dest);
  } catch { /* best-effort */ }
}

/**
 * For overlapping versions that exist in BOTH ~/.agents-system/versions/ and
 * ~/.agents/versions/, merge legacy operational state (history, sessions,
 * settings) into the user copy without overwriting any files synced by
 * agents-cli (skills, commands, hooks, memory). Then drop the legacy copy.
 *
 * Why: when both paths exist, the inverted-prior migrator left them split.
 * Agent CLIs read from ~/.<agent> (a symlink that historically targeted
 * the system path), while sync writes to the user path. Same skill ends up
 * in both → duplicate entries in the skills picker, stale state, broken
 * resource resolution.
 *
 * Strategy: copy legacy → user with "skip if exists". Sync-managed dirs
 * (which live in user already, freshly written) stay untouched. Anything
 * the agent CLI created on its own (history.jsonl, sessions/, settings.json,
 * file-history/, paste-cache/, …) lands in user where it belongs. The
 * legacy version-home is then renamed into ~/.agents/.trash/versions/ so
 * it's recoverable.
 */
function mergeOverlappingVersionHomes(): void {
  const sysVersions = path.join(SYSTEM_DIR, 'versions');
  const userVersions = path.join(USER_DIR, 'versions');
  if (!fs.existsSync(sysVersions)) return;

  let mergedCount = 0;
  let agentEntries: fs.Dirent[];
  try {
    agentEntries = fs.readdirSync(sysVersions, { withFileTypes: true });
  } catch {
    return;
  }

  for (const agent of agentEntries) {
    if (!agent.isDirectory()) continue;
    const sysAgentDir = path.join(sysVersions, agent.name);
    const userAgentDir = path.join(userVersions, agent.name);
    let verEntries: fs.Dirent[];
    try {
      verEntries = fs.readdirSync(sysAgentDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ver of verEntries) {
      if (!ver.isDirectory()) continue;
      const sysHome = path.join(sysAgentDir, ver.name, 'home');
      const userHome = path.join(userAgentDir, ver.name, 'home');
      if (!fs.existsSync(sysHome) || !fs.existsSync(userHome)) continue;

      try {
        copyDirSkipExisting(sysHome, userHome);

        const trashRoot = path.join(USER_DIR, '.trash', 'versions', agent.name, ver.name);
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        fs.mkdirSync(trashRoot, { recursive: true, mode: 0o700 });
        fs.renameSync(path.join(sysAgentDir, ver.name), path.join(trashRoot, `legacy-${stamp}`));
        mergedCount++;
      } catch { /* best-effort */ }
    }
    try {
      if (fs.readdirSync(sysAgentDir).length === 0) fs.rmdirSync(sysAgentDir);
    } catch { /* best-effort */ }
  }
  try {
    if (fs.readdirSync(sysVersions).length === 0) fs.rmdirSync(sysVersions);
  } catch { /* best-effort */ }

  if (mergedCount > 0) {
    console.log(`Merged ${mergedCount} overlapping version home${mergedCount === 1 ? '' : 's'} from legacy ~/.agents-system/versions/ into ~/.agents/versions/ (legacy moved to ~/.agents/.trash/versions/)`);
  }
}

function copyDirSkipExisting(src: string, dest: string): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(src, { withFileTypes: true });
  } catch {
    return;
  }
  fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
  for (const entry of entries) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (fs.existsSync(d)) {
      if (entry.isDirectory()) {
        const dStat = fs.lstatSync(d);
        if (dStat.isDirectory()) copyDirSkipExisting(s, d);
      }
      continue;
    }
    try {
      fs.renameSync(s, d);
    } catch {
      try {
        if (entry.isDirectory()) {
          copyDirSkipExisting(s, d);
        } else if (entry.isSymbolicLink()) {
          fs.symlinkSync(fs.readlinkSync(s), d);
        } else {
          fs.copyFileSync(s, d);
        }
      } catch { /* best-effort */ }
    }
  }
}

/**
 * Rename ~/.agents/permissions/sets/ -> ~/.agents/permissions/presets/.
 * Also handles ~/.agents-system/permissions/sets/ for system repo.
 * Idempotent: skips if dest already exists or src absent.
 */
function migratePermissionSetsToPresets(): void {
  for (const root of [USER_DIR, SYSTEM_DIR]) {
    const src = path.join(root, 'permissions', 'sets');
    const dest = path.join(root, 'permissions', 'presets');
    if (!fs.existsSync(src) || fs.existsSync(dest)) continue;
    try {
      fs.renameSync(src, dest);
      const label = root === USER_DIR ? '~/.agents' : '~/.agents-system';
      console.log(`Migrated ${label}/permissions/sets/ to ${label}/permissions/presets/`);
    } catch { /* best-effort */ }
  }
}

/**
 * After versions are migrated to ~/.agents/versions/, rewrite the per-agent
 * config symlinks (~/.claude, ~/.codex, …) to point at the user-side
 * version-home so the agent CLIs read fresh resources.
 *
 * Idempotent: if the symlink already points at the right user-path target,
 * leave it. If it points at the legacy system path, re-create it. If a real
 * directory exists there (no symlink yet), leave it alone — version-config
 * switching is owned by `agents use`, not the migrator.
 */
function repairAgentConfigSymlinks(): void {
  let yaml: string;
  try {
    yaml = fs.readFileSync(path.join(USER_DIR, 'agents.yaml'), 'utf-8');
  } catch {
    return;
  }
  const agentsBlock = yaml.match(/^agents:\s*\n((?:  [^\n]*\n)+)/m);
  if (!agentsBlock) return;
  const defaults: Array<{ agent: string; version: string }> = [];
  for (const line of agentsBlock[1].split('\n')) {
    const m = line.match(/^\s+([a-z][a-z0-9_-]*):\s*([^\s#]+)/);
    if (m) defaults.push({ agent: m[1], version: m[2] });
  }

  let repaired = 0;
  for (const { agent, version } of defaults) {
    const userTarget = path.join(USER_DIR, 'versions', agent, version, 'home', `.${agent}`);
    if (!fs.existsSync(userTarget)) continue;

    const symlinkPath = path.join(HOME, `.${agent}`);
    let stat: fs.Stats | null = null;
    try { stat = fs.lstatSync(symlinkPath); } catch { /* missing */ }
    if (stat && stat.isSymbolicLink()) {
      let current: string;
      try { current = fs.readlinkSync(symlinkPath); } catch { continue; }
      const resolved = path.resolve(path.dirname(symlinkPath), current);
      if (resolved === path.resolve(userTarget)) continue; // already correct
      try {
        fs.unlinkSync(symlinkPath);
        fs.symlinkSync(userTarget, symlinkPath);
        repaired++;
      } catch { /* best-effort */ }
    } else if (!stat) {
      try {
        fs.symlinkSync(userTarget, symlinkPath);
        repaired++;
      } catch { /* best-effort */ }
    }
  }

  if (repaired > 0) {
    console.log(`Repaired ${repaired} agent config symlink${repaired === 1 ? '' : 's'} to point at ~/.agents/versions/`);
  }
}

/** Run all idempotent migrations. Safe to call multiple times. */
export function runMigration(): void {
  migrateAgentsYaml();
  deleteSystemPromptsJson();
  migrateSystemConfigJson();
  migratePromptcutsIntoHooks();
  migrateSystemVersionsToUser();
  mergeOverlappingVersionHomes();
  repairAgentConfigSymlinks();
  migrateRunsIntoRoutines();
  migrateTrashToHidden();
  migrateBackupsToHidden();
  migrateAliasesToUser();
  migratePermissionSetsToPresets();
  deleteUserLinearJson();
  deleteUserPromptsJson();
  cleanupUserConfigJson();
  cleanupEmptyTopLevelRuns();
  foldUserHooksYamlIntoAgentsYaml();
}
