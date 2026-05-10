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
const HISTORY_DIR = path.join(USER_DIR, '.history');
const CACHE_DIR = path.join(USER_DIR, '.cache');

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
    const userTarget = fs.existsSync(path.join(HISTORY_DIR, 'versions', agent, version, 'home', `.${agent}`))
      ? path.join(HISTORY_DIR, 'versions', agent, version, 'home', `.${agent}`)
      : path.join(USER_DIR, 'versions', agent, version, 'home', `.${agent}`);
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

/**
 * Move a directory from `src` to `dest`. No-op when src is absent. When dest
 * already exists, merge by copying everything that isn't already there, then
 * remove the source. Idempotent: re-running converges without duplicating.
 *
 * The merge-on-collision behavior matters because `ensureAgentsDir()` may have
 * pre-created an empty `dest` during startup before the migrator gets to run.
 */
function moveDirOnce(src: string, dest: string): void {
  if (!fs.existsSync(src)) return;

  if (!fs.existsSync(dest)) {
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
      fs.renameSync(src, dest);
      return;
    } catch {
      /* fall through to copy + remove */
    }
  }

  try {
    copyDirSkipExisting(src, dest);
    fs.rmSync(src, { recursive: true, force: true });
  } catch { /* best-effort */ }
}

/**
 * Move a single file from `src` to `dest`. No-op when src is absent. When
 * dest exists, the source is simply deleted (the in-place version is treated
 * as the canonical state). Idempotent.
 */
function moveFileOnce(src: string, dest: string): void {
  if (!fs.existsSync(src)) return;
  if (fs.existsSync(dest)) {
    try { fs.unlinkSync(src); } catch { /* best-effort */ }
    return;
  }
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
    fs.renameSync(src, dest);
  } catch {
    try {
      fs.copyFileSync(src, dest);
      fs.unlinkSync(src);
    } catch { /* best-effort */ }
  }
}

/** Remove a directory tree if it exists and contains no files (best-effort). */
function rmEmptyDirTree(dir: string): void {
  if (!fs.existsSync(dir)) return;
  try {
    const entries = fs.readdirSync(dir);
    for (const entry of entries) {
      const child = path.join(dir, entry);
      try {
        const stat = fs.statSync(child);
        if (stat.isDirectory()) rmEmptyDirTree(child);
      } catch { /* skip */ }
    }
    if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  } catch { /* best-effort */ }
}

/**
 * Move durable runtime data into ~/.agents/.history/.
 *
 * Sources cleared:
 *   ~/.agents/sessions/   -> ~/.agents/.history/sessions/
 *   ~/.agents/versions/   -> ~/.agents/.history/versions/
 *   ~/.agents/.trash/     -> ~/.agents/.history/trash/
 *   ~/.agents/.backups/   -> ~/.agents/.history/backups/
 *   ~/.agents/routines/runs/ -> ~/.agents/.history/runs/
 *   ~/.agents/teams/agents/  -> ~/.agents/.history/teams/agents/
 *
 * Idempotent — skips entries whose destination already exists.
 */
function migrateRuntimeToHistory(): void {
  moveDirOnce(path.join(USER_DIR, 'sessions'), path.join(HISTORY_DIR, 'sessions'));
  moveDirOnce(path.join(USER_DIR, 'versions'), path.join(HISTORY_DIR, 'versions'));
  // Some installs left both `.trash/` (current) and `trash/` (legacy lowercase).
  // Move whichever exist into the history bucket.
  moveDirOnce(path.join(USER_DIR, '.trash'), path.join(HISTORY_DIR, 'trash'));
  moveDirOnce(path.join(USER_DIR, 'trash'), path.join(HISTORY_DIR, 'trash'));
  moveDirOnce(path.join(USER_DIR, '.backups'), path.join(HISTORY_DIR, 'backups'));
  moveDirOnce(path.join(USER_DIR, 'routines', 'runs'), path.join(HISTORY_DIR, 'runs'));
  moveDirOnce(path.join(USER_DIR, 'teams', 'agents'), path.join(HISTORY_DIR, 'teams', 'agents'));

  // Drop any empty leftover skeletons created mid-rename (e.g. `versions/<agent>/<v>/home/`
  // recreated by a concurrent process). The real data is already under .history/.
  rmEmptyDirTree(path.join(USER_DIR, 'versions'));
  rmEmptyDirTree(path.join(USER_DIR, 'sessions'));
  // Old empty zero-byte sessions.db at user root is obsolete once the new db lives at
  // .history/sessions/sessions.db.
  const oldSessionsDb = path.join(USER_DIR, 'sessions.db');
  if (fs.existsSync(oldSessionsDb)) {
    try {
      if (fs.statSync(oldSessionsDb).size === 0) fs.unlinkSync(oldSessionsDb);
    } catch { /* best-effort */ }
  }
}

/**
 * Move regenerable runtime data into ~/.agents/.cache/.
 *
 * Sources cleared:
 *   ~/.agents/shims/         -> ~/.agents/.cache/shims/
 *   ~/.agents/bin/           -> ~/.agents/.cache/bin/
 *   ~/.agents/packages/      -> ~/.agents/.cache/packages/
 *   ~/.agents/plugins/       -> ~/.agents/.cache/plugins/
 *   ~/.agents/cloud/         -> ~/.agents/.cache/cloud/
 *   ~/.agents/drive/         -> ~/.agents/.cache/drive/
 *   ~/.agents/terminals/     -> ~/.agents/.cache/terminals/
 *   ~/.agents/logs/          -> ~/.agents/.cache/logs/
 *   ~/.agents/swarmify/      -> ~/.agents/.cache/swarmify/
 *   ~/.agents/runtime/       -> ~/.agents/.cache/state/
 *   ~/.agents/cache/         -> ~/.agents/.cache/   (flatten — already a cache subdir)
 *   ~/.agents/helpers/{daemon,pty,...} -> ~/.agents/.cache/helpers/...
 *   ~/.agents-system/helpers/{daemon,pty,...} -> ~/.agents/.cache/helpers/...
 *   ~/.agents/browser/<profile>/  -> ~/.agents/.cache/browser/<profile>/  (profiles/ dir stays)
 *   ~/.agents-system/.fetch/ -> ~/.agents/.cache/.fetch/
 *
 * Loose dot-files at user root that are runtime caches:
 *   ~/.agents/.cli-version-cache.json -> ~/.agents/.cache/.cli-version-cache.json
 *   ~/.agents/.update-check           -> ~/.agents/.cache/.update-check
 *   ~/.agents/.migrated               -> ~/.agents/.cache/.migrated
 *   ~/.agents/watchdog.log            -> ~/.agents/.cache/logs/watchdog.log
 *
 * Idempotent.
 */
function migrateRuntimeToCache(): void {
  moveDirOnce(path.join(USER_DIR, 'shims'), path.join(CACHE_DIR, 'shims'));
  moveDirOnce(path.join(USER_DIR, 'bin'), path.join(CACHE_DIR, 'bin'));
  moveDirOnce(path.join(USER_DIR, 'packages'), path.join(CACHE_DIR, 'packages'));
  moveDirOnce(path.join(USER_DIR, 'plugins'), path.join(CACHE_DIR, 'plugins'));
  moveDirOnce(path.join(USER_DIR, 'cloud'), path.join(CACHE_DIR, 'cloud'));
  moveDirOnce(path.join(USER_DIR, 'drive'), path.join(CACHE_DIR, 'drive'));
  // terminals/ stays at the top level: the agents-cli IDE extension publishes
  // ~/.agents/terminals/live-terminals.json and would race with the move on
  // VS Code restart. Leave the path where the extension expects it.
  moveDirOnce(path.join(USER_DIR, 'logs'), path.join(CACHE_DIR, 'logs'));
  moveDirOnce(path.join(USER_DIR, 'swarmify'), path.join(CACHE_DIR, 'swarmify'));
  moveDirOnce(path.join(USER_DIR, 'runtime'), path.join(CACHE_DIR, 'state'));

  // Pre-existing user `cache/` dir (claude usage cache, cloud-runs, etc.) — flatten
  // so it's not confused with the new bucket. Its contents merge into .cache/.
  const oldCache = path.join(USER_DIR, 'cache');
  if (fs.existsSync(oldCache) && fs.statSync(oldCache).isDirectory()) {
    try {
      fs.mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 });
      copyDirSkipExisting(oldCache, CACHE_DIR);
      fs.rmSync(oldCache, { recursive: true, force: true });
    } catch { /* best-effort */ }
  }

  // helpers/ at user-root and system-root → .cache/helpers/
  for (const root of [USER_DIR, SYSTEM_DIR]) {
    const src = path.join(root, 'helpers');
    if (!fs.existsSync(src)) continue;
    const destBase = path.join(CACHE_DIR, 'helpers');
    try {
      fs.mkdirSync(destBase, { recursive: true, mode: 0o700 });
      copyDirSkipExisting(src, destBase);
      fs.rmSync(src, { recursive: true, force: true });
    } catch { /* best-effort */ }
  }

  // browser runtime — keep browser/profiles/ in place, move everything else under
  // browser/ into .cache/browser/.
  const browserSrc = path.join(USER_DIR, 'browser');
  if (fs.existsSync(browserSrc) && fs.statSync(browserSrc).isDirectory()) {
    let entries: string[] = [];
    try { entries = fs.readdirSync(browserSrc); } catch { /* skip */ }
    for (const entry of entries) {
      if (entry === 'profiles') continue;
      const src = path.join(browserSrc, entry);
      const dest = path.join(CACHE_DIR, 'browser', entry);
      moveDirOnce(src, dest);
    }
  }

  // System-root operational state that should not live in the npm-shipped repo.
  moveDirOnce(path.join(SYSTEM_DIR, '.fetch'), path.join(CACHE_DIR, '.fetch'));
  moveDirOnce(path.join(SYSTEM_DIR, 'browser'), path.join(CACHE_DIR, 'browser'));
  moveDirOnce(path.join(SYSTEM_DIR, 'state'), path.join(CACHE_DIR, 'state'));
  moveDirOnce(path.join(SYSTEM_DIR, 'swarmify'), path.join(CACHE_DIR, 'swarmify'));
  moveFileOnce(path.join(SYSTEM_DIR, '.cli-version-cache.json'), path.join(CACHE_DIR, '.cli-version-cache.json'));
  moveFileOnce(path.join(SYSTEM_DIR, '.update-check'), path.join(CACHE_DIR, '.update-check'));
  moveFileOnce(path.join(SYSTEM_DIR, '.migrated'), path.join(CACHE_DIR, '.migrated'));
  moveFileOnce(path.join(SYSTEM_DIR, '.models-cache.json'), path.join(CACHE_DIR, '.models-cache.json'));

  // Loose dot-files at user root that belong in the cache bucket.
  moveFileOnce(path.join(USER_DIR, '.cli-version-cache.json'), path.join(CACHE_DIR, '.cli-version-cache.json'));
  moveFileOnce(path.join(USER_DIR, '.update-check'), path.join(CACHE_DIR, '.update-check'));
  moveFileOnce(path.join(USER_DIR, '.migrated'), path.join(CACHE_DIR, '.migrated'));
  moveFileOnce(path.join(USER_DIR, '.models-cache.json'), path.join(CACHE_DIR, '.models-cache.json'));
  moveFileOnce(path.join(USER_DIR, 'watchdog.log'), path.join(CACHE_DIR, 'logs', 'watchdog.log'));
}

/** Run all idempotent migrations. Safe to call multiple times. */
export function runMigration(): void {
  migrateAgentsYaml();
  deleteSystemPromptsJson();
  migrateSystemConfigJson();
  migratePromptcutsIntoHooks();
  migrateSystemVersionsToUser();
  mergeOverlappingVersionHomes();
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
  // Bucket moves: collapse runtime state into ~/.agents/.history and ~/.agents/.cache.
  // Symlink repair runs LAST so it can find the post-move version homes.
  migrateRuntimeToHistory();
  migrateRuntimeToCache();
  repairAgentConfigSymlinks();
}
