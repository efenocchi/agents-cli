/**
 * `agents inspect <target>` — detail view for one agent+version or one DotAgents repo.
 *
 * Agent targets (`claude`, `claude@2.1.170`) show the per-version header (paths,
 * shim, capabilities, resource counts, sessions). Repo targets (`user`, `system`,
 * `project`, a registered extra-repo alias, or a filesystem path to a repo with a
 * `.agents/` dir or to a DotAgents root itself) show the repo root, git state, and
 * per-kind resource counts. Drill-down flags (`--skills`, `--hooks`, `--mcp`, ...)
 * list one resource kind for either target form; passing a positional query to the
 * same flag fuzzy-searches for a single resource and prints its detail. Resource
 * names render as OSC-8 hyperlinks to the marker file (SKILL.md / WORKFLOW.md /
 * AGENT.md / the file itself) so users can click straight to the source.
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Command } from 'commander';
import chalk from 'chalk';
import * as yaml from 'yaml';
import type { AgentId, CapabilityName, DiscoveredPlugin } from '../lib/types.js';
import { AGENTS, getCliState, resolveAgentName } from '../lib/agents.js';
import { supports } from '../lib/capabilities.js';
import {
  readMeta,
  getUserAgentsDir,
  getSystemAgentsDir,
  getProjectAgentsDir,
  getEnabledExtraRepos,
} from '../lib/state.js';
import { getVersionHomePath } from '../lib/versions.js';
import { getShimsDir, getVersionedAliasPath } from '../lib/shims.js';
import {
  getAgentResources,
  listResources,
  type ResourceEntry,
  type SkillResourceEntry,
} from '../lib/resources.js';
import { discoverPlugins, discoverPluginsInDir, pluginResourceGroups, type PluginResourceGroup } from '../lib/plugins.js';
import { PLUGIN_GROUP_COLORS } from './plugins.js';
import { countSessionsInScope } from '../lib/session/discover.js';
import type { SessionAgentId } from '../lib/session/types.js';
import { damerauLevenshtein } from '../lib/fuzzy.js';

/** Resource kinds the inspect command can drill into. */
const DRILLABLE_KINDS = [
  'commands',
  'skills',
  'hooks',
  'mcp',
  'rules',
  'plugins',
  'workflows',
  'subagents',
] as const;
type DrillableKind = typeof DRILLABLE_KINDS[number];

/**
 * Singular aliases for the plural drill-down flags. `--plugin code` reads as
 * "show the one plugin named code" — a required-value flag that always lands in
 * detail mode, the natural counterpart to `--plugins` (list). `mcp` has no
 * distinct singular, so it is intentionally absent.
 */
const SINGULAR_DRILL_ALIASES: Record<string, DrillableKind> = {
  command: 'commands',
  skill: 'skills',
  hook: 'hooks',
  rule: 'rules',
  plugin: 'plugins',
  workflow: 'workflows',
  subagent: 'subagents',
};

const CAPABILITY_NAMES: readonly CapabilityName[] = [
  'hooks', 'mcp', 'skills', 'commands', 'subagents', 'plugins', 'workflows', 'rules', 'allowlist',
];

interface ResourceItem {
  name: string;
  source: string;
  /** Absolute path to the resource entry (file or directory). */
  path: string;
  /** Path the OSC-8 link should point at — marker file inside bundles, else `path`. */
  linkTarget: string;
  /** One-line description (frontmatter `description:` or first non-frontmatter line). */
  description: string;
  /** Scalar detail rows surfaced in detail mode (e.g. a plugin's version). */
  extra?: Array<[string, string]>;
  /** For plugins: the resource categories (skills, commands, …) the bundle packages. */
  groups?: PluginResourceGroup[];
}

interface InspectOptions {
  brief?: boolean;
  json?: boolean;
  // Drill-down flags. commander treats `--skills [query]` so the value is
  // either undefined (flag absent), true (flag present, no query), or string.
  commands?: boolean | string;
  skills?: boolean | string;
  hooks?: boolean | string;
  mcp?: boolean | string;
  rules?: boolean | string;
  plugins?: boolean | string;
  workflows?: boolean | string;
  subagents?: boolean | string;
  // Singular aliases — required value, always detail mode (see SINGULAR_DRILL_ALIASES).
  command?: string;
  skill?: string;
  hook?: string;
  rule?: string;
  plugin?: string;
  workflow?: string;
  subagent?: string;
}

// ─── Command registration ────────────────────────────────────────────────────

export function registerInspectCommand(program: Command): void {
  const cmd = program
    .command('inspect <target>')
    .description('Inspect one installed agent at one version, or a DotAgents repo (user|system|project|alias|path) — paths, capabilities, resources, drill into any kind.')
    .option('--brief', 'header + capabilities only; skip resources/sessions')
    .option('--json', 'machine-readable JSON output');

  for (const kind of DRILLABLE_KINDS) {
    cmd.option(`--${kind} [query]`, `list ${kind}; pass a name (fuzzy) to show detail`);
  }
  for (const singular of Object.keys(SINGULAR_DRILL_ALIASES)) {
    cmd.option(`--${singular} <query>`, `show detail for one ${singular} by name (fuzzy)`);
  }

  cmd.action(async (target: string, options: InspectOptions) => {
    await inspectAction(target, options);
  });
}

// ─── Main dispatcher ─────────────────────────────────────────────────────────

export async function inspectAction(target: string, options: InspectOptions): Promise<void> {
  const agentKey = target.split('@')[0].toLowerCase();
  if (!(agentKey in AGENTS)) {
    const repo = resolveRepoTarget(target);
    if (repo) {
      await inspectRepo(repo, options);
      return;
    }
    // Repo targets take precedence over typo correction; only fall through to
    // parseTarget when the key resolves to an agent (alias or single-edit fix).
    if (!resolveAgentName(agentKey)) {
      const extras = getEnabledExtraRepos();
      console.error(chalk.red(`Unknown target: ${target}`));
      console.error(chalk.gray(`Agents: ${Object.keys(AGENTS).join(', ')}`));
      const aliases = extras.length > 0 ? `, ${extras.map(e => e.alias).join(', ')}` : '';
      console.error(chalk.gray(`Repos:  user, system, project${aliases} — or a path to a repo with a .agents/ dir`));
      process.exit(1);
    }
  }

  const { agent, version } = parseTarget(target);
  const versionHome = getVersionHomePath(agent, version);

  if (!fs.existsSync(versionHome)) {
    console.error(chalk.red(`${agent}@${version} is not installed.`));
    console.error(chalk.gray(`Run 'agents add ${agent}@${version}' first.`));
    process.exitCode = 1;
    return;
  }

  const drill = pickDrillKind(options);

  if (drill) {
    const { kind, query } = drill;
    if (query === true || query === undefined) {
      await renderList(agent, version, versionHome, kind, options);
    } else {
      await renderDetail(agent, version, versionHome, kind, String(query), options);
    }
    return;
  }

  await renderSummary(agent, version, versionHome, options);
}

function parseTarget(target: string): { agent: AgentId; version: string } {
  const [rawAgent, rawVersion] = target.split('@');
  const agent = resolveAgentName(rawAgent || '');
  if (!agent) {
    console.error(chalk.red(`Unknown agent: ${rawAgent}`));
    console.error(chalk.gray(`Known agents: ${Object.keys(AGENTS).join(', ')}`));
    process.exit(1);
  }

  let version = rawVersion;
  if (!version || version === 'default') {
    const meta = readMeta();
    const def = meta.agents?.[agent];
    if (!def) {
      console.error(chalk.red(`No default version set for ${agent}.`));
      console.error(chalk.gray(`Pass a version: agents inspect ${agent}@<version>`));
      process.exit(1);
    }
    version = def;
  }
  return { agent, version };
}

function pickDrillKind(options: InspectOptions): { kind: DrillableKind; query: boolean | string } | null {
  const active: Array<{ flag: string; kind: DrillableKind; query: boolean | string }> = [];
  for (const kind of DRILLABLE_KINDS) {
    const value = options[kind];
    if (value !== undefined) active.push({ flag: `--${kind}`, kind, query: value });
  }
  // Singular aliases (`--plugin code`) always carry a name → detail mode.
  for (const [singular, plural] of Object.entries(SINGULAR_DRILL_ALIASES)) {
    const value = (options as Record<string, unknown>)[singular];
    if (typeof value === 'string') active.push({ flag: `--${singular}`, kind: plural, query: value });
  }
  if (active.length === 0) return null;
  if (active.length > 1) {
    console.error(chalk.red(`Pick at most one drill-down flag. Got: ${active.map(a => a.flag).join(', ')}`));
    process.exit(1);
  }
  return { kind: active[0].kind, query: active[0].query };
}

// ─── Repo targets ────────────────────────────────────────────────────────────

export interface RepoTarget {
  /** Display label: 'user' | 'system' | 'project', an extra-repo alias, or a path-derived name. */
  label: string;
  /** Absolute path to the DotAgents root (the dir holding commands/, skills/, ...). */
  root: string;
}

/** Files at a DotAgents root that mark it as one, beyond the per-kind dirs. */
const REPO_MARKER_FILES = ['agents.yaml', 'hooks.yaml'];

/**
 * Resolve a non-agent target as a DotAgents repo: the built-in layer names,
 * a registered extra-repo alias, or a filesystem path. Paths accept either a
 * DotAgents root itself or a repo whose `.agents/` dir should be inspected.
 * Returns null when the target is none of these.
 */
export function resolveRepoTarget(target: string, cwd?: string): RepoTarget | null {
  if (target === 'user') return { label: 'user', root: getUserAgentsDir() };
  if (target === 'system') return { label: 'system', root: getSystemAgentsDir() };
  if (target === 'project') {
    const dir = getProjectAgentsDir(cwd);
    if (!dir) {
      console.error(chalk.red('No project .agents/ directory found from the current directory.'));
      process.exit(1);
    }
    return { label: 'project', root: dir };
  }

  for (const extra of getEnabledExtraRepos()) {
    if (extra.alias === target) return { label: extra.alias, root: extra.dir };
  }

  const expanded = target.startsWith('~/') ? path.join(os.homedir(), target.slice(2)) : target;
  const abs = path.resolve(cwd ?? process.cwd(), expanded);
  const stat = safeStat(abs);
  if (!stat || !stat.isDirectory()) return null;

  // A dir literally named `.agents` is the root itself.
  if (path.basename(abs) === '.agents') {
    return { label: path.basename(path.dirname(abs)), root: abs };
  }
  // A nested `.agents/` that is a populated DotAgents root wins over `abs` — the
  // project case (`agents inspect .` from a repo root whose resources live under
  // `.agents/`, while the repo's own top-level `skills/`, `agents.yaml` pin, etc.
  // are unrelated source, not a DotAgents tree).
  const nested = path.join(abs, '.agents');
  if (isDotAgentsRoot(nested)) {
    return { label: path.basename(abs), root: nested };
  }
  // Otherwise treat `abs` itself as the root: standalone clones and extra repos
  // like ~/.agents-extras keep resources at the top level and use `.agents/`
  // only for worktrees (so their nested `.agents/` is not a DotAgents root).
  if (isDotAgentsRoot(abs)) {
    return { label: path.basename(abs), root: abs };
  }
  return null;
}

function isDotAgentsRoot(dir: string): boolean {
  for (const marker of REPO_MARKER_FILES) {
    if (fs.existsSync(path.join(dir, marker))) return true;
  }
  for (const kind of DRILLABLE_KINDS) {
    if (safeStat(path.join(dir, kind))?.isDirectory()) return true;
  }
  return false;
}

async function inspectRepo(repo: RepoTarget, options: InspectOptions): Promise<void> {
  const drill = pickDrillKind(options);
  const jsonHead = { repo: repo.label, root: repo.root };

  if (drill) {
    const items = collectRepoKind(repo, drill.kind);
    if (drill.query === true || drill.query === undefined) {
      renderItemList(repo.label, jsonHead, drill.kind, items, options);
    } else {
      renderItemDetail(repo.label, jsonHead, drill.kind, String(drill.query), items, options);
    }
    return;
  }

  renderRepoSummary(repo, options);
}

/** List one resource kind from a single repo root — no layering, no overrides. */
export function collectRepoKind(repo: RepoTarget, kind: DrillableKind): ResourceItem[] {
  // Plugins are bundles with a manifest + nested skills/commands/hooks — read
  // them through the plugin discoverer so the manifest description and bundled
  // resources surface, rather than treating each as an opaque directory.
  if (kind === 'plugins') {
    return discoverPluginsInDir(path.join(repo.root, 'plugins'))
      .map(p => pluginToItem(p, repo.label))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  const dir = path.join(repo.root, kind);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch { return []; }

  const items: ResourceItem[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    // Build/tooling caches are never resources — they only inflate counts.
    if (entry.name === '__pycache__' || entry.name === 'node_modules') continue;
    const p = path.join(dir, entry.name);
    items.push({
      name: entry.name.replace(/\.(md|yaml|yml|toml|json)$/, ''),
      source: repo.label,
      path: p,
      linkTarget: linkTarget(p),
      description: readDescription(p),
    });
  }
  return items.sort((a, b) => a.name.localeCompare(b.name));
}

/** A few resource names for the at-a-glance preview, with a `…(+N)` tail. */
function previewNames(items: ResourceItem[], n: number): string {
  if (items.length === 0) return '';
  const shown = items.slice(0, n).map(i => i.name);
  const extra = items.length - shown.length;
  return shown.join(', ') + (extra > 0 ? ` …(+${extra})` : '');
}

/** Recursive size + file count of a path; symlinks are not followed. */
export function pathSize(p: string): { bytes: number; files: number } {
  let stat: fs.Stats;
  try { stat = fs.lstatSync(p); } catch { return { bytes: 0, files: 0 }; }
  if (stat.isSymbolicLink()) return { bytes: 0, files: 0 };
  if (stat.isFile()) return { bytes: stat.size, files: 1 };
  if (!stat.isDirectory()) return { bytes: 0, files: 0 };
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(p, { withFileTypes: true }); } catch { return { bytes: 0, files: 0 }; }
  let bytes = 0, files = 0;
  for (const e of entries) {
    const sub = pathSize(path.join(p, e.name));
    bytes += sub.bytes; files += sub.files;
  }
  return { bytes, files };
}

/** Human byte size: "84 KB", "3.1 MB". */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 10 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export interface ManifestSummary {
  /** `run.<agent>.strategy` pairs from agents.yaml. */
  strategies: Array<{ agent: string; strategy: string }>;
  /** `agents.<agent>` version pins from agents.yaml, when present. */
  versions: Array<{ agent: string; version: string }>;
}

/** Parse the repo's own agents.yaml into the version pins + run strategies it declares. */
export function repoManifestSummary(root: string): ManifestSummary | null {
  let parsed: unknown;
  try {
    parsed = yaml.parse(fs.readFileSync(path.join(root, 'agents.yaml'), 'utf-8'));
  } catch { return null; }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;

  const strategies: ManifestSummary['strategies'] = [];
  if (obj.run && typeof obj.run === 'object') {
    for (const [agent, cfg] of Object.entries(obj.run as Record<string, unknown>)) {
      const strategy = cfg && typeof cfg === 'object' ? (cfg as Record<string, unknown>).strategy : undefined;
      if (typeof strategy === 'string') strategies.push({ agent, strategy });
    }
  }

  const versions: ManifestSummary['versions'] = [];
  if (obj.agents && typeof obj.agents === 'object') {
    for (const [agent, ver] of Object.entries(obj.agents as Record<string, unknown>)) {
      if (typeof ver === 'string') versions.push({ agent, version: ver });
    }
  }

  if (strategies.length === 0 && versions.length === 0) return null;
  return { strategies, versions };
}

function renderRepoSummary(repo: RepoTarget, options: InspectOptions): void {
  const git = repoGitInfo(repo.root);
  const manifests = REPO_MARKER_FILES.filter(m => fs.existsSync(path.join(repo.root, m)));
  const manifest = repoManifestSummary(repo.root);

  const kindData = {} as Record<DrillableKind, { items: ResourceItem[]; size: { bytes: number; files: number } }>;
  let totalBytes = 0, totalFiles = 0;
  if (!options.brief) {
    for (const kind of DRILLABLE_KINDS) {
      const items = collectRepoKind(repo, kind);
      const size = pathSize(path.join(repo.root, kind));
      kindData[kind] = { items, size };
      totalBytes += size.bytes; totalFiles += size.files;
    }
  }

  if (options.json) {
    console.log(JSON.stringify({
      repo: repo.label,
      root: repo.root,
      git,
      manifests,
      manifest,
      size: options.brief ? null : { bytes: totalBytes, files: totalFiles },
      resources: options.brief ? null : Object.fromEntries(
        DRILLABLE_KINDS.map(kind => [kind, {
          count: kindData[kind].items.length,
          bytes: kindData[kind].size.bytes,
          files: kindData[kind].size.files,
          names: kindData[kind].items.map(i => i.name),
        }]),
      ),
    }, null, 2));
    return;
  }

  console.log('\n' + chalk.bold(repo.label) + '  ' + chalk.gray('[dotagents repo]') + '\n');

  // Indent for continuation sub-rows: 2 leading + 10 key column + 1 space.
  const sub = (label: string, value: string) => console.log(`  ${''.padEnd(10)} ${chalk.gray(label.padEnd(8))} ${value}`);

  console.log(`  ${'root'.padEnd(10)} ${termLink(repo.root, repo.root)}`);

  if (git) {
    const dirty = git.dirty > 0 ? ` ${chalk.gray('·')} ${chalk.yellow(`${git.dirty} dirty`)}` : '';
    const url = git.url ? ` ${chalk.gray('·')} ${chalk.gray(git.url)}` : '';
    console.log(`  ${'git'.padEnd(10)} ${git.branch}${dirty}${url}`);
    if (git.lastCommit) {
      const rel = git.lastCommit.relative ? `  ${chalk.gray(`(${git.lastCommit.relative})`)}` : '';
      sub('last', `${chalk.cyan(git.lastCommit.sha)}  ${truncate(git.lastCommit.subject, 60)}${rel}`);
    }
    if (git.ahead !== null && git.behind !== null && (git.ahead > 0 || git.behind > 0)) {
      sub('sync', `ahead ${git.ahead} ${chalk.gray('·')} behind ${git.behind}`);
    }
    if (git.dirtyFiles.length > 0) {
      const shown = git.dirtyFiles.slice(0, 4).join(', ');
      const extra = git.dirtyFiles.length - Math.min(4, git.dirtyFiles.length);
      sub('dirty', chalk.yellow(shown + (extra > 0 ? ` …(+${extra})` : '')));
    }
  }

  if (manifests.length > 0) {
    console.log(`  ${'manifests'.padEnd(10)} ${manifests.join(', ')}`);
    if (manifest) {
      if (manifest.versions.length > 0) {
        sub('versions', manifest.versions.map(v => `${v.agent} ${chalk.cyan(v.version)}`).join(chalk.gray(' · ')));
      }
      if (manifest.strategies.length > 0) {
        sub('run', manifest.strategies.map(s => `${s.agent}:${s.strategy}`).join(chalk.gray(' · ')));
      }
    }
  }

  if (!options.brief) {
    console.log(`  ${'size'.padEnd(10)} ${formatBytes(totalBytes)} ${chalk.gray('·')} ${totalFiles} files`);

    console.log('\n' + chalk.bold('Resources'));
    for (const kind of DRILLABLE_KINDS) {
      const { items, size } = kindData[kind];
      const count = String(items.length).padStart(4);
      const sz = items.length > 0 ? formatBytes(size.bytes).padStart(8) : ''.padEnd(8);
      const preview = items.length > 0 ? chalk.gray(truncate(previewNames(items, 4), 60)) : '';
      console.log(`  ${kind.padEnd(10)} ${count}  ${sz}  ${preview}`.trimEnd());
    }
  }

  console.log('');
  console.log(chalk.gray(`Drill in:   agents inspect ${repo.label} --skills <query>`));
  console.log('');
}

export interface RepoGitInfo {
  branch: string;
  dirty: number;
  dirtyFiles: string[];
  url: string | null;
  lastCommit: { sha: string; subject: string; relative: string } | null;
  ahead: number | null;
  behind: number | null;
}

export function repoGitInfo(root: string): RepoGitInfo | null {
  const git = (args: string): string | null => {
    try {
      return execSync(`git -C ${JSON.stringify(root)} ${args}`, { stdio: ['ignore', 'pipe', 'ignore'] })
        .toString().trim();
    } catch { return null; }
  };
  const branch = git('rev-parse --abbrev-ref HEAD');
  if (branch === null) return null;

  // Read status WITHOUT trimming — git()'s .trim() would strip the leading
  // space of the first porcelain line (`XY path`), corrupting the path slice.
  let statusRaw: string | null;
  try {
    statusRaw = execSync(`git -C ${JSON.stringify(root)} status --porcelain`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
  } catch { statusRaw = null; }
  const dirtyFiles = statusRaw ? statusRaw.split('\n').filter(Boolean).map(l => l.slice(3)) : [];

  let lastCommit: RepoGitInfo['lastCommit'] = null;
  const log = git('log -1 --format=%h%x1f%s%x1f%cr');
  if (log) {
    const [sha, subject, relative] = log.split('\x1f');
    if (sha) lastCommit = { sha, subject: subject ?? '', relative: relative ?? '' };
  }

  let ahead: number | null = null, behind: number | null = null;
  const counts = git("rev-list --left-right --count '@{upstream}...HEAD'");
  if (counts) {
    const [b, a] = counts.split(/\s+/).map(n => parseInt(n, 10));
    if (Number.isFinite(b) && Number.isFinite(a)) { behind = b; ahead = a; }
  }

  return { branch, dirty: dirtyFiles.length, dirtyFiles, url: git('remote get-url origin'), lastCommit, ahead, behind };
}

// ─── Summary mode ────────────────────────────────────────────────────────────

async function renderSummary(agent: AgentId, version: string, versionHome: string, options: InspectOptions): Promise<void> {
  const meta = readMeta();
  const isDefault = meta.agents?.[agent] === version;
  const strategy = meta.run?.[agent]?.strategy ?? 'pinned';
  const cliState = await getCliState(agent).catch(() => null);

  const configSymlink = path.join(os.homedir(), `.${agent}`);
  const configTarget = readSymlinkSafe(configSymlink);

  const shimPath = path.join(getShimsDir(), AGENTS[agent].cliCommand);
  const aliasPath = getVersionedAliasPath(agent, version);

  const capabilities = collectCapabilities(agent, version);

  const counts = options.brief ? null : collectCounts(agent, versionHome);

  const sessions = options.brief ? null : {
    total: safeCountSessions(agent),
  };

  if (options.json) {
    const json = {
      agent,
      version,
      default: isDefault,
      home: versionHome,
      configSymlink: configTarget ? { from: configSymlink, to: configTarget } : null,
      shim: shimPath,
      alias: aliasPath,
      strategy,
      installedShim: cliState?.installed === true ? cliState.path : null,
      capabilities,
      resources: counts,
      sessions,
    };
    console.log(JSON.stringify(json, null, 2));
    return;
  }

  // Plain text
  const head = `${chalk.bold(agent)} ${chalk.gray('@')} ${chalk.cyan(version)}${isDefault ? '  ' + chalk.green('[default]') : ''}`;
  console.log('\n' + head + '\n');

  const rows: Array<[string, string]> = [
    ['install', versionHome],
    ['config', configTarget ? `${configSymlink}  ${chalk.gray('→')}  ${configTarget}` : chalk.gray('(no symlink)')],
    ['shim', shimPath],
    ['alias', aliasPath],
    ['strategy', strategy],
  ];
  for (const [k, v] of rows) console.log(`  ${k.padEnd(10)} ${v}`);

  console.log('\n' + chalk.bold('Capabilities'));
  for (const cap of CAPABILITY_NAMES) {
    const res = capabilities[cap];
    const mark = res.ok ? chalk.green('✓') : chalk.red('✗');
    const reason = res.ok ? '' : chalk.gray(`(${res.reason}${res.need ? ' ' + res.need : ''})`);
    console.log(`  ${cap.padEnd(10)} ${mark} ${reason}`);
  }

  if (counts) {
    console.log('\n' + chalk.bold('Resources'));
    for (const kind of DRILLABLE_KINDS) {
      const c = counts[kind];
      if (!c) continue;
      const breakdown = formatScopeBreakdown(c.bySource);
      console.log(`  ${kind.padEnd(10)} ${String(c.total).padStart(4)}   ${chalk.gray(breakdown)}`);
    }
  }

  if (sessions) {
    console.log('\n' + chalk.bold('Sessions'));
    console.log(`  ${'total'.padEnd(10)} ${sessions.total}   ${chalk.gray('(across all versions)')}`);
  }

  console.log('');
  console.log(chalk.gray(`Drill in:   agents inspect ${agent}@${version} --skills <query>`));
  console.log(chalk.gray(`Diagnose:   agents doctor ${agent}@${version}`));
  console.log('');
}

// ─── List mode ───────────────────────────────────────────────────────────────

async function renderList(agent: AgentId, version: string, versionHome: string, kind: DrillableKind, options: InspectOptions): Promise<void> {
  const items = collectKind(agent, versionHome, kind);
  renderItemList(`${agent}@${version}`, { agent, version }, kind, items, options);
}

function renderItemList(header: string, jsonHead: Record<string, unknown>, kind: DrillableKind, items: ResourceItem[], options: InspectOptions): void {
  if (options.json) {
    console.log(JSON.stringify({
      ...jsonHead,
      kind,
      count: items.length,
      items: items.map(i => ({ name: i.name, source: i.source, path: i.path, description: i.description, ...(i.groups ? { groups: i.groups } : {}) })),
    }, null, 2));
    return;
  }

  console.log('\n' + chalk.bold(header) + '  ' + chalk.gray(`${kind} (${items.length})`) + '\n');

  if (items.length === 0) {
    console.log(chalk.gray(`  (none installed)`));
    console.log('');
    return;
  }

  for (const item of items) {
    const tag = chalk.gray(`[${item.source}]`.padEnd(10));
    console.log(`  ${tag} ${termLink(chalk.cyan(item.name), item.linkTarget)}`);
    if (item.description) {
      console.log(`             ${chalk.gray(truncate(item.description, 90))}`);
    }
    if (item.groups) printGroupRows(item.groups);
  }
  console.log('');
}

/** Print a plugin's resource breakdown as aligned `label  items` rows under a list entry. */
function printGroupRows(groups: PluginResourceGroup[]): void {
  if (groups.length === 0) return;
  const width = Math.max(...groups.map(g => g.label.length));
  for (const g of groups) {
    const colorFn = PLUGIN_GROUP_COLORS[g.label] ?? chalk.white;
    const label = chalk.gray(g.label.padEnd(width));
    const value = g.items.map((s) => colorFn(s)).join(chalk.gray(', '));
    console.log(`             ${label}  ${value}`);
  }
}

// ─── Detail mode (fuzzy) ─────────────────────────────────────────────────────

async function renderDetail(agent: AgentId, version: string, versionHome: string, kind: DrillableKind, query: string, options: InspectOptions): Promise<void> {
  const items = collectKind(agent, versionHome, kind);
  renderItemDetail(`${agent}@${version}`, { agent, version }, kind, query, items, options);
}

function renderItemDetail(header: string, jsonHead: Record<string, unknown>, kind: DrillableKind, query: string, items: ResourceItem[], options: InspectOptions): void {
  const matches = findMatches(items, query);

  if (matches.length === 0) {
    const suggestions = suggestClosest(items, query, 3);
    if (options.json) {
      console.log(JSON.stringify({ ...jsonHead, kind, query, match: null, suggestions: suggestions.map(s => s.name) }, null, 2));
    } else {
      console.error(chalk.red(`No ${kind} matching '${query}'.`));
      if (suggestions.length > 0) {
        console.error(chalk.gray(`Closest: ${suggestions.map(s => s.name).join(', ')}`));
      }
    }
    process.exit(1);
  }

  const best = matches[0];
  const others = matches.slice(1, 4);

  if (options.json) {
    const detail = buildDetail(best.item, kind);
    console.log(JSON.stringify({
      ...jsonHead,
      kind,
      query,
      match: { ...detail, matchKind: best.matchKind },
      others: others.map(o => ({ name: o.item.name, source: o.item.source, path: o.item.path, matchKind: o.matchKind })),
    }, null, 2));
    return;
  }

  console.log('\n' + chalk.bold(header) + '  ' + chalk.gray(`${kind} matching "${query}"`) + '\n');
  const matchTag = best.matchKind === 'exact' ? 'exact' : best.matchKind === 'substring' ? 'substring' : `~${best.distance}`;
  console.log(`  ${chalk.green('✓')}  ${termLink(chalk.bold.cyan(best.item.name), best.item.linkTarget)}  ${chalk.gray(`[${matchTag}, ${best.item.source}]`)}`);
  if (best.item.description) {
    console.log(`     ${chalk.gray(truncate(best.item.description, 100))}`);
  }
  for (const [k, v] of buildDetailRows(best.item, kind)) {
    console.log(`     ${chalk.gray(k.padEnd(10))} ${v}`);
  }

  if (others.length > 0) {
    console.log('\n' + chalk.gray('Other matches:'));
    for (const m of others) {
      const tag = m.matchKind === 'substring' ? 'substring' : `~${m.distance}`;
      console.log(`  ${termLink(chalk.cyan(m.item.name), m.item.linkTarget)}  ${chalk.gray(`(${tag}) [${m.item.source}]`)}`);
    }
  }
  console.log('');
}

// ─── Data collection ─────────────────────────────────────────────────────────

function collectCapabilities(agent: AgentId, version: string): Record<CapabilityName, { ok: boolean; reason?: string; need?: string }> {
  const out = {} as Record<CapabilityName, { ok: boolean; reason?: string; need?: string }>;
  for (const cap of CAPABILITY_NAMES) {
    const res = supports(agent, cap, version);
    if (res.ok) {
      out[cap] = { ok: true };
    } else {
      out[cap] = { ok: false, reason: res.reason, need: res.need };
    }
  }
  return out;
}

function collectCounts(agent: AgentId, versionHome: string): Record<DrillableKind, { total: number; bySource: Record<string, number> }> {
  const out = {} as Record<DrillableKind, { total: number; bySource: Record<string, number> }>;
  for (const kind of DRILLABLE_KINDS) {
    const items = collectKind(agent, versionHome, kind);
    const bySource: Record<string, number> = {};
    for (const item of items) bySource[item.source] = (bySource[item.source] || 0) + 1;
    out[kind] = { total: items.length, bySource };
  }
  return out;
}

function collectKind(agent: AgentId, versionHome: string, kind: DrillableKind): ResourceItem[] {
  switch (kind) {
    case 'commands':
    case 'hooks':
    case 'workflows':
      return entriesFromAgentResources(agent, versionHome, kind);
    case 'skills':
      return skillsFromAgentResources(agent, versionHome);
    case 'mcp':
      return mcpItems(agent, versionHome);
    case 'rules':
    case 'subagents':
      return listResources(kind).map(r => ({
        name: r.name,
        source: r.source,
        path: r.path,
        linkTarget: linkTarget(r.path),
        description: readDescription(r.path),
      }));
    case 'plugins':
      return pluginItems();
  }
}

function pluginItems(): ResourceItem[] {
  return discoverPlugins().map(p => pluginToItem(p, 'user'));
}

/**
 * Map a discovered plugin to a resource item, surfacing the manifest description
 * and the bundle's nested resources (skills, commands, hooks, ...) as detail rows.
 */
function pluginToItem(plugin: DiscoveredPlugin, source: string): ResourceItem {
  const extra: Array<[string, string]> = [];
  if (plugin.manifest.version) extra.push(['version', plugin.manifest.version]);
  return {
    name: plugin.name,
    source,
    path: plugin.root,
    linkTarget: linkTarget(plugin.root),
    description: plugin.manifest.description ?? '',
    extra,
    groups: pluginResourceGroups(plugin),
  };
}

function entriesFromAgentResources(agent: AgentId, versionHome: string, kind: 'commands' | 'hooks' | 'workflows'): ResourceItem[] {
  const res = getAgentResources(agent, { home: versionHome });
  const list = res[kind] as ResourceEntry[];
  return list.map(e => ({
    name: e.name,
    source: e.scope,
    path: e.path,
    linkTarget: linkTarget(e.path),
    description: readDescription(e.path),
  }));
}

function skillsFromAgentResources(agent: AgentId, versionHome: string): ResourceItem[] {
  const res = getAgentResources(agent, { home: versionHome });
  return (res.skills as SkillResourceEntry[]).map(s => ({
    name: s.name,
    source: s.scope,
    path: s.path,
    linkTarget: linkTarget(s.path),
    description: readDescription(s.path),
  }));
}

function mcpItems(agent: AgentId, versionHome: string): ResourceItem[] {
  const res = getAgentResources(agent, { home: versionHome });
  return res.mcp.map(m => ({
    name: m.name,
    source: m.scope,
    path: '',
    linkTarget: '',
    description: m.version ? `version ${m.version}` : '',
  }));
}

// ─── Detail field builders ───────────────────────────────────────────────────

function buildDetail(item: ResourceItem, kind: DrillableKind): Record<string, unknown> {
  const rows = buildDetailRows(item, kind);
  const out: Record<string, unknown> = {
    name: item.name,
    source: item.source,
    path: item.path,
    description: item.description,
  };
  for (const [k, v] of rows) out[k] = v;
  return out;
}

function buildDetailRows(item: ResourceItem, kind: DrillableKind): Array<[string, string]> {
  const rows: Array<[string, string]> = [];
  if (item.path && kind !== 'mcp') {
    const stat = safeStat(item.path);
    if (stat) rows.push(['size', stat.isDirectory() ? '(bundle)' : `${stat.size} bytes`]);
  }
  // Kind-specific fields
  if (kind === 'skills' || kind === 'commands' || kind === 'subagents') {
    const fm = readFrontmatter(item.path);
    if (fm) {
      // description was already printed by caller; skip if redundant
      if (typeof fm.description === 'string' && fm.description.trim() !== item.description.trim()) {
        rows.push(['description', truncate(fm.description, 120)]);
      }
      if (Array.isArray(fm.triggers)) rows.push(['triggers', fm.triggers.join(', ')]);
      if (typeof fm.model === 'string') rows.push(['model', fm.model]);
      if (Array.isArray(fm.tools)) rows.push(['tools', fm.tools.join(', ')]);
    }
  }
  // Plugin bundles surface their nested resources (skills, commands, …) plus
  // scalar rows (version).
  if (kind === 'plugins') {
    if (item.groups) for (const g of item.groups) rows.push([g.label, g.items.join(', ')]);
    if (item.extra) rows.push(...item.extra);
  }
  return rows;
}

// ─── Fuzzy matching ──────────────────────────────────────────────────────────

interface ScoredMatch {
  item: ResourceItem;
  matchKind: 'exact' | 'substring' | 'fuzzy';
  distance: number;
}

function findMatches(items: ResourceItem[], query: string): ScoredMatch[] {
  const q = query.toLowerCase();
  const out: ScoredMatch[] = [];

  for (const item of items) {
    const name = item.name.toLowerCase();
    if (name === q) {
      out.push({ item, matchKind: 'exact', distance: 0 });
    } else if (name.includes(q)) {
      out.push({ item, matchKind: 'substring', distance: name.length - q.length });
    }
  }

  if (out.length > 0) {
    out.sort((a, b) => rankMatch(a) - rankMatch(b));
    return out;
  }

  // No substring hits — fall back to edit distance.
  const threshold = Math.max(2, Math.floor(q.length * 0.3));
  for (const item of items) {
    const d = damerauLevenshtein(q, item.name.toLowerCase());
    if (d <= threshold) out.push({ item, matchKind: 'fuzzy', distance: d });
  }
  out.sort((a, b) => a.distance - b.distance);
  return out;
}

function rankMatch(m: ScoredMatch): number {
  if (m.matchKind === 'exact') return 0;
  if (m.matchKind === 'substring') return 100 + m.distance;
  return 1000 + m.distance;
}

function suggestClosest(items: ResourceItem[], query: string, n: number): ResourceItem[] {
  const q = query.toLowerCase();
  const scored = items.map(item => ({ item, d: damerauLevenshtein(q, item.name.toLowerCase()) }));
  scored.sort((a, b) => a.d - b.d);
  return scored.slice(0, n).map(s => s.item);
}

// ─── Frontmatter + description helpers ───────────────────────────────────────

function readDescription(p: string): string {
  if (!p) return '';
  let filePath = p;
  try {
    if (fs.statSync(p).isDirectory()) {
      for (const marker of ['SKILL.md', 'WORKFLOW.md', 'AGENT.md', 'README.md']) {
        const c = path.join(p, marker);
        if (fs.existsSync(c)) { filePath = c; break; }
      }
    }
  } catch { return ''; }

  const fm = readFrontmatter(filePath);
  if (fm && typeof fm.description === 'string' && fm.description.trim().length > 0) {
    return fm.description.trim();
  }
  return readFirstProseLine(filePath);
}

function readFrontmatter(p: string): Record<string, unknown> | null {
  if (!p) return null;
  let filePath = p;
  try {
    if (fs.statSync(p).isDirectory()) {
      for (const marker of ['SKILL.md', 'WORKFLOW.md', 'AGENT.md']) {
        const c = path.join(p, marker);
        if (fs.existsSync(c)) { filePath = c; break; }
      }
    }
  } catch { return null; }

  if (!filePath.endsWith('.md')) return null;
  let head = '';
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(4096);
    const n = fs.readSync(fd, buf, 0, 4096, 0);
    fs.closeSync(fd);
    head = buf.subarray(0, n).toString('utf-8');
  } catch { return null; }

  if (!head.startsWith('---')) return null;
  const end = head.indexOf('\n---', 3);
  if (end === -1) return null;
  const body = head.slice(3, end).trim();
  try {
    const parsed = yaml.parse(body);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}

function readFirstProseLine(p: string): string {
  try {
    const stat = fs.statSync(p);
    if (stat.isDirectory()) return '';
    if (stat.size > 64 * 1024) return '';
    const text = fs.readFileSync(p, 'utf-8');
    // Skip frontmatter
    let body = text;
    if (body.startsWith('---')) {
      const end = body.indexOf('\n---', 3);
      if (end !== -1) body = body.slice(end + 4);
    }
    for (const raw of body.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith('#')) return line.replace(/^#+\s*/, '');
      return line;
    }
  } catch { /* ignore */ }
  return '';
}

// ─── OSC-8 + path helpers ────────────────────────────────────────────────────

function termLink(text: string, filePath: string): string {
  if (!filePath) return text;
  const url = `file://${filePath}`;
  return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}

function linkTarget(p: string): string {
  if (!p) return '';
  try {
    if (!fs.statSync(p).isDirectory()) return p;
  } catch { return p; }
  for (const marker of ['SKILL.md', 'WORKFLOW.md', 'AGENT.md']) {
    const c = path.join(p, marker);
    if (fs.existsSync(c)) return c;
  }
  return p;
}

function readSymlinkSafe(p: string): string | null {
  try {
    const stat = fs.lstatSync(p);
    if (!stat.isSymbolicLink()) return null;
    return fs.readlinkSync(p);
  } catch { return null; }
}

function safeStat(p: string): fs.Stats | null {
  try { return fs.statSync(p); } catch { return null; }
}

const SESSION_AGENTS: ReadonlySet<string> = new Set([
  'claude', 'codex', 'gemini', 'opencode', 'openclaw', 'rush', 'hermes', 'grok', 'kimi',
]);

function safeCountSessions(agent: AgentId): number {
  if (!SESSION_AGENTS.has(agent)) return 0;
  try { return countSessionsInScope({ agent: agent as SessionAgentId }); } catch { return 0; }
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}

function formatScopeBreakdown(bySource: Record<string, number>): string {
  const entries = Object.entries(bySource);
  if (entries.length === 0) return '';
  return '[' + entries.map(([k, v]) => `${k}:${v}`).join(' ') + ']';
}
