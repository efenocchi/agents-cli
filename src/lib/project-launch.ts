/**
 * Launch-time project compile. Invoked by the agent shim's hot path (via
 * `agents sync --launch`) between version resolve and binary exec.
 *
 * Three responsibilities, all skip-fast when there's nothing to do:
 *
 * 1. Compile project rules from `<cwd>/.agents/rules/` into `<cwd>/AGENTS.md`
 *    (+ per-agent symlinks). Delegates to compileRulesForProject, which is
 *    the same helper management-side `agents sync` uses.
 *
 * 2. Mirror project resources from `<cwd>/.agents/{subagents,commands,skills}`
 *    and `<cwd>/.agents/mcp.json` into the agent's workspace-local discovery
 *    dirs (`<cwd>/.{agent}/agents/`, `<cwd>/.{agent}/commands/`,
 *    `<cwd>/.{agent}/skills/`, `<cwd>/.mcp.json`). File-level symlinks so
 *    edits in the source dir are live without re-sync. Skips any dest entry
 *    that already exists and isn't one of our symlinks (don't-clobber).
 *
 * 3. Synthesize four scope-grouped plugin marketplaces under the version's
 *    `<versionHome>/.{agent}/plugins/marketplaces/`:
 *      - agents-cli         ← ~/.agents/plugins/*           (user scope, legacy name)
 *      - agents-system      ← ~/.agents/.system/plugins/*
 *      - extras-<alias>     ← ~/.agents-<alias>/plugins/*   (per enabled extra)
 *      - agents-project     ← <cwd>/.agents/plugins/*
 *    Each plugin is copied in, the marketplace catalog is rewritten, the
 *    marketplace is registered in known_marketplaces.json, and every plugin
 *    is enabled in settings.json. Upstream marketplaces like
 *    "claude-plugins-official" are left untouched — we only own the four
 *    names above.
 *
 * Heavy work (version-home reconciliation, hook registration, MCP merging)
 * stays in `agents sync` without --launch and is NOT touched here. The
 * launch path is filesystem-only and aims for sub-50ms in steady state.
 */

import * as fs from 'fs';
import * as path from 'path';
import { AGENTS } from './agents.js';
import type { AgentId } from './types.js';
import {
  getEnabledExtraRepos,
  getExtraPluginsDir,
  getPluginsDir,
  getProjectAgentsDir,
  getProjectPluginsDir,
  getSystemPluginsDir,
} from './state.js';
import { getVersionHomePath } from './versions.js';
import { compileRulesForProject } from './rules/compile.js';
import { discoverPluginsInDir } from './plugins.js';
import {
  MARKETPLACE_NAME,
  PROJECT_MARKETPLACE_NAME,
  SYSTEM_MARKETPLACE_NAME,
  copyPluginToMarketplace,
  enablePluginInSettings,
  extrasMarketplaceName,
  registerMarketplace,
  syncMarketplaceManifest,
} from './plugin-marketplace.js';

export interface LaunchSyncOptions {
  agent: AgentId;
  version: string;
  cwd: string;
}

export interface LaunchSyncResult {
  /** Project rules were re-compiled into cwd/AGENTS.md (+ per-agent symlinks). */
  rulesCompiled: boolean;
  /** Number of workspace resource symlinks created or refreshed. */
  workspaceLinks: number;
  /** Workspace resource paths we left alone because they exist and aren't ours. */
  workspaceSkipped: string[];
  /** Map of marketplace name → plugin names installed under it. */
  marketplaces: Record<string, string[]>;
}

/**
 * Run the launch-time project compile. Safe to call on every agent launch:
 * each step is idempotent and skips when its inputs are missing.
 */
export function runLaunchSync(opts: LaunchSyncOptions): LaunchSyncResult {
  const result: LaunchSyncResult = {
    rulesCompiled: false,
    workspaceLinks: 0,
    workspaceSkipped: [],
    marketplaces: {},
  };

  // Step 1: project rules
  try {
    const r = compileRulesForProject(opts.cwd);
    result.rulesCompiled = r.compiled;
  } catch {
    // Don't fail launch on a malformed project rules.yaml.
  }

  // Step 2: workspace resource mirror
  const mirror = mirrorWorkspaceResources(opts.cwd, opts.agent);
  result.workspaceLinks = mirror.links;
  result.workspaceSkipped = mirror.skipped;

  // Step 3: scoped plugin marketplaces
  result.marketplaces = synthesizeScopedMarketplaces(opts.agent, opts.version, opts.cwd);

  return result;
}

// ─── Step 2: workspace resource mirror ────────────────────────────────────────

interface MirrorPlan {
  /** Source dir under `<cwd>/.agents/`. */
  srcSubdir: string;
  /** Dest subdir under `<cwd>/.{agent}/`. */
  destSubdir: string;
  /** True when entries are directories (skills); false when entries are files (md). */
  entriesAreDirs: boolean;
}

const CLAUDE_MIRROR_PLANS: MirrorPlan[] = [
  { srcSubdir: 'subagents', destSubdir: 'agents',   entriesAreDirs: false },
  { srcSubdir: 'commands',  destSubdir: 'commands', entriesAreDirs: false },
  { srcSubdir: 'skills',    destSubdir: 'skills',   entriesAreDirs: true },
];

function mirrorWorkspaceResources(cwd: string, agent: AgentId): { links: number; skipped: string[] } {
  const projectAgentsDir = getProjectAgentsDir(cwd);
  if (!projectAgentsDir) return { links: 0, skipped: [] };

  const agentConfig = AGENTS[agent];
  if (!agentConfig) return { links: 0, skipped: [] };

  const agentWorkspaceDir = path.join(cwd, path.basename(agentConfig.configDir));
  const projectAgentsResolved = (() => {
    try { return fs.realpathSync(projectAgentsDir); }
    catch { return path.resolve(projectAgentsDir); }
  })();

  let links = 0;
  const skipped: string[] = [];

  // Mirror subagents / commands / skills.
  for (const plan of CLAUDE_MIRROR_PLANS) {
    const srcDir = path.join(projectAgentsDir, plan.srcSubdir);
    if (!fs.existsSync(srcDir)) continue;

    const destDir = path.join(agentWorkspaceDir, plan.destSubdir);
    fs.mkdirSync(destDir, { recursive: true });

    const entries = fs.readdirSync(srcDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (plan.entriesAreDirs && !entry.isDirectory()) continue;
      if (!plan.entriesAreDirs && !entry.isFile() && !entry.isSymbolicLink()) continue;

      const srcPath = path.join(srcDir, entry.name);
      const destPath = path.join(destDir, entry.name);

      if (replaceWithSymlinkIfOwned(srcPath, destPath, projectAgentsResolved)) {
        links += 1;
      } else {
        skipped.push(path.relative(cwd, destPath));
      }
    }
  }

  // Mirror mcp.json → cwd/.mcp.json
  const srcMcp = path.join(projectAgentsDir, 'mcp.json');
  if (fs.existsSync(srcMcp)) {
    const destMcp = path.join(cwd, '.mcp.json');
    if (replaceWithSymlinkIfOwned(srcMcp, destMcp, projectAgentsResolved)) {
      links += 1;
    } else {
      skipped.push('.mcp.json');
    }
  }

  return { links, skipped };
}

/**
 * Create or refresh a symlink at `destPath` pointing at `srcPath`. Returns
 * true if we wrote the link, false if we skipped because the destination
 * exists and isn't a symlink into the project's `.agents/` tree.
 *
 * Skip-fast: if the destination is already a symlink resolving to the
 * project-agents tree AND its target matches srcPath, no write happens.
 */
function replaceWithSymlinkIfOwned(srcPath: string, destPath: string, projectAgentsResolved: string): boolean {
  let destLstat: fs.Stats | null = null;
  try { destLstat = fs.lstatSync(destPath); } catch { /* missing — write fresh */ }

  if (destLstat) {
    if (!destLstat.isSymbolicLink()) {
      return false;
    }
    let destTargetReal: string | null = null;
    try { destTargetReal = fs.realpathSync(destPath); } catch { /* dangling */ }
    if (destTargetReal && destTargetReal !== projectAgentsResolved && !destTargetReal.startsWith(projectAgentsResolved + path.sep)) {
      return false;
    }
    if (destTargetReal === fs.realpathSync(srcPath)) {
      return true; // already correct
    }
    try { fs.unlinkSync(destPath); } catch { /* ignore */ }
  }

  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.symlinkSync(srcPath, destPath);
  return true;
}

// ─── Step 3: scoped plugin marketplaces ───────────────────────────────────────

interface PluginScope {
  marketplaceName: string;
  pluginsDir: string;
}

function collectPluginScopes(cwd: string): PluginScope[] {
  const scopes: PluginScope[] = [];

  scopes.push({ marketplaceName: SYSTEM_MARKETPLACE_NAME, pluginsDir: getSystemPluginsDir() });
  scopes.push({ marketplaceName: MARKETPLACE_NAME,        pluginsDir: getPluginsDir() });

  for (const extra of getEnabledExtraRepos()) {
    scopes.push({ marketplaceName: extrasMarketplaceName(extra.alias), pluginsDir: getExtraPluginsDir(extra.alias) });
  }

  const projectPluginsDir = getProjectPluginsDir(cwd);
  if (projectPluginsDir) {
    scopes.push({ marketplaceName: PROJECT_MARKETPLACE_NAME, pluginsDir: projectPluginsDir });
  }

  return scopes;
}

function synthesizeScopedMarketplaces(agent: AgentId, version: string, cwd: string): Record<string, string[]> {
  const result: Record<string, string[]> = {};

  let versionHome: string;
  try {
    versionHome = getVersionHomePath(agent, version);
  } catch {
    return result;
  }
  if (!fs.existsSync(versionHome)) return result;

  for (const scope of collectPluginScopes(cwd)) {
    if (!fs.existsSync(scope.pluginsDir)) continue;
    const plugins = discoverPluginsInDir(scope.pluginsDir);
    if (plugins.length === 0) continue;

    const installed: string[] = [];
    for (const plugin of plugins) {
      try {
        copyPluginToMarketplace(plugin, agent, versionHome, scope.marketplaceName);
        installed.push(plugin.name);
      } catch {
        // Individual plugin copy failure — keep going on the others.
      }
    }
    if (installed.length === 0) continue;

    syncMarketplaceManifest(agent, versionHome, scope.marketplaceName);
    registerMarketplace(agent, versionHome, scope.marketplaceName);

    for (const name of installed) {
      enablePluginInSettings(name, agent, versionHome, {
        allowExecSurfaces: true,
        marketplaceName: scope.marketplaceName,
      });
    }

    result[scope.marketplaceName] = installed;
  }

  return result;
}
