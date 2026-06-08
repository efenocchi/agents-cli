/**
 * Native plugin marketplace install path for Claude / OpenClaw.
 *
 * Plugins managed by agents-cli are exposed as synthetic local marketplaces
 * grouped by source scope under each version's plugin directory:
 *
 *   <versionHome>/.{claude,openclaw}/plugins/
 *     known_marketplaces.json                    # registers each scoped marketplace
 *     marketplaces/agents-cli/                   # ~/.agents/plugins/* (user scope, legacy name)
 *     marketplaces/agents-system/                # ~/.agents/.system/plugins/*
 *     marketplaces/extras-<alias>/               # ~/.agents-<alias>/plugins/*
 *     marketplaces/agents-project/               # <cwd>/.agents/plugins/*
 *       .claude-plugin/marketplace.json          # synthesized catalog
 *       plugins/<plugin>/                        # copied plugin source
 *
 * Plus the version's settings.json gets
 *   `enabledPlugins["<plugin>@<marketplace>"] = true`.
 *
 * This produces native `/plugin:skill` slash namespacing, visibility in `/plugins`,
 * `/plugin enable|disable` support, AND honest attribution (the user can see
 * which scope each plugin came from) — matching the Claude Code spec at
 * https://code.claude.com/docs/en/plugins and /plugin-marketplaces.
 *
 * Backward compat: existing call sites that don't pass `marketplaceName` keep
 * writing to "agents-cli" (the legacy user-scope name). The launch-sync path
 * passes scope-specific names for the three new marketplaces.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { AgentId, DiscoveredPlugin, PluginManifest } from './types.js';

/**
 * Legacy name for the user-scope marketplace. Kept as the default so existing
 * installs (which have `marketplaces/agents-cli/` on disk and `<name>@agents-cli`
 * keys in settings.json) keep working without a migration.
 */
export const MARKETPLACE_NAME = 'agents-cli';

/** Marketplace name for ~/.agents/.system/plugins/*. */
export const SYSTEM_MARKETPLACE_NAME = 'agents-system';
/** Marketplace name for <cwd>/.agents/plugins/*. */
export const PROJECT_MARKETPLACE_NAME = 'agents-project';
/** Marketplace name for an extras repo aliased <alias> at ~/.agents-<alias>/plugins/*. */
export function extrasMarketplaceName(alias: string): string { return `extras-${alias}`; }

interface KnownMarketplaceEntry {
  source: { source: 'directory'; path: string };
  installLocation: string;
  lastUpdated: string;
}

interface MarketplacePluginEntry {
  name: string;
  source: string;
  description?: string;
  version?: string;
  author?: { name: string; email?: string };
}

interface MarketplaceManifest {
  $schema?: string;
  name: string;
  description?: string;
  owner: { name: string; email?: string };
  plugins: MarketplacePluginEntry[];
}

function pluginsRootForVersion(agent: AgentId, versionHome: string): string {
  return path.join(versionHome, `.${agent}`, 'plugins');
}

export function marketplaceRoot(agent: AgentId, versionHome: string, marketplaceName: string = MARKETPLACE_NAME): string {
  return path.join(pluginsRootForVersion(agent, versionHome), 'marketplaces', marketplaceName);
}

export function marketplaceManifestPath(agent: AgentId, versionHome: string, marketplaceName: string = MARKETPLACE_NAME): string {
  return path.join(marketplaceRoot(agent, versionHome, marketplaceName), '.claude-plugin', 'marketplace.json');
}

export function pluginInstallDir(plugin: DiscoveredPlugin, agent: AgentId, versionHome: string, marketplaceName: string = MARKETPLACE_NAME): string {
  return path.join(marketplaceRoot(agent, versionHome, marketplaceName), 'plugins', plugin.name);
}

export function knownMarketplacesPath(agent: AgentId, versionHome: string): string {
  return path.join(pluginsRootForVersion(agent, versionHome), 'known_marketplaces.json');
}

function settingsPath(agent: AgentId, versionHome: string): string {
  return path.join(versionHome, `.${agent}`, 'settings.json');
}

/**
 * Copy plugin source into marketplace install dir.
 * Source of truth remains the plugin's source dir — this is a per-version snapshot.
 *
 * Symlinks pointing OUTSIDE the plugin source root are dropped. They show up
 * when plugin authors (legitimately) link prompt-side references to sibling
 * codebases — e.g. the rush plugin's `app -> ../../../rush/app` for @app/...
 * autocomplete in user prompts. Faithfully copying those symlinks pollutes
 * the marketplace with gigabytes of node_modules / .next / brand-asset video
 * that the consumer (Claude Code, OpenClaw) then walks during plugin
 * discovery — which is the documented cause of multi-minute startup hangs.
 *
 * Internal symlinks (target stays inside the plugin root) are preserved.
 */
export function copyPluginToMarketplace(
  plugin: DiscoveredPlugin,
  agent: AgentId,
  versionHome: string,
  marketplaceName: string = MARKETPLACE_NAME
): string {
  const dest = pluginInstallDir(plugin, agent, versionHome, marketplaceName);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (fs.existsSync(dest)) {
    fs.rmSync(dest, { recursive: true, force: true });
  }

  const sourceRealRoot = (() => {
    try { return fs.realpathSync(plugin.root); }
    catch { return plugin.root; }
  })();
  const skipped: string[] = [];

  fs.cpSync(plugin.root, dest, {
    recursive: true,
    dereference: false,
    filter: (src) => {
      try {
        const stat = fs.lstatSync(src);
        if (!stat.isSymbolicLink()) return true;
        const target = fs.realpathSync(src);
        if (target === sourceRealRoot || target.startsWith(sourceRealRoot + path.sep)) {
          return true;
        }
        skipped.push(path.relative(plugin.root, src) || path.basename(src));
        return false;
      } catch {
        // Dangling symlink or stat failure — drop it; it can't be useful in
        // the marketplace and would error the consumer's walk anyway.
        skipped.push(path.relative(plugin.root, src) || path.basename(src));
        return false;
      }
    },
  });

  if (skipped.length > 0) {
    process.stderr.write(
      `agents-cli: plugin '${plugin.name}' has ${skipped.length} symlink(s) ` +
      `pointing outside its source root; not copied to marketplace ` +
      `(would bloat consumer startup): ${skipped.join(', ')}\n`
    );
  }

  return dest;
}

/**
 * Re-synthesize <marketplace>/.claude-plugin/marketplace.json from the list of
 * plugins installed under <marketplace>/plugins/. Always run after add or remove
 * so the manifest stays in lockstep with on-disk contents.
 */
export function syncMarketplaceManifest(agent: AgentId, versionHome: string, marketplaceName: string = MARKETPLACE_NAME): MarketplaceManifest | null {
  const root = marketplaceRoot(agent, versionHome, marketplaceName);
  const pluginsDir = path.join(root, 'plugins');
  if (!fs.existsSync(pluginsDir)) return null;

  const entries: MarketplacePluginEntry[] = [];
  for (const entry of fs.readdirSync(pluginsDir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    // Follow symlinks: Dirent.isDirectory() is false for a symlink even when the
    // target is a directory. statSync follows the link.
    const entryPath = path.join(pluginsDir, entry.name);
    let isDir = entry.isDirectory();
    if (!isDir && entry.isSymbolicLink()) {
      try { isDir = fs.statSync(entryPath).isDirectory(); } catch { isDir = false; }
    }
    if (!isDir) continue;

    const manifestFile = path.join(entryPath, '.claude-plugin', 'plugin.json');
    if (!fs.existsSync(manifestFile)) continue;

    let manifest: PluginManifest & { author?: { name: string; email?: string } };
    try {
      manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf-8'));
    } catch {
      continue;
    }

    entries.push({
      name: manifest.name,
      source: `./plugins/${manifest.name}`,
      description: manifest.description,
      version: manifest.version,
      ...(manifest.author ? { author: manifest.author } : {}),
    });
  }

  const manifest: MarketplaceManifest = {
    $schema: 'https://anthropic.com/claude-code/marketplace.schema.json',
    name: marketplaceName,
    description: descriptionForMarketplace(marketplaceName),
    owner: { name: 'agents-cli' },
    plugins: entries.sort((a, b) => a.name.localeCompare(b.name)),
  };

  const manifestPath = marketplaceManifestPath(agent, versionHome, marketplaceName);
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
  return manifest;
}

function descriptionForMarketplace(name: string): string {
  if (name === SYSTEM_MARKETPLACE_NAME) return 'System plugins shipped with agents-cli';
  if (name === PROJECT_MARKETPLACE_NAME) return 'Project-scoped plugins from <cwd>/.agents/plugins/';
  if (name.startsWith('extras-')) return `Plugins from extras repo "${name.slice('extras-'.length)}"`;
  return 'Plugins managed by agents-cli';
}

/**
 * Register a marketplace in known_marketplaces.json so Claude Code discovers
 * it on startup. Idempotent: re-running just refreshes lastUpdated.
 */
export function registerMarketplace(agent: AgentId, versionHome: string, marketplaceName: string = MARKETPLACE_NAME): void {
  const root = marketplaceRoot(agent, versionHome, marketplaceName);
  const knownPath = knownMarketplacesPath(agent, versionHome);

  let known: Record<string, KnownMarketplaceEntry> = {};
  if (fs.existsSync(knownPath)) {
    try {
      known = JSON.parse(fs.readFileSync(knownPath, 'utf-8'));
    } catch {
      known = {};
    }
  }

  known[marketplaceName] = {
    source: { source: 'directory', path: root },
    installLocation: root,
    lastUpdated: new Date().toISOString(),
  };

  fs.mkdirSync(path.dirname(knownPath), { recursive: true });
  fs.writeFileSync(knownPath, JSON.stringify(known, null, 2) + '\n', 'utf-8');
}

/**
 * Drop a marketplace entry from known_marketplaces.json.
 * Called when the last plugin under it is removed.
 */
export function unregisterMarketplace(agent: AgentId, versionHome: string, marketplaceName: string = MARKETPLACE_NAME): void {
  const knownPath = knownMarketplacesPath(agent, versionHome);
  if (!fs.existsSync(knownPath)) return;

  let known: Record<string, KnownMarketplaceEntry>;
  try {
    known = JSON.parse(fs.readFileSync(knownPath, 'utf-8'));
  } catch {
    return;
  }

  if (!(marketplaceName in known)) return;
  delete known[marketplaceName];

  if (Object.keys(known).length === 0) {
    try {
      fs.unlinkSync(knownPath);
    } catch { /* ignore */ }
  } else {
    fs.writeFileSync(knownPath, JSON.stringify(known, null, 2) + '\n', 'utf-8');
  }
}

/**
 * Mark a plugin as enabled in <versionHome>/.{agent}/settings.json under
 * enabledPlugins["<plugin>@<marketplace>"]: true. Reads, mutates, writes —
 * preserving every other key.
 */
export function enablePluginInSettings(
  pluginName: string,
  agent: AgentId,
  versionHome: string,
  options: { allowExecSurfaces?: boolean; marketplaceName?: string } = {}
): void {
  const marketplaceName = options.marketplaceName ?? MARKETPLACE_NAME;
  if (!options.allowExecSurfaces && marketplacePluginHasExecSurfaces(pluginName, agent, versionHome, marketplaceName)) {
    return;
  }

  const sPath = settingsPath(agent, versionHome);
  let settings: Record<string, unknown> = {};
  if (fs.existsSync(sPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(sPath, 'utf-8'));
    } catch {
      settings = {};
    }
  }

  if (!settings.enabledPlugins || typeof settings.enabledPlugins !== 'object') {
    settings.enabledPlugins = {};
  }
  const enabled = settings.enabledPlugins as Record<string, boolean>;
  const key = `${pluginName}@${marketplaceName}`;
  if (enabled[key] === true) return;
  enabled[key] = true;

  fs.mkdirSync(path.dirname(sPath), { recursive: true });
  fs.writeFileSync(sPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
}

function marketplacePluginHasExecSurfaces(pluginName: string, agent: AgentId, versionHome: string, marketplaceName: string = MARKETPLACE_NAME): boolean {
  const root = path.join(marketplaceRoot(agent, versionHome, marketplaceName), 'plugins', pluginName);
  if (fs.existsSync(path.join(root, '.mcp.json'))) return true;
  for (const dir of ['bin', 'scripts', 'permissions']) {
    if (fs.existsSync(path.join(root, dir))) return true;
  }
  const hooksFile = path.join(root, 'hooks', 'hooks.json');
  if (fs.existsSync(hooksFile)) return true;
  const hooksDir = path.join(root, 'hooks');
  if (fs.existsSync(hooksDir)) {
    try {
      if (fs.readdirSync(hooksDir).some((entry) => !entry.startsWith('.'))) return true;
    } catch {
      return true;
    }
  }
  const settingsFile = path.join(root, 'settings.json');
  if (!fs.existsSync(settingsFile)) return false;
  try {
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf-8')) as Record<string, unknown>;
    return Object.keys(settings).some((key) => key !== 'permissions') || 'permissions' in settings;
  } catch {
    return true;
  }
}

/**
 * Remove the enabledPlugins key for this plugin. Inverse of enablePluginInSettings.
 */
export function disablePluginInSettings(
  pluginName: string,
  agent: AgentId,
  versionHome: string,
  marketplaceName: string = MARKETPLACE_NAME
): void {
  const sPath = settingsPath(agent, versionHome);
  if (!fs.existsSync(sPath)) return;

  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(fs.readFileSync(sPath, 'utf-8'));
  } catch {
    return;
  }

  const enabled = settings.enabledPlugins as Record<string, boolean> | undefined;
  if (!enabled) return;

  const key = `${pluginName}@${marketplaceName}`;
  if (!(key in enabled)) return;
  delete enabled[key];

  if (Object.keys(enabled).length === 0) {
    delete settings.enabledPlugins;
  }

  fs.writeFileSync(sPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
}

/**
 * Remove a plugin's installed marketplace directory. Returns true if the dir
 * existed and was removed.
 */
export function removePluginFromMarketplace(
  pluginName: string,
  agent: AgentId,
  versionHome: string,
  marketplaceName: string = MARKETPLACE_NAME
): boolean {
  const installed = path.join(marketplaceRoot(agent, versionHome, marketplaceName), 'plugins', pluginName);
  if (!fs.existsSync(installed)) return false;
  fs.rmSync(installed, { recursive: true, force: true });
  return true;
}

/**
 * Return true if the marketplace has no plugins left under it.
 */
export function marketplaceIsEmpty(agent: AgentId, versionHome: string, marketplaceName: string = MARKETPLACE_NAME): boolean {
  const pluginsDir = path.join(marketplaceRoot(agent, versionHome, marketplaceName), 'plugins');
  if (!fs.existsSync(pluginsDir)) return true;
  const remaining = fs.readdirSync(pluginsDir, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith('.'));
  return remaining.length === 0;
}

/**
 * Drop the entire marketplace directory. Called after the last plugin removal.
 */
export function removeEmptyMarketplaceDir(agent: AgentId, versionHome: string, marketplaceName: string = MARKETPLACE_NAME): void {
  const root = marketplaceRoot(agent, versionHome, marketplaceName);
  if (!fs.existsSync(root)) return;
  fs.rmSync(root, { recursive: true, force: true });
}

/**
 * Detect whether a plugin is installed via the native marketplace path.
 */
export function isInstalledInMarketplace(
  pluginName: string,
  agent: AgentId,
  versionHome: string,
  marketplaceName: string = MARKETPLACE_NAME
): boolean {
  const installed = path.join(marketplaceRoot(agent, versionHome, marketplaceName), 'plugins', pluginName);
  return fs.existsSync(path.join(installed, '.claude-plugin', 'plugin.json'));
}
