#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

import { checkbox, confirm, select } from '@inquirer/prompts';

// Get version from package.json
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageJsonPath = path.join(__dirname, '..', 'package.json');
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
const VERSION = packageJson.version;

function isPromptCancelled(err: unknown): boolean {
  return err instanceof Error && (
    err.name === 'ExitPromptError' ||
    err.message.includes('force closed') ||
    err.message.includes('User force closed')
  );
}
import {
  AGENTS,
  ALL_AGENT_IDS,
  MCP_CAPABLE_AGENTS,
  SKILLS_CAPABLE_AGENTS,
  HOOKS_CAPABLE_AGENTS,
  getAllCliStates,
  isCliInstalled,
  isMcpRegistered,
  registerMcp,
  unregisterMcp,
  listInstalledMcpsWithScope,
  promoteMcpToUser,
  parseMcpConfig,
  getMcpConfigPathForHome,
  getAccountEmail,
} from './lib/agents.js';
import {
  readManifest,
  writeManifest,
  createDefaultManifest,
  MANIFEST_FILENAME,
} from './lib/manifest.js';
import {
  readMeta,
  writeMeta,
  ensureAgentsDir,
  getRepoLocalPath,
  getMemoryDir,
  getRepo,
  setRepo,
  removeRepo,
  getReposByPriority,
  getRepoPriority,
} from './lib/state.js';
import { REPO_PRIORITIES, DEFAULT_SYSTEM_REPO } from './lib/types.js';
import type { RepoName, RepoConfig } from './lib/types.js';
import {
  cloneRepo,
  parseSource,
  getGitHubUsername,
  getRemoteUrl,
  setRemoteUrl,
  checkGitHubRepoExists,
  commitAndPush,
  hasUncommittedChanges,
} from './lib/git.js';
import {
  discoverCommands,
  resolveCommandSource,
  installCommand,
  installCommandCentrally,
  uninstallCommand,
  listInstalledCommands,
  listInstalledCommandsWithScope,
  promoteCommandToUser,
  commandExists,
  commandContentMatches,
} from './lib/commands.js';
import {
  discoverHooksFromRepo,
  installHooks,
  installHooksCentrally,
  listInstalledHooksWithScope,
  promoteHookToUser,
  removeHook,
  hookExists,
  hookContentMatches,
  getSourceHookEntry,
} from './lib/hooks.js';
import {
  discoverSkillsFromRepo,
  installSkill,
  installSkillCentrally,
  uninstallSkill,
  listInstalledSkillsWithScope,
  promoteSkillToUser,
  getSkillInfo,
  getSkillRules,
  skillExists,
  skillContentMatches,
} from './lib/skills.js';
import {
  discoverInstructionsFromRepo,
  discoverMemoryFilesFromRepo,
  resolveInstructionsSource,
  installInstructions,
  installInstructionsCentrally,
  uninstallInstructions,
  listInstalledInstructionsWithScope,
  promoteInstructionsToUser,
  instructionsExists,
  instructionsContentMatches,
  getInstructionsContent,
} from './lib/instructions.js';
import type { AgentId, Manifest, RegistryType } from './lib/types.js';
import { DEFAULT_REGISTRIES } from './lib/types.js';
import {
  search as searchRegistries,
  getRegistries,
  getEnabledRegistries,
  setRegistry,
  removeRegistry,
  resolvePackage,
  getMcpServerInfo,
} from './lib/registry.js';
import {
  parseAgentSpec,
  installVersion,
  removeVersion,
  removeAllVersions,
  listInstalledVersions,
  getGlobalDefault,
  setGlobalDefault,
  isVersionInstalled,
  getBinaryPath,
  getVersionDir,
  getVersionHomePath,
  syncResourcesToVersion,
  resolveVersion,
} from './lib/versions.js';
import {
  createShim,
  removeShim,
  shimExists,
  isShimsInPath,
  getPathSetupInstructions,
  getShimsDir,
} from './lib/shims.js';

const program = new Command();

/**
 * Ensure at least one repo is configured.
 * If not, automatically initialize the system repo from DEFAULT_SYSTEM_REPO.
 * Returns the highest priority repo's source.
 */
async function ensureSource(repoName?: RepoName): Promise<string> {
  const meta = readMeta();

  // If specific repo requested, check if it exists
  if (repoName) {
    const repo = meta.repos[repoName];
    if (repo?.source) {
      return repo.source;
    }
    throw new Error(`Repo '${repoName}' not configured. Run: agents repo add <source> --name ${repoName}`);
  }

  // Check if any repo is configured
  const repos = getReposByPriority();
  if (repos.length > 0) {
    return repos[repos.length - 1].config.source;
  }

  // No repos configured - initialize system repo
  console.log(chalk.gray(`No repo configured. Initializing from ${DEFAULT_SYSTEM_REPO}...`));

  const parsed = parseSource(DEFAULT_SYSTEM_REPO);
  const { commit } = await cloneRepo(DEFAULT_SYSTEM_REPO);

  setRepo('system', {
    source: DEFAULT_SYSTEM_REPO,
    branch: parsed.ref || 'main',
    commit,
    lastSync: new Date().toISOString(),
    priority: REPO_PRIORITIES.system,
    readonly: true,
  });

  return DEFAULT_SYSTEM_REPO;
}

/**
 * Get local path for a named repo.
 */
function getRepoPath(repoName: RepoName): string | null {
  const repo = getRepo(repoName);
  if (!repo) return null;
  return getRepoLocalPath(repo.source);
}

program
  .name('agents')
  .description('Manage AI coding agents - configs, CLIs, and automation')
  .version(VERSION)
  .helpOption('-h, --help', 'Show help')
  .addHelpCommand(false); // Disable default help subcommand

// Custom help for the main program only
const originalHelpInformation = program.helpInformation.bind(program);
program.helpInformation = function () {
  // Only use custom help for the root program
  if (this.name() === 'agents' && !this.parent) {
    return `Usage: agents [options] [command]

Manage AI coding agents - configs, CLIs, and automation

Agents
  add <agent>[@version]           Install agent CLI
  remove <agent>[@version]        Remove agent CLI
  use <agent>@<version>           Set default version
  list                            List installed versions

Resources
  memory                          Manage AGENTS.md, SOUL.md, etc.
  commands                        Manage slash commands
  mcp                             Manage MCP servers
  skills                          Manage skills (SKILL.md + rules/)
  hooks                           Manage agent hooks

Packages
  search <query>                  Search MCP servers
  install <pkg>                   Install mcp:name or skill:user/repo

Automation
  jobs                            Manage scheduled jobs
  daemon                          Manage the scheduler daemon

Context
  drive                           Manage context drives (experimental)

Env
  status                          Show installed agents and sync status
  pull                            Sync from .agents repo
  push                            Push config to your .agents repo

Options:
  -V, --version                   Show version number
  -h, --help                      Show help

Run 'agents <command> --help' for details.
`;
  }
  return originalHelpInformation();
};

// Check for updates before command runs, prompt to upgrade
async function checkForUpdates(): Promise<void> {
  try {
    const response = await fetch('https://registry.npmjs.org/@swarmify/agents-cli/latest', {
      signal: AbortSignal.timeout(2000), // 2s timeout
    });
    if (!response.ok) return;

    const data = (await response.json()) as { version: string };
    const latestVersion = data.version;

    if (latestVersion !== VERSION && compareVersions(latestVersion, VERSION) > 0) {
      const answer = await select({
        message: `Update available: ${VERSION} -> ${latestVersion}`,
        choices: [
          { value: 'now', name: 'Upgrade now' },
          { value: 'later', name: 'Later' },
        ],
      });

      if (answer === 'now') {
        // Run upgrade
        const { exec } = await import('child_process');
        const { promisify } = await import('util');
        const execAsync = promisify(exec);
        const spinner = ora('Upgrading...').start();
        try {
          await execAsync('npm install -g @swarmify/agents-cli@latest');
          spinner.succeed(`Upgraded to ${latestVersion}`);
          await showWhatsNew(VERSION, latestVersion);
        } catch {
          spinner.fail('Upgrade failed');
          console.log(chalk.gray('Run manually: npm install -g @swarmify/agents-cli@latest'));
        }
        console.log();
      }
    }
  } catch (err) {
    if (isPromptCancelled(err)) {
      // User pressed Ctrl+C, continue with command
      return;
    }
    // Silently ignore network errors
  }
}

// Run update check before command runs
program.hook('preAction', async () => {
  const args = process.argv.slice(2);
  const skipCommands = ['--version', '-V', '--help', '-h'];
  if (args.length === 0 || skipCommands.includes(args[0])) {
    return;
  }
  await checkForUpdates();
});

// =============================================================================
// STATUS COMMAND
// =============================================================================

program
  .command('status [agent]')
  .description('Show installed agents, resources, and repos')
  .action(async (agentFilter?: string) => {
    const spinner = ora({ text: 'Loading...', isSilent: !process.stdout.isTTY }).start();

    // Resolve agent filter to AgentId
    let filterAgentId: AgentId | undefined;
    if (agentFilter) {
      const agentMap: Record<string, AgentId> = {
        claude: 'claude',
        'claude-code': 'claude',
        codex: 'codex',
        gemini: 'gemini',
        cursor: 'cursor',
        opencode: 'opencode',
      };
      filterAgentId = agentMap[agentFilter.toLowerCase()];
      if (!filterAgentId) {
        spinner.stop();
        console.log(chalk.red(`Unknown agent: ${agentFilter}`));
        console.log(chalk.gray(`Valid agents: claude, codex, gemini, cursor, opencode`));
        process.exit(1);
      }
    }

    const cwd = process.cwd();
    const cliStates = await getAllCliStates();
    const agentsToShow = filterAgentId ? [filterAgentId] : ALL_AGENT_IDS;
    const skillAgentsToShow = filterAgentId
      ? SKILLS_CAPABLE_AGENTS.filter((id) => id === filterAgentId)
      : SKILLS_CAPABLE_AGENTS;
    const mcpAgentsToShow = filterAgentId
      ? MCP_CAPABLE_AGENTS.filter((id) => id === filterAgentId)
      : MCP_CAPABLE_AGENTS;
    const hooksAgentsToShow = filterAgentId
      ? HOOKS_CAPABLE_AGENTS.filter((id) => id === filterAgentId)
      : HOOKS_CAPABLE_AGENTS;

    // Build repo resource map for sync status checking
    type SyncStatus = 'in_sync' | 'outdated' | 'local';

    interface RepoResourceEntry {
      repoName: string;
      localRepoPath: string;
    }

    const repoCommandMap = new Map<string, RepoResourceEntry>();
    const repoSkillMap = new Map<string, RepoResourceEntry & { sourcePath: string }>();
    const repoInstructionMap = new Map<string, RepoResourceEntry>(); // keyed by agentId
    const repoHookMap = new Map<string, RepoResourceEntry>();

    const repos = getReposByPriority();
    for (const { name, config } of repos) {
      const localPath = getRepoLocalPath(config.source);
      if (!fs.existsSync(localPath)) continue;

      const entry: RepoResourceEntry = { repoName: name, localRepoPath: localPath };

      try {
        for (const cmd of discoverCommands(localPath)) {
          repoCommandMap.set(cmd.name, entry);
        }
        for (const skill of discoverSkillsFromRepo(localPath)) {
          repoSkillMap.set(skill.name, { ...entry, sourcePath: skill.path });
        }
        for (const instr of discoverInstructionsFromRepo(localPath)) {
          repoInstructionMap.set(instr.agentId, entry);
        }
        const hookResult = discoverHooksFromRepo(localPath);
        for (const hookName of hookResult.shared) {
          repoHookMap.set(hookName, entry);
        }
        for (const hookNames of Object.values(hookResult.agentSpecific)) {
          for (const hookName of hookNames) {
            repoHookMap.set(hookName, entry);
          }
        }
      } catch {
        // Skip repos that fail to discover
      }
    }

    // Sync status helpers
    function getCommandSync(name: string, agentId: AgentId): { status: SyncStatus; repo?: string } {
      const entry = repoCommandMap.get(name);
      if (!entry) return { status: 'local' };
      const sourcePath = resolveCommandSource(entry.localRepoPath, name, agentId);
      if (!sourcePath) return { status: 'local' };
      return commandContentMatches(agentId, name, sourcePath)
        ? { status: 'in_sync', repo: entry.repoName }
        : { status: 'outdated', repo: entry.repoName };
    }

    function getSkillSync(name: string, agentId: AgentId): { status: SyncStatus; repo?: string } {
      const entry = repoSkillMap.get(name);
      if (!entry) return { status: 'local' };
      return skillContentMatches(agentId, name, entry.sourcePath)
        ? { status: 'in_sync', repo: entry.repoName }
        : { status: 'outdated', repo: entry.repoName };
    }

    function getInstructionsSync(agentId: AgentId): { status: SyncStatus; repo?: string } {
      const entry = repoInstructionMap.get(agentId);
      if (!entry) return { status: 'local' };
      const sourcePath = resolveInstructionsSource(entry.localRepoPath, agentId);
      if (!sourcePath) return { status: 'local' };
      return instructionsContentMatches(agentId, sourcePath)
        ? { status: 'in_sync', repo: entry.repoName }
        : { status: 'outdated', repo: entry.repoName };
    }

    function getHookSync(name: string, agentId: AgentId): { status: SyncStatus; repo?: string } {
      const entry = repoHookMap.get(name);
      if (!entry) return { status: 'local' };
      const sourceEntry = getSourceHookEntry(entry.localRepoPath, agentId, name);
      if (!sourceEntry) return { status: 'local' };
      return hookContentMatches(agentId, name, sourceEntry)
        ? { status: 'in_sync', repo: entry.repoName }
        : { status: 'outdated', repo: entry.repoName };
    }

    // Color helpers
    function colorName(name: string, status: SyncStatus): string {
      if (status === 'in_sync') return chalk.green(name);
      if (status === 'outdated') return chalk.yellow(name);
      return chalk.blue(name);
    }

    // Collect deduplicated resources
    interface StatusResource {
      name: string;
      syncStatus: SyncStatus;
      repoName?: string;
      agents?: AgentId[];
      ruleCount?: number;
      version?: string;
    }

    // Commands
    const userCommands: StatusResource[] = [];
    const projectCommands: StatusResource[] = [];
    const seenUserCmds = new Set<string>();
    const seenProjectCmds = new Set<string>();

    for (const agentId of agentsToShow) {
      for (const cmd of listInstalledCommandsWithScope(agentId, cwd)) {
        const seen = cmd.scope === 'user' ? seenUserCmds : seenProjectCmds;
        const list = cmd.scope === 'user' ? userCommands : projectCommands;
        if (!seen.has(cmd.name)) {
          seen.add(cmd.name);
          const sync = getCommandSync(cmd.name, agentId);
          list.push({ name: cmd.name, syncStatus: sync.status, repoName: sync.repo });
        }
      }
    }

    // Skills
    const userSkills: StatusResource[] = [];
    const projectSkills: StatusResource[] = [];
    const seenUserSkills = new Set<string>();
    const seenProjectSkills = new Set<string>();

    for (const agentId of skillAgentsToShow) {
      for (const skill of listInstalledSkillsWithScope(agentId, cwd)) {
        const seen = skill.scope === 'user' ? seenUserSkills : seenProjectSkills;
        const list = skill.scope === 'user' ? userSkills : projectSkills;
        if (!seen.has(skill.name)) {
          seen.add(skill.name);
          const sync = getSkillSync(skill.name, agentId);
          list.push({ name: skill.name, syncStatus: sync.status, repoName: sync.repo, ruleCount: skill.ruleCount });
        }
      }
    }

    // MCPs - track which agents have each
    const userMcps: StatusResource[] = [];
    const projectMcps: StatusResource[] = [];
    const seenUserMcps = new Map<string, StatusResource>();
    const seenProjectMcps = new Map<string, StatusResource>();

    const installedMcpAgents = mcpAgentsToShow.filter((agentId) => cliStates[agentId]?.installed);
    for (const agentId of installedMcpAgents) {
      for (const mcp of listInstalledMcpsWithScope(agentId, cwd)) {
        const seen = mcp.scope === 'user' ? seenUserMcps : seenProjectMcps;
        const list = mcp.scope === 'user' ? userMcps : projectMcps;
        const existing = seen.get(mcp.name);
        if (existing) {
          existing.agents!.push(agentId);
        } else {
          const resource: StatusResource = {
            name: mcp.name,
            syncStatus: 'local',
            agents: [agentId],
            version: mcp.version,
          };
          seen.set(mcp.name, resource);
          list.push(resource);
        }
      }
    }

    // Memory
    const userInstructions: StatusResource[] = [];
    const projectInstructions: StatusResource[] = [];
    const seenUserInstr = new Set<string>();
    const seenProjectInstr = new Set<string>();

    for (const agentId of agentsToShow) {
      for (const instr of listInstalledInstructionsWithScope(agentId, cwd)) {
        if (!instr.exists) continue;
        const key = AGENTS[agentId].instructionsFile;
        const seen = instr.scope === 'user' ? seenUserInstr : seenProjectInstr;
        const list = instr.scope === 'user' ? userInstructions : projectInstructions;
        if (!seen.has(key)) {
          seen.add(key);
          const sync = getInstructionsSync(agentId);
          list.push({ name: key, syncStatus: sync.status, repoName: sync.repo });
        }
      }
    }

    // Hooks - track which agents have each
    const userHooks: StatusResource[] = [];
    const projectHooks: StatusResource[] = [];
    const seenUserHooks = new Map<string, StatusResource>();
    const seenProjectHooks = new Map<string, StatusResource>();

    for (const agentId of hooksAgentsToShow) {
      for (const hook of listInstalledHooksWithScope(agentId, cwd)) {
        const seen = hook.scope === 'user' ? seenUserHooks : seenProjectHooks;
        const list = hook.scope === 'user' ? userHooks : projectHooks;
        const existing = seen.get(hook.name);
        if (existing) {
          existing.agents!.push(agentId);
        } else {
          const sync = getHookSync(hook.name, agentId);
          const resource: StatusResource = {
            name: hook.name,
            syncStatus: sync.status,
            repoName: sync.repo,
            agents: [agentId],
          };
          seen.set(hook.name, resource);
          list.push(resource);
        }
      }
    }

    spinner.stop();

    // Render helpers
    function renderList(resources: StatusResource[], showAgents = false): string {
      if (resources.length === 0) return chalk.gray('none');
      return resources
        .map((r) => {
          let display = r.version
            ? colorName(`${r.name}@${r.version}`, r.syncStatus)
            : colorName(r.name, r.syncStatus);
          if (r.ruleCount !== undefined) display += chalk.gray(` (${r.ruleCount} rules)`);
          if (showAgents && r.agents && r.agents.length > 0) {
            display += chalk.gray(` [${r.agents.join(', ')}]`);
          }
          return display;
        })
        .join(', ');
    }

    function renderSection(
      title: string,
      user: StatusResource[],
      project: StatusResource[],
      showAgents = false
    ): void {
      console.log(chalk.bold(`\n${title}\n`));
      if (user.length === 0 && project.length === 0) {
        console.log(`  ${chalk.gray('none')}`);
      } else {
        if (user.length > 0) {
          console.log(`  ${chalk.gray('User:')}    ${renderList(user, showAgents)}`);
        }
        if (project.length > 0) {
          console.log(`  ${chalk.gray('Project:')} ${renderList(project, showAgents)}`);
        }
      }
    }

    // 1. Agent CLIs
    console.log(chalk.bold('Agent CLIs\n'));

    // Fetch emails in parallel for all agents
    const statusEmails = await Promise.all(
      agentsToShow.map(async (agentId) => {
        const resolvedVer = resolveVersion(agentId, process.cwd());
        const home = resolvedVer ? getVersionHomePath(agentId, resolvedVer) : undefined;
        return { agentId, email: await getAccountEmail(agentId, home) };
      })
    );
    const statusEmailMap = new Map(statusEmails.map((e) => [e.agentId, e.email]));

    for (const agentId of agentsToShow) {
      const agent = AGENTS[agentId];
      const cli = cliStates[agentId];
      const status = cli?.installed
        ? chalk.green(cli.version || 'installed')
        : chalk.gray('not installed');
      const email = statusEmailMap.get(agentId);
      const emailStr = email ? chalk.cyan(`  ${email}`) : '';
      console.log(`  ${agent.name.padEnd(14)} ${status}${emailStr}`);
    }

    // 2. Commands
    renderSection('Commands', userCommands, projectCommands);

    // 3. Skills
    if (skillAgentsToShow.length > 0) {
      renderSection('Skills', userSkills, projectSkills);
    }

    // 4. MCP Servers
    if (installedMcpAgents.length > 0) {
      renderSection('MCP Servers', userMcps, projectMcps, !filterAgentId);
    }

    // 5. Memory
    renderSection('Memory', userInstructions, projectInstructions);

    // 6. Hooks (only if any exist)
    if (hooksAgentsToShow.length > 0 && (userHooks.length > 0 || projectHooks.length > 0)) {
      renderSection('Hooks', userHooks, projectHooks, !filterAgentId);
    }

    // 7. Configured Repos
    if (!filterAgentId) {
      if (repos.length > 0) {
        console.log(chalk.bold('\nConfigured Repos\n'));
        for (const { name, config } of repos) {
          const readonlyTag = config.readonly ? chalk.gray(' (readonly)') : '';
          const priorityTag = chalk.gray(` [priority: ${config.priority}]`);
          console.log(`  ${chalk.bold(name)}${readonlyTag}${priorityTag}`);
          console.log(`    ${config.source}`);
          console.log(`    Branch: ${config.branch}  Commit: ${config.commit.substring(0, 8)}`);
          console.log(`    Last sync: ${new Date(config.lastSync).toLocaleString()}`);
        }
      } else {
        console.log(chalk.bold('\nNo repos configured\n'));
        console.log(chalk.gray('  Run: agents repo add <source>'));
      }
    }

    // Legend
    console.log('');
    console.log(chalk.gray(`  ${chalk.green('green')} = in sync   ${chalk.yellow('yellow')} = outdated   ${chalk.blue('blue')} = local`));
  });

// =============================================================================
// PULL COMMAND
// =============================================================================

// Agent name aliases for flexible input
const AGENT_NAME_ALIASES: Record<string, AgentId> = {
  claude: 'claude',
  'claude-code': 'claude',
  cc: 'claude',
  codex: 'codex',
  'openai-codex': 'codex',
  cx: 'codex',
  gemini: 'gemini',
  'gemini-cli': 'gemini',
  gx: 'gemini',
  cursor: 'cursor',
  'cursor-agent': 'cursor',
  cr: 'cursor',
  opencode: 'opencode',
  oc: 'opencode',
};

function resolveAgentName(input: string): AgentId | null {
  return AGENT_NAME_ALIASES[input.toLowerCase()] || null;
}

function isAgentName(input: string): boolean {
  return resolveAgentName(input) !== null;
}

// Resource item for tracking new vs existing
interface ResourceItem {
  type: 'command' | 'skill' | 'hook' | 'mcp' | 'memory' | 'job' | 'drive';
  name: string;
  agents: AgentId[];
  isNew: boolean;
}

// Per-resource conflict decision
type ResourceDecision = 'overwrite' | 'skip';

program
  .command('pull [source] [agent]')
  .description('Sync config from a .agents repo')
  .option('-y, --yes', 'Skip prompts and keep existing conflicts')
  .option('-f, --force', 'Skip prompts and overwrite conflicts')
  .option('-s, --scope <scope>', 'Target scope', 'user')
  .option('--dry-run', 'Show what would change')
  .option('--skip-clis', 'Do not sync CLI versions')
  .option('--skip-mcp', 'Do not register MCP servers')
  .option('--clean', 'Remove MCPs not in repo')
  .action(async (arg1: string | undefined, arg2: string | undefined, options) => {
    // Parse source and agent filter from positional args
    let targetSource: string | undefined;
    let agentFilter: AgentId | undefined;

    if (arg1) {
      if (isAgentName(arg1)) {
        // agents pull claude
        agentFilter = resolveAgentName(arg1)!;
      } else {
        // agents pull gh:user/repo [agent]
        targetSource = arg1;
        if (arg2 && isAgentName(arg2)) {
          agentFilter = resolveAgentName(arg2)!;
        }
      }
    }

    const repoName = options.scope as RepoName;
    const meta = readMeta();
    const existingRepo = meta.repos[repoName];

    // Try: 1) provided source, 2) existing repo source, 3) fall back to system repo
    targetSource = targetSource || existingRepo?.source;
    let effectiveRepo = repoName;

    if (!targetSource && repoName === 'user') {
      const systemRepo = meta.repos['system'];
      if (systemRepo?.source) {
        targetSource = systemRepo.source;
        effectiveRepo = 'system';
        console.log(chalk.gray(`No user repo configured, using system repo: ${targetSource}\n`));
      }
    }

    if (!targetSource) {
      if (repoName === 'user' && Object.keys(meta.repos).length === 0) {
        console.log(chalk.gray(`First run detected. Initializing from ${DEFAULT_SYSTEM_REPO}...\n`));
        targetSource = DEFAULT_SYSTEM_REPO;
        effectiveRepo = 'system';
      } else {
        console.log(chalk.red(`No source specified for repo '${repoName}'.`));
        const repoHint = repoName === 'user' ? '' : ` --scope ${repoName}`;
        console.log(chalk.gray(`  Usage: agents pull <source>${repoHint}`));
        console.log(chalk.gray('  Example: agents pull gh:username/.agents'));
        process.exit(1);
      }
    }

    const targetRepoConfig = meta.repos[effectiveRepo];
    const isReadonly = targetRepoConfig?.readonly || effectiveRepo === 'system';
    const isUserScope = effectiveRepo === 'user';

    const parsed = parseSource(targetSource);
    const spinner = ora(`Syncing from ${effectiveRepo} repo...`).start();

    try {
      const { localPath, commit, isNew } = await cloneRepo(targetSource);
      spinner.succeed(isNew ? 'Repository cloned' : 'Repository updated');

      const manifest = readManifest(localPath);
      if (!manifest) {
        console.log(chalk.yellow(`No ${MANIFEST_FILENAME} found in repository`));
      }

      // Discover all assets
      const allCommands = discoverCommands(localPath);
      const allSkills = discoverSkillsFromRepo(localPath);
      const discoveredHooks = discoverHooksFromRepo(localPath);
      const allInstructions = discoverInstructionsFromRepo(localPath);
      const allMemoryFiles = discoverMemoryFilesFromRepo(localPath);
      const allDiscoveredJobs = discoverJobsFromRepo(localPath);
      const allDiscoveredDrives = discoverDrivesFromRepo(localPath);

      // Auto-install/upgrade CLI versions
      if (!options.skipClis && manifest?.agents) {
        const cliAgents = (manifest.defaults?.agents || Object.keys(manifest.agents)) as AgentId[];
        for (const agentId of cliAgents) {
          if (agentFilter && agentId !== agentFilter) continue;
          const agent = AGENTS[agentId];
          if (!agent) continue;

          const cliSpinner = ora(`Checking ${agent.name}...`).start();
          const versions = listInstalledVersions(agentId);
          const targetVersion = manifest.agents[agentId] || 'latest';

          const result = await installVersion(agentId, targetVersion, (msg) => { cliSpinner.text = msg; });
          if (result.success) {
            const isNew = versions.length === 0;
            const isUpgrade = !isNew && result.installedVersion !== versions[versions.length - 1];
            if (isNew) {
              cliSpinner.succeed(`Installed ${agent.name}@${result.installedVersion}`);
              createShim(agentId);
            } else if (isUpgrade) {
              cliSpinner.succeed(`Upgraded ${agent.name} to ${result.installedVersion}`);
              createShim(agentId);
            } else {
              cliSpinner.succeed(`${agent.name}@${result.installedVersion} (up to date)`);
            }
            setGlobalDefault(agentId, result.installedVersion);
          } else {
            cliSpinner.warn(`${agent.name}: ${result.error}`);
          }
        }
      }

      // Determine which agents should share central resources
      let cliStates = await getAllCliStates();
      let selectedAgents: AgentId[];

      // Track version selections per agent: agent -> versions[]
      // Empty array means not version-managed (install directly to ~/.{agent}/)
      const agentVersionSelections = new Map<AgentId, string[]>();

      const formatAgentLabel = (agentId: AgentId): string => {
        const versions = listInstalledVersions(agentId);
        const defaultVer = getGlobalDefault(agentId);
        if (versions.length === 0) return `${AGENTS[agentId].name}  ${chalk.gray('(not installed)')}`;
        if (defaultVer) return `${AGENTS[agentId].name}  ${chalk.gray(`(active: ${defaultVer})`)}`;
        return `${AGENTS[agentId].name}  ${chalk.gray(`(${versions[0]})`)}`;
      };

      if (agentFilter) {
        const versions = listInstalledVersions(agentFilter);
        const defaultVer = getGlobalDefault(agentFilter);

        if (versions.length > 1 && !options.yes && !options.force) {
          const versionEmails = await Promise.all(
            versions.map((v) =>
              getAccountEmail(agentFilter, getVersionHomePath(agentFilter, v)).then((email) => ({ v, email }))
            )
          );
          const versionEmailMap = new Map(versionEmails.map((e) => [e.v, e.email]));

          const versionResult = await checkbox<string>({
            message: `Which versions of ${AGENTS[agentFilter].name} should receive these resources?`,
            choices: [
              { name: chalk.bold('All versions'), value: 'all', checked: false },
              ...versions.map((v) => {
                let label = v === defaultVer ? `${v} (default)` : v;
                const email = versionEmailMap.get(v);
                if (email) label += chalk.cyan(`  ${email}`);
                return { name: label, value: v, checked: v === defaultVer };
              }),
            ],
          });
          if (versionResult.includes('all')) {
            agentVersionSelections.set(agentFilter, [...versions]);
          } else {
            agentVersionSelections.set(agentFilter, versionResult);
          }
        } else if (versions.length === 1) {
          agentVersionSelections.set(agentFilter, [versions[0]]);
        } else if (versions.length > 1) {
          // --yes/--force: select default or all
          agentVersionSelections.set(agentFilter, defaultVer ? [defaultVer] : [...versions]);
        }
        // else: no versions installed, not version-managed

        selectedAgents = [agentFilter];
        const selectedVers = agentVersionSelections.get(agentFilter);
        if (selectedVers && selectedVers.length > 0) {
          console.log(`\nTarget: ${AGENTS[agentFilter].name} ${chalk.gray(`(${selectedVers.join(', ')})`)}\n`);
        } else {
          console.log(`\nTarget: ${AGENTS[agentFilter].name}\n`);
        }
      } else if (options.yes || options.force) {
        selectedAgents = (manifest?.defaults?.agents || ALL_AGENT_IDS) as AgentId[];
        const installed = selectedAgents.filter((id) => cliStates[id]?.installed || id === 'cursor');
        // Auto-select default version for each agent
        for (const agentId of installed) {
          const versions = listInstalledVersions(agentId);
          if (versions.length > 0) {
            const defaultVer = getGlobalDefault(agentId);
            agentVersionSelections.set(agentId, defaultVer ? [defaultVer] : [versions[versions.length - 1]]);
          }
        }
        if (installed.length > 0) {
          console.log(chalk.bold('\nTarget agents:\n'));
          for (const agentId of installed) {
            console.log(`  ${formatAgentLabel(agentId)}`);
          }
          console.log();
        }
      } else {
        const installedAgents = ALL_AGENT_IDS.filter((id) => cliStates[id]?.installed || id === 'cursor');
        const defaultAgents = (manifest?.defaults?.agents || ALL_AGENT_IDS) as AgentId[];
        const allDefaulted = installedAgents.every((id) => defaultAgents.includes(id));

        const checkboxResult = await checkbox<string>({
          message: 'Which agents should receive these resources?',
          choices: [
            { name: chalk.bold('All'), value: 'all', checked: allDefaulted },
            ...installedAgents.map((id) => ({
              name: `  ${formatAgentLabel(id)}`,
              value: id,
              checked: !allDefaulted && defaultAgents.includes(id),
            })),
          ],
        });

        if (checkboxResult.includes('all')) {
          selectedAgents = [...installedAgents];
        } else {
          selectedAgents = checkboxResult as AgentId[];
        }

        // Version selection per agent (only for version-managed agents)
        for (const agentId of selectedAgents) {
          const versions = listInstalledVersions(agentId);
          if (versions.length === 0) continue; // not version-managed
          if (versions.length === 1) {
            agentVersionSelections.set(agentId, [versions[0]]);
            continue;
          }
          const defaultVer = getGlobalDefault(agentId);
          const versionEmails = await Promise.all(
            versions.map((v) =>
              getAccountEmail(agentId, getVersionHomePath(agentId, v)).then((email) => ({ v, email }))
            )
          );
          const versionEmailMap = new Map(versionEmails.map((e) => [e.v, e.email]));

          const versionResult = await checkbox<string>({
            message: `Which versions of ${AGENTS[agentId].name} should receive these resources?`,
            choices: [
              { name: chalk.bold('All versions'), value: 'all', checked: false },
              ...versions.map((v) => {
                let label = v === defaultVer ? `${v} (default)` : v;
                const email = versionEmailMap.get(v);
                if (email) label += chalk.cyan(`  ${email}`);
                return { name: label, value: v, checked: v === defaultVer };
              }),
            ],
          });
          if (versionResult.includes('all')) {
            agentVersionSelections.set(agentId, [...versions]);
          } else {
            agentVersionSelections.set(agentId, versionResult);
          }
        }
      }

      // Filter agents to only installed ones (plus cursor which doesn't need CLI)
      selectedAgents = selectedAgents.filter((id) => cliStates[id]?.installed || id === 'cursor');

      if (selectedAgents.length === 0) {
        console.log(chalk.yellow('\nNo agents selected or installed. Nothing to sync.'));
        return;
      }

      // Build resource items with conflict detection
      const newItems: ResourceItem[] = [];
      const existingItems: ResourceItem[] = [];
      const upToDateItems: ResourceItem[] = [];

      // Process commands
      for (const command of allCommands) {
        const applicableAgents = selectedAgents.filter((agentId) => {
          const sourcePath = resolveCommandSource(localPath, command.name, agentId);
          return sourcePath !== null;
        });
        if (applicableAgents.length === 0) continue;

        const newAgents = applicableAgents.filter((agentId) => !commandExists(agentId, command.name));
        const upToDateAgents = applicableAgents.filter((agentId) => {
          if (!commandExists(agentId, command.name)) return false;
          const sourcePath = resolveCommandSource(localPath, command.name, agentId);
          return sourcePath && commandContentMatches(agentId, command.name, sourcePath);
        });
        const conflictingAgents = applicableAgents.filter((agentId) => {
          if (!commandExists(agentId, command.name)) return false;
          const sourcePath = resolveCommandSource(localPath, command.name, agentId);
          return sourcePath && !commandContentMatches(agentId, command.name, sourcePath);
        });

        if (newAgents.length > 0) {
          newItems.push({ type: 'command', name: command.name, agents: newAgents, isNew: true });
        }
        if (upToDateAgents.length > 0) {
          upToDateItems.push({ type: 'command', name: command.name, agents: upToDateAgents, isNew: false });
        }
        if (conflictingAgents.length > 0) {
          existingItems.push({ type: 'command', name: command.name, agents: conflictingAgents, isNew: false });
        }
      }

      // Process skills
      const skillAgents = SKILLS_CAPABLE_AGENTS.filter((id) => selectedAgents.includes(id));
      for (const skill of allSkills) {
        const newAgents = skillAgents.filter((agentId) => !skillExists(agentId, skill.name));
        const upToDateAgents = skillAgents.filter((agentId) => {
          if (!skillExists(agentId, skill.name)) return false;
          return skillContentMatches(agentId, skill.name, skill.path);
        });
        const conflictingAgents = skillAgents.filter((agentId) => {
          if (!skillExists(agentId, skill.name)) return false;
          return !skillContentMatches(agentId, skill.name, skill.path);
        });

        if (newAgents.length > 0) {
          newItems.push({ type: 'skill', name: skill.name, agents: newAgents, isNew: true });
        }
        if (upToDateAgents.length > 0) {
          upToDateItems.push({ type: 'skill', name: skill.name, agents: upToDateAgents, isNew: false });
        }
        if (conflictingAgents.length > 0) {
          existingItems.push({ type: 'skill', name: skill.name, agents: conflictingAgents, isNew: false });
        }
      }

      // Process hooks
      const hookAgents = selectedAgents.filter(
        (id) => HOOKS_CAPABLE_AGENTS.includes(id as typeof HOOKS_CAPABLE_AGENTS[number]) && cliStates[id]?.installed
      );
      const allHookNames = [
        ...discoveredHooks.shared,
        ...Object.entries(discoveredHooks.agentSpecific)
          .filter(([agentId]) => hookAgents.includes(agentId as AgentId))
          .flatMap(([_, hooks]) => hooks),
      ];
      const uniqueHookNames = [...new Set(allHookNames)];

      for (const hookName of uniqueHookNames) {
        const newAgents = hookAgents.filter((agentId) => !hookExists(agentId, hookName));
        const upToDateAgents = hookAgents.filter((agentId) => {
          if (!hookExists(agentId, hookName)) return false;
          const sourceEntry = getSourceHookEntry(localPath, agentId, hookName);
          return sourceEntry && hookContentMatches(agentId, hookName, sourceEntry);
        });
        const conflictingAgents = hookAgents.filter((agentId) => {
          if (!hookExists(agentId, hookName)) return false;
          const sourceEntry = getSourceHookEntry(localPath, agentId, hookName);
          return !sourceEntry || !hookContentMatches(agentId, hookName, sourceEntry);
        });

        if (newAgents.length > 0) {
          newItems.push({ type: 'hook', name: hookName, agents: newAgents, isNew: true });
        }
        if (upToDateAgents.length > 0) {
          upToDateItems.push({ type: 'hook', name: hookName, agents: upToDateAgents, isNew: false });
        }
        if (conflictingAgents.length > 0) {
          existingItems.push({ type: 'hook', name: hookName, agents: conflictingAgents, isNew: false });
        }
      }

      // Process MCPs (no content comparison - just existence check)
      if (!options.skipMcp && manifest?.mcp) {
        for (const [name, config] of Object.entries(manifest.mcp)) {
          if (config.transport === 'http' || !config.command) continue;
          const eligible = config.agents?.length ? config.agents : selectedAgents;
          const mcpAgents = eligible.filter((agentId) => selectedAgents.includes(agentId) && cliStates[agentId]?.installed);
          if (mcpAgents.length === 0) continue;

          const registrationChecks = await Promise.all(
            mcpAgents.map(async (agentId) => ({
              agentId,
              isRegistered: await isMcpRegistered(agentId, name),
            }))
          );
          const conflictingAgents = registrationChecks.filter((r) => r.isRegistered).map((r) => r.agentId);
          const newAgents = registrationChecks.filter((r) => !r.isRegistered).map((r) => r.agentId);

          if (conflictingAgents.length > 0) {
            existingItems.push({ type: 'mcp', name, agents: conflictingAgents, isNew: false });
          }
          if (newAgents.length > 0) {
            newItems.push({ type: 'mcp', name, agents: newAgents, isNew: true });
          }
        }
      }

      // Process agent-specific memory files
      for (const instr of allInstructions) {
        if (!selectedAgents.includes(instr.agentId)) continue;

        const hasExisting = instructionsExists(instr.agentId, 'user');
        if (!hasExisting) {
          newItems.push({ type: 'memory', name: AGENTS[instr.agentId].instructionsFile, agents: [instr.agentId], isNew: true });
        } else if (instructionsContentMatches(instr.agentId, instr.sourcePath, 'user')) {
          upToDateItems.push({ type: 'memory', name: AGENTS[instr.agentId].instructionsFile, agents: [instr.agentId], isNew: false });
        } else {
          existingItems.push({ type: 'memory', name: AGENTS[instr.agentId].instructionsFile, agents: [instr.agentId], isNew: false });
        }
      }

      // Process additional repo memory files (for example SOUL.md)
      const normalizedMemoryContent = (content: string) => content.replace(/\r\n/g, '\n').trim();
      const agentMemoryNames = new Set(
        allInstructions.map((instr) => AGENTS[instr.agentId].instructionsFile)
      );
      const centralMemoryDir = getMemoryDir();

      for (const memoryFile of allMemoryFiles) {
        if (agentMemoryNames.has(memoryFile)) continue;

        const sourcePath = path.join(localPath, 'memory', memoryFile);
        const targetPath = path.join(centralMemoryDir, memoryFile);

        if (!fs.existsSync(targetPath)) {
          newItems.push({ type: 'memory', name: memoryFile, agents: [], isNew: true });
          continue;
        }

        try {
          const sourceContent = fs.readFileSync(sourcePath, 'utf-8');
          const targetContent = fs.readFileSync(targetPath, 'utf-8');
          if (normalizedMemoryContent(sourceContent) === normalizedMemoryContent(targetContent)) {
            upToDateItems.push({ type: 'memory', name: memoryFile, agents: [], isNew: false });
          } else {
            existingItems.push({ type: 'memory', name: memoryFile, agents: [], isNew: false });
          }
        } catch {
          existingItems.push({ type: 'memory', name: memoryFile, agents: [], isNew: false });
        }
      }

      // Process jobs
      for (const discoveredJob of allDiscoveredJobs) {
        if (!jobExists(discoveredJob.name)) {
          newItems.push({ type: 'job', name: discoveredJob.name, agents: [], isNew: true });
        } else if (jobContentMatches(discoveredJob.name, discoveredJob.path)) {
          upToDateItems.push({ type: 'job', name: discoveredJob.name, agents: [], isNew: false });
        } else {
          existingItems.push({ type: 'job', name: discoveredJob.name, agents: [], isNew: false });
        }
      }

      // Process drives
      for (const discoveredDrive of allDiscoveredDrives) {
        if (!driveExists(discoveredDrive.name)) {
          newItems.push({ type: 'drive', name: discoveredDrive.name, agents: [], isNew: true });
        } else if (driveContentMatches(discoveredDrive.name, discoveredDrive.path)) {
          upToDateItems.push({ type: 'drive', name: discoveredDrive.name, agents: [], isNew: false });
        } else {
          existingItems.push({ type: 'drive', name: discoveredDrive.name, agents: [], isNew: false });
        }
      }

      // Display overview
      console.log(chalk.bold('\nOverview\n'));

      const formatAgentList = (agents: AgentId[]) =>
        agents.map((id) => AGENTS[id].name).join(', ');

      const syncedAgentNames = selectedAgents.map((id) => AGENTS[id].name).join(', ');
      console.log(`  Target: ${chalk.cyan(syncedAgentNames)}\n`);

      if (newItems.length > 0) {
        console.log(chalk.green('  NEW (will install):\n'));
        const byType = { command: [] as ResourceItem[], skill: [] as ResourceItem[], hook: [] as ResourceItem[], mcp: [] as ResourceItem[], memory: [] as ResourceItem[], job: [] as ResourceItem[], drive: [] as ResourceItem[] };
        for (const item of newItems) byType[item.type].push(item);

        // Central resources - shared across all synced agents
        if (byType.command.length > 0) {
          console.log(`    Commands ${chalk.gray('(~/.agents/commands/)')}:`);
          for (const item of byType.command) {
            console.log(`      ${chalk.cyan(item.name)}`);
          }
        }
        if (byType.skill.length > 0) {
          console.log(`    Skills ${chalk.gray('(~/.agents/skills/)')}:`);
          for (const item of byType.skill) {
            console.log(`      ${chalk.cyan(item.name)}`);
          }
        }
        if (byType.hook.length > 0) {
          console.log(`    Hooks ${chalk.gray('(~/.agents/hooks/)')}:`);
          for (const item of byType.hook) {
            console.log(`      ${chalk.cyan(item.name)}`);
          }
        }
        if (byType.memory.length > 0) {
          console.log(`    Memory ${chalk.gray('(~/.agents/memory/)')}:`);
          for (const item of byType.memory) {
            console.log(`      ${chalk.cyan(item.name)}`);
          }
        }

        // Per-agent resources
        if (byType.mcp.length > 0) {
          console.log(`    MCP Servers:`);
          for (const item of byType.mcp) {
            console.log(`      ${chalk.cyan(item.name)}`);
          }
        }
        if (byType.job.length > 0) {
          console.log(`    Jobs ${chalk.gray('(~/.agents/jobs/)')}:`);
          for (const item of byType.job) {
            console.log(`      ${chalk.cyan(item.name)}`);
          }
        }
        if (byType.drive.length > 0) {
          console.log(`    Drives ${chalk.gray('(~/.agents/drives/)')}:`);
          for (const item of byType.drive) {
            console.log(`      ${chalk.cyan(item.name)}`);
          }
        }
        console.log();
      }


      if (existingItems.length > 0) {
        console.log(chalk.yellow('  CONFLICTS (will prompt):\n'));
        const byType = { command: [] as ResourceItem[], skill: [] as ResourceItem[], hook: [] as ResourceItem[], mcp: [] as ResourceItem[], memory: [] as ResourceItem[], job: [] as ResourceItem[], drive: [] as ResourceItem[] };
        for (const item of existingItems) byType[item.type].push(item);

        // Central resources
        if (byType.command.length > 0) {
          console.log(`    Commands: ${chalk.yellow(byType.command.map(i => i.name).join(', '))}`);
        }
        if (byType.skill.length > 0) {
          console.log(`    Skills: ${chalk.yellow(byType.skill.map(i => i.name).join(', '))}`);
        }
        if (byType.hook.length > 0) {
          console.log(`    Hooks: ${chalk.yellow(byType.hook.map(i => i.name).join(', '))}`);
        }
        if (byType.memory.length > 0) {
          console.log(`    Memory: ${chalk.yellow(byType.memory.map(i => i.name).join(', '))}`);
        }

        // Per-agent resources
        if (byType.mcp.length > 0) {
          console.log(`    MCP Servers:`);
          for (const item of byType.mcp) {
            console.log(`      ${chalk.yellow(item.name.padEnd(20))} ${chalk.gray(formatAgentList(item.agents))}`);
          }
        }
        if (byType.job.length > 0) {
          console.log(`    Jobs: ${chalk.yellow(byType.job.map(i => i.name).join(', '))}`);
        }
        if (byType.drive.length > 0) {
          console.log(`    Drives: ${chalk.yellow(byType.drive.map(i => i.name).join(', '))}`);
        }
        console.log();
      }

      if (newItems.length === 0 && existingItems.length === 0) {
        console.log(chalk.gray('  Already up to date.\n'));
        return;
      }

      if (options.dryRun) {
        console.log(chalk.yellow('Dry run - no changes made'));
        return;
      }

      // Confirmation prompt
      if (!options.yes && !options.force) {
        const proceed = await confirm({
          message: 'Proceed with installation?',
          default: true,
        });
        if (!proceed) {
          console.log(chalk.yellow('\nCancelled'));
          return;
        }
      }

      // Per-resource conflict decisions
      const decisions = new Map<string, ResourceDecision>();

      if (existingItems.length > 0 && !options.force && !options.yes) {
        console.log(chalk.bold('\nResolve conflicts:\n'));

        for (const item of existingItems) {
          const typeLabel = item.type.charAt(0).toUpperCase() + item.type.slice(1);
          const agentList = formatAgentList(item.agents);
          const conflictContext = agentList ? ` (${agentList})` : '';

          const decision = await select({
            message: `${typeLabel} '${item.name}' exists${conflictContext}`,
            choices: [
              { name: 'Overwrite', value: 'overwrite' as const },
              { name: 'Skip', value: 'skip' as const },
              { name: 'Cancel all', value: 'cancel' as const },
            ],
          });

          if (decision === 'cancel') {
            console.log(chalk.yellow('\nCancelled'));
            return;
          }

          decisions.set(`${item.type}:${item.name}`, decision);
        }
      } else if (options.force) {
        // Force mode: overwrite all
        for (const item of existingItems) {
          decisions.set(`${item.type}:${item.name}`, 'overwrite');
        }
      } else if (options.yes) {
        // Yes mode: skip all conflicts
        for (const item of existingItems) {
          decisions.set(`${item.type}:${item.name}`, 'skip');
        }
      }

      // Install new items (no conflicts)
      console.log();
      let installed = { commands: 0, skills: 0, hooks: 0, mcps: 0, memory: 0, jobs: 0, drives: 0 };
      let skipped = { commands: 0, skills: 0, hooks: 0, mcps: 0, memory: 0, jobs: 0, drives: 0 };

      // Install commands to central ~/.agents/commands/
      const cmdSpinner = ora('Installing commands to central storage...').start();
      const seenCommands = new Set<string>();
      for (const item of [...newItems, ...existingItems].filter((i) => i.type === 'command')) {
        if (seenCommands.has(item.name)) continue;
        seenCommands.add(item.name);

        const decision = item.isNew ? 'overwrite' : decisions.get(`command:${item.name}`);
        if (decision === 'skip') {
          skipped.commands++;
          continue;
        }

        // Find source path (prefer shared, then agent-specific)
        const sourcePath = resolveCommandSource(localPath, item.name, item.agents[0] || 'claude');
        if (sourcePath) {
          const result = installCommandCentrally(sourcePath, item.name);
          if (result.error) {
            console.log(chalk.yellow(`\n  Warning: ${item.name}: ${result.error}`));
          } else {
            installed.commands++;
          }
        }
      }
      if (skipped.commands > 0) {
        cmdSpinner.succeed(`Installed ${installed.commands} commands (skipped ${skipped.commands})`);
      } else if (installed.commands > 0) {
        cmdSpinner.succeed(`Installed ${installed.commands} commands`);
      } else {
        cmdSpinner.info('No commands to install');
      }

      // Install skills to central ~/.agents/skills/
      const skillItems = [...newItems, ...existingItems].filter((i) => i.type === 'skill');
      if (skillItems.length > 0) {
        const skillSpinner = ora('Installing skills to central storage...').start();
        for (const item of skillItems) {
          const decision = item.isNew ? 'overwrite' : decisions.get(`skill:${item.name}`);
          if (decision === 'skip') {
            skipped.skills++;
            continue;
          }

          const skill = allSkills.find((s) => s.name === item.name);
          if (skill) {
            const result = installSkillCentrally(skill.path, skill.name);
            if (result.success) installed.skills++;
          }
        }
        if (skipped.skills > 0) {
          skillSpinner.succeed(`Installed ${installed.skills} skills (skipped ${skipped.skills})`);
        } else if (installed.skills > 0) {
          skillSpinner.succeed(`Installed ${installed.skills} skills`);
        } else {
          skillSpinner.info('No skills to install');
        }
      }

      // Install hooks to central ~/.agents/hooks/
      const hookItems = [...newItems, ...existingItems].filter((i) => i.type === 'hook');
      if (hookItems.length > 0) {
        const hookSpinner = ora('Installing hooks to central storage...').start();
        const result = await installHooksCentrally(localPath);
        if (result.installed.length > 0) {
          hookSpinner.succeed(`Installed ${result.installed.length} hooks`);
          installed.hooks = result.installed.length;
        } else {
          hookSpinner.info('No hooks to install');
        }
      }

      // Register MCP servers
      const mcpItems = [...newItems, ...existingItems].filter((i) => i.type === 'mcp');
      if (mcpItems.length > 0 && manifest?.mcp) {
        const mcpSpinner = ora('Registering MCP servers...').start();
        for (const item of mcpItems) {
          const decision = item.isNew ? 'overwrite' : decisions.get(`mcp:${item.name}`);
          if (decision === 'skip') {
            skipped.mcps++;
            continue;
          }

          const config = manifest.mcp[item.name];
          if (!config || !config.command) continue;

          for (const agentId of item.agents) {
            if (!item.isNew) {
              const vl = agentVersionSelections.get(agentId) || [];
              if (vl.length > 0) {
                for (const ver of vl) {
                  const home = getVersionHomePath(agentId, ver);
                  const binary = getBinaryPath(agentId, ver);
                  await unregisterMcp(agentId, item.name, { home, binary });
                }
              } else {
                await unregisterMcp(agentId, item.name);
              }
            }
            const versionsList = agentVersionSelections.get(agentId) || [];
            if (versionsList.length > 0) {
              // Version-managed: register MCP into each selected version's HOME
              // Use the actual binary to bypass the shim (shim uses $HOME/.agents which breaks with HOME override)
              for (const ver of versionsList) {
                const home = getVersionHomePath(agentId, ver);
                const binary = getBinaryPath(agentId, ver);
                const result = await registerMcp(agentId, item.name, config.command, config.scope, config.transport || 'stdio', { home, binary });
                if (result.success) {
                  installed.mcps++;
                } else {
                  mcpSpinner.stop();
                  console.log(chalk.yellow(`  Warning: ${item.name} (${AGENTS[agentId].name}@${ver}): ${result.error}`));
                  mcpSpinner.start();
                }
              }
            } else {
              // Not version-managed: register normally to ~/.{agent}/
              const result = await registerMcp(agentId, item.name, config.command, config.scope, config.transport || 'stdio');
              if (result.success) {
                installed.mcps++;
              } else {
                mcpSpinner.stop();
                console.log(chalk.yellow(`  Warning: ${item.name} (${AGENTS[agentId].name}): ${result.error}`));
                mcpSpinner.start();
              }
            }
          }
        }
        if (skipped.mcps > 0) {
          mcpSpinner.succeed(`Registered ${installed.mcps} MCP servers (skipped ${skipped.mcps})`);
        } else if (installed.mcps > 0) {
          mcpSpinner.succeed(`Registered ${installed.mcps} MCP servers`);
        } else {
          mcpSpinner.info('No MCP servers to register');
        }
      }

      // --clean: remove MCPs not in manifest
      if (options.clean && manifest?.mcp) {
        const manifestMcpNames = new Set(Object.keys(manifest.mcp));
        let removed = 0;

        for (const agentId of selectedAgents) {
          const versionsList = agentVersionSelections.get(agentId) || [];

          if (versionsList.length > 0) {
            for (const ver of versionsList) {
              const home = getVersionHomePath(agentId, ver);
              const configPath = getMcpConfigPathForHome(agentId, home);
              const installedMcps = parseMcpConfig(agentId, configPath);
              const binary = getBinaryPath(agentId, ver);

              for (const name of Object.keys(installedMcps)) {
                if (!manifestMcpNames.has(name)) {
                  await unregisterMcp(agentId, name, { home, binary });
                  removed++;
                }
              }
            }
          } else {
            const installedList = listInstalledMcpsWithScope(agentId);
            for (const mcp of installedList.filter(m => m.scope === 'user')) {
              if (!manifestMcpNames.has(mcp.name)) {
                await unregisterMcp(agentId, mcp.name);
                removed++;
              }
            }
          }
        }

        if (removed > 0) {
          console.log(chalk.green(`  Removed ${removed} MCP servers not in repo`));
        }
      }

      // Install memory files to central ~/.agents/memory/
      const memoryItems = [...newItems, ...existingItems].filter((i) => i.type === 'memory');
      if (memoryItems.length > 0) {
        const memoryNames = [...new Set(memoryItems.map((item) => item.name))];
        const selectedMemoryNames = memoryNames.filter((name) => {
          const memoryItem = memoryItems.find((item) => item.name === name);
          if (!memoryItem || memoryItem.isNew) return true;
          const decision = decisions.get(`memory:${name}`);
          return decision !== 'skip';
        });

        skipped.memory = memoryNames.length - selectedMemoryNames.length;

        if (selectedMemoryNames.length === 0) {
          const instrSpinner = ora('Installing memory files to central storage...').start();
          instrSpinner.info('No memory files to install');
        } else {
          const instrSpinner = ora('Installing memory files to central storage...').start();
          const memResult = installInstructionsCentrally(localPath, selectedMemoryNames);
          if (memResult.installed.length > 0) {
            if (skipped.memory > 0) {
              instrSpinner.succeed(`Installed ${memResult.installed.length} memory files (skipped ${skipped.memory})`);
            } else {
              instrSpinner.succeed(`Installed ${memResult.installed.length} memory files`);
            }
            installed.memory = memResult.installed.length;
          } else {
            instrSpinner.info('No memory files to install');
          }
        }
      }

      // Install jobs
      const jobItems = [...newItems, ...existingItems].filter((i) => i.type === 'job');
      if (jobItems.length > 0) {
        const jobSpinner = ora('Installing jobs...').start();
        for (const item of jobItems) {
          const decision = item.isNew ? 'overwrite' : decisions.get(`job:${item.name}`);
          if (decision === 'skip') {
            skipped.jobs++;
            continue;
          }

          const discovered = allDiscoveredJobs.find((j) => j.name === item.name);
          if (discovered) {
            const result = installJobFromSource(discovered.path, discovered.name);
            if (result.success) {
              installed.jobs++;
            } else {
              console.log(chalk.yellow(`\n  Warning: job ${item.name}: ${result.error}`));
            }
          }
        }
        if (skipped.jobs > 0) {
          jobSpinner.succeed(`Installed ${installed.jobs} jobs (skipped ${skipped.jobs})`);
        } else if (installed.jobs > 0) {
          jobSpinner.succeed(`Installed ${installed.jobs} jobs`);
        } else {
          jobSpinner.info('No jobs to install');
        }

        if (installed.jobs > 0 && isDaemonRunning()) {
          signalDaemonReload();
        }
      }

      // Install drives
      const driveItems = [...newItems, ...existingItems].filter((i) => i.type === 'drive');
      if (driveItems.length > 0) {
        const driveSpinner = ora('Installing drives...').start();
        for (const item of driveItems) {
          const decision = item.isNew ? 'overwrite' : decisions.get(`drive:${item.name}`);
          if (decision === 'skip') {
            skipped.drives++;
            continue;
          }

          const discovered = allDiscoveredDrives.find((d) => d.name === item.name);
          if (discovered) {
            const result = installDriveFromSource(discovered.path, discovered.name);
            if (result.success) {
              installed.drives++;
            } else {
              console.log(chalk.yellow(`\n  Warning: drive ${item.name}: ${result.error}`));
            }
          }
        }
        if (skipped.drives > 0) {
          driveSpinner.succeed(`Installed ${installed.drives} drives (skipped ${skipped.drives})`);
        } else if (installed.drives > 0) {
          driveSpinner.succeed(`Installed ${installed.drives} drives`);
        } else {
          driveSpinner.info('No drives to install');
        }
      }

      // Sync central resources into version-managed agent homes
      const versionSyncedAgents: string[] = [];
      for (const agentId of selectedAgents) {
        const versionsList = agentVersionSelections.get(agentId) || [];
        for (const ver of versionsList) {
          syncResourcesToVersion(agentId, ver);
          versionSyncedAgents.push(`${AGENTS[agentId].name}@${ver}`);
        }
      }
      if (versionSyncedAgents.length > 0) {
        const syncSpinner = ora('Linking resources to version homes...').start();
        syncSpinner.succeed(`Linked resources to ${versionSyncedAgents.join(', ')}`);
      }

      // Update scope config
      if (!isReadonly) {
        const priority = getRepoPriority(effectiveRepo);
        setRepo(effectiveRepo, {
          source: targetSource,
          branch: parsed.ref || 'main',
          commit,
          lastSync: new Date().toISOString(),
          priority,
          readonly: false,
        });
      }

      console.log(chalk.green(`\nPull complete`));
    } catch (err) {
      if (isPromptCancelled(err)) {
        console.log(chalk.yellow('\nCancelled'));
        process.exit(0);
      }
      spinner.fail('Failed to sync');
      console.error(chalk.red((err as Error).message));
      process.exit(1);
    }
  });

// =============================================================================
// PUSH COMMAND
// =============================================================================

program
  .command('push')
  .description('Export local config and push to your .agents repo')
  .option('-s, --scope <scope>', 'Target repo name', 'user')
  .option('--export-only', 'Export to local repo only (skip git push)')
  .option('-m, --message <msg>', 'Commit message', 'Update agent configuration')
  .action(async (options) => {
    try {
      const repoName = options.scope as RepoName;
      const repoConfig = getRepo(repoName);

      if (!repoConfig) {
        console.log(chalk.red(`Repo '${repoName}' not configured.`));
        console.log(chalk.gray('  Run: agents pull'));
        process.exit(1);
      }

      if (repoConfig.readonly) {
        console.log(chalk.red(`Repo '${repoName}' is readonly. Cannot push.`));
        process.exit(1);
      }

      const localPath = getRepoLocalPath(repoConfig.source);
      const manifest = readManifest(localPath) || createDefaultManifest();

      console.log(chalk.bold('\nExporting local configuration...\n'));

      const cliStates = await getAllCliStates();
      let exported = 0;

      for (const agentId of ALL_AGENT_IDS) {
        const agent = AGENTS[agentId];
        const cli = cliStates[agentId];

        if (cli?.installed && cli.version) {
          manifest.agents = manifest.agents || {};
          manifest.agents[agentId] = cli.version;
          console.log(`  ${chalk.green('+')} ${agent.name} @ ${cli.version}`);
          exported++;
        }
      }

      // Export MCP servers from installed agents
      console.log();
      let mcpExported = 0;
      const mcpByName = new Map<string, { command: string; agents: AgentId[] }>();

      for (const agentId of MCP_CAPABLE_AGENTS) {
        if (!cliStates[agentId]?.installed) continue;

        const mcps = listInstalledMcpsWithScope(agentId);
        for (const mcp of mcps) {
          if (mcp.scope !== 'user') continue; // Only export user-scoped MCPs

          const existing = mcpByName.get(mcp.name);
          if (existing) {
            if (!existing.agents.includes(agentId)) {
              existing.agents.push(agentId);
            }
          } else {
            mcpByName.set(mcp.name, {
              command: mcp.command || '',
              agents: [agentId],
            });
          }
        }
      }

      if (mcpByName.size > 0) {
        manifest.mcp = manifest.mcp || {};
        for (const [name, config] of mcpByName) {
          manifest.mcp[name] = {
            command: config.command,
            transport: 'stdio',
            agents: config.agents,
            scope: 'user',
          };
          console.log(`  ${chalk.green('+')} MCP: ${name} (${config.agents.map((id) => AGENTS[id].name).join(', ')})`);
          mcpExported++;
        }
      }

      writeManifest(localPath, manifest);
      console.log(chalk.bold(`\nUpdated ${MANIFEST_FILENAME}`));

      if (options.exportOnly) {
        console.log(chalk.bold('\nExport complete. Changes saved locally.'));
        console.log(chalk.gray(`  Path: ${localPath}`));
        return;
      }

      // Check if there are changes to push
      const hasChanges = await hasUncommittedChanges(localPath);
      if (!hasChanges) {
        console.log(chalk.green('\nNo changes to push.'));
        return;
      }

      // Get GitHub username
      const spinner = ora('Checking GitHub authentication...').start();
      const username = await getGitHubUsername();

      if (!username) {
        spinner.fail('GitHub CLI not authenticated');
        console.log(chalk.yellow('\nTo push changes, authenticate with GitHub:'));
        console.log(chalk.gray('  gh auth login'));
        console.log(chalk.gray('\nOr push manually:'));
        console.log(chalk.gray(`  cd ${localPath}`));
        console.log(chalk.gray('  git add -A && git commit -m "Update" && git push'));
        return;
      }

      spinner.text = 'Checking remote configuration...';

      // Check if remote is set to user's repo
      const currentRemote = await getRemoteUrl(localPath);
      const userRepoUrl = `https://github.com/${username}/.agents.git`;
      const isUserRepo = currentRemote?.includes(`${username}/.agents`);

      if (!isUserRepo) {
        // Check if user's repo exists on GitHub
        spinner.text = `Checking if ${username}/.agents exists...`;
        const repoExists = await checkGitHubRepoExists(username, '.agents');

        if (!repoExists) {
          spinner.fail(`Repository ${username}/.agents does not exist`);
          console.log(chalk.yellow('\nCreate your .agents repo on GitHub:'));
          console.log(chalk.cyan(`  gh repo create .agents --public --description "My agent configurations"`));
          console.log(chalk.gray('\nThen run: agents push'));
          return;
        }

        // Update remote to user's repo
        spinner.text = `Switching remote to ${username}/.agents...`;
        await setRemoteUrl(localPath, userRepoUrl);
      }

      // Commit and push
      spinner.text = 'Pushing changes...';
      const result = await commitAndPush(localPath, options.message);

      if (result.success) {
        spinner.succeed(`Pushed to ${username}/.agents`);
        console.log(chalk.green(`\nView: https://github.com/${username}/.agents`));
      } else {
        spinner.fail('Failed to push');
        console.log(chalk.red(result.error || 'Unknown error'));

        if (result.error?.includes('rejected')) {
          console.log(chalk.yellow('\nTry pulling first: agents pull'));
        }
      }
    } catch (err) {
      if (isPromptCancelled(err)) {
        console.log(chalk.yellow('\nCancelled'));
        process.exit(0);
      }
      console.error(chalk.red((err as Error).message));
      process.exit(1);
    }
  });

// =============================================================================
// COMMANDS COMMANDS
// =============================================================================

const commandsCmd = program
  .command('commands')
  .description('Manage slash commands');

commandsCmd
  .command('list [agent]')
  .description('List installed commands')
  .option('-a, --agent <agent>', 'Filter by agent')
  .option('-s, --scope <scope>', 'Filter by scope: user, project, or all', 'all')
  .action(async (agentArg, options) => {
    const spinner = ora({ text: 'Loading...', isSilent: !process.stdout.isTTY }).start();
    const cwd = process.cwd();

    // Resolve agent filter - positional arg takes precedence over -a flag
    const agentInput = agentArg || options.agent;
    let agents: AgentId[];
    if (agentInput) {
      const resolved = resolveAgentName(agentInput);
      if (!resolved) {
        spinner.stop();
        console.log(chalk.red(`Unknown agent '${agentInput}'. Use ${ALL_AGENT_IDS.join(', ')}`));
        process.exit(1);
      }
      agents = [resolved];
    } else {
      agents = ALL_AGENT_IDS;
    }
    const showPaths = !!agentInput;

    // Collect all data while spinner is active
    const agentCommands = agents.map((agentId) => ({
      agent: AGENTS[agentId],
      commands: listInstalledCommandsWithScope(agentId, cwd).filter(
        (c) => options.scope === 'all' || c.scope === options.scope
      ),
    }));

    spinner.stop();
    console.log(chalk.bold('Installed Commands\n'));

    for (const { agent, commands } of agentCommands) {
      if (commands.length === 0) {
        console.log(`  ${chalk.bold(agent.name)}: ${chalk.gray('none')}`);
      } else {
        console.log(`  ${chalk.bold(agent.name)}:`);

        const userCommands = commands.filter((c) => c.scope === 'user');
        const projectCommands = commands.filter((c) => c.scope === 'project');

        if (userCommands.length > 0 && (options.scope === 'all' || options.scope === 'user')) {
          console.log(`    ${chalk.gray('User:')}`);
          for (const cmd of userCommands) {
            const desc = cmd.description ? ` - ${chalk.gray(cmd.description)}` : '';
            console.log(`      ${chalk.cyan(cmd.name)}${desc}`);
            if (showPaths) console.log(chalk.gray(`        ${cmd.path}`));
          }
        }

        if (projectCommands.length > 0 && (options.scope === 'all' || options.scope === 'project')) {
          console.log(`    ${chalk.gray('Project:')}`);
          for (const cmd of projectCommands) {
            const desc = cmd.description ? ` - ${chalk.gray(cmd.description)}` : '';
            console.log(`      ${chalk.yellow(cmd.name)}${desc}`);
            if (showPaths) console.log(chalk.gray(`        ${cmd.path}`));
          }
        }
      }
      console.log();
    }
  });

commandsCmd
  .command('add <source>')
  .description('Install commands from a repo or local path')
  .option('-a, --agents <list>', 'Comma-separated agents to install to')
  .action(async (source: string, options) => {
    const spinner = ora('Fetching commands...').start();

    try {
      const { localPath } = await cloneRepo(source);
      const commands = discoverCommands(localPath);
      spinner.succeed(`Found ${commands.length} commands`);

      const agents = options.agents
        ? (options.agents.split(',') as AgentId[])
        : ALL_AGENT_IDS;

      const cliStates = await getAllCliStates();
      for (const command of commands) {
        console.log(`\n  ${chalk.cyan(command.name)}: ${command.description}`);

        for (const agentId of agents) {
          if (!cliStates[agentId]?.installed && agentId !== 'cursor') continue;

          const sourcePath = resolveCommandSource(localPath, command.name, agentId);
          if (sourcePath) {
            const result = installCommand(sourcePath, agentId, command.name, 'symlink');
            if (result.error) {
              console.log(`    ${chalk.yellow('!')} ${AGENTS[agentId].name}: ${result.error}`);
            } else {
              console.log(`    ${chalk.green('+')} ${AGENTS[agentId].name}`);
            }
          }
        }
      }

      console.log(chalk.green('\nCommands installed.'));
    } catch (err) {
      spinner.fail('Failed to add commands');
      console.error(chalk.red((err as Error).message));
      process.exit(1);
    }
  });

commandsCmd
  .command('remove <name>')
  .description('Remove a command')
  .option('-a, --agents <list>', 'Comma-separated agents to remove from')
  .action((name: string, options) => {
    const agents = options.agents
      ? (options.agents.split(',') as AgentId[])
      : ALL_AGENT_IDS;

    let removed = 0;
    for (const agentId of agents) {
      if (uninstallCommand(agentId, name)) {
        console.log(`  ${chalk.red('-')} ${AGENTS[agentId].name}`);
        removed++;
      }
    }

    if (removed === 0) {
      console.log(chalk.yellow(`Command '${name}' not found`));
    } else {
      console.log(chalk.green(`\nRemoved from ${removed} agents.`));
    }
  });

commandsCmd
  .command('push <name>')
  .description('Promote a project command to user scope')
  .option('-a, --agents <list>', 'Comma-separated agents to push for')
  .action(async (name: string, options) => {
    const cwd = process.cwd();
    const agents = options.agents
      ? (options.agents.split(',') as AgentId[])
      : ALL_AGENT_IDS;

    const cliStates = await getAllCliStates();
    let pushed = 0;
    for (const agentId of agents) {
      if (!cliStates[agentId]?.installed && agentId !== 'cursor') continue;

      const result = promoteCommandToUser(agentId, name, cwd);
      if (result.success) {
        console.log(`  ${chalk.green('+')} ${AGENTS[agentId].name}`);
        pushed++;
      } else if (result.error && !result.error.includes('not found')) {
        console.log(`  ${chalk.red('x')} ${AGENTS[agentId].name}: ${result.error}`);
      }
    }

    if (pushed === 0) {
      console.log(chalk.yellow(`Project command '${name}' not found for any agent`));
    } else {
      console.log(chalk.green(`\nPushed to user scope for ${pushed} agents.`));
    }
  });

const hooksCmd = program.command('hooks').description('Manage agent hooks');

hooksCmd
  .command('list')
  .description('List installed hooks')
  .option('-a, --agent <agent>', 'Filter by agent')
  .option('-s, --scope <scope>', 'Filter by scope: user, project, or all', 'all')
  .action(async (options) => {
    const spinner = ora({ text: 'Loading...', isSilent: !process.stdout.isTTY }).start();
    const cwd = process.cwd();

    const agents = options.agent
      ? [options.agent as AgentId]
      : (Array.from(HOOKS_CAPABLE_AGENTS) as AgentId[]);

    // Collect all data while spinner is active
    const agentHooks = agents.map((agentId) => ({
      agent: AGENTS[agentId],
      hooks: AGENTS[agentId].supportsHooks
        ? listInstalledHooksWithScope(agentId, cwd).filter(
            (h) => options.scope === 'all' || h.scope === options.scope
          )
        : null,
    }));

    spinner.stop();
    console.log(chalk.bold('Installed Hooks\n'));

    for (const { agent, hooks } of agentHooks) {
      if (hooks === null) {
        console.log(`  ${chalk.bold(agent.name)}: ${chalk.gray('hooks not supported')}`);
        console.log();
        continue;
      }

      if (hooks.length === 0) {
        console.log(`  ${chalk.bold(agent.name)}: ${chalk.gray('none')}`);
      } else {
        console.log(`  ${chalk.bold(agent.name)}:`);

        const userHooks = hooks.filter((h) => h.scope === 'user');
        const projectHooks = hooks.filter((h) => h.scope === 'project');

        if (userHooks.length > 0 && (options.scope === 'all' || options.scope === 'user')) {
          console.log(`    ${chalk.gray('User:')}`);
          for (const hook of userHooks) {
            console.log(`      ${chalk.cyan(hook.name)}`);
          }
        }

        if (projectHooks.length > 0 && (options.scope === 'all' || options.scope === 'project')) {
          console.log(`    ${chalk.gray('Project:')}`);
          for (const hook of projectHooks) {
            console.log(`      ${chalk.yellow(hook.name)}`);
          }
        }
      }
      console.log();
    }
  });

hooksCmd
  .command('add <source>')
  .description('Install hooks from a repo or local path')
  .option('-a, --agent <agents>', 'Target agents (comma-separated)', 'claude,gemini')
  .action(async (source: string, options) => {
    const spinner = ora('Fetching hooks...').start();

    try {
      const { localPath } = await cloneRepo(source);
      const hooks = discoverHooksFromRepo(localPath);
      const hookNames = new Set<string>();
      for (const name of hooks.shared) {
        hookNames.add(name);
      }
      for (const list of Object.values(hooks.agentSpecific)) {
        for (const name of list) {
          hookNames.add(name);
        }
      }
      spinner.succeed(`Found ${hookNames.size} hooks`);

      const agents = options.agent
        ? (options.agent.split(',') as AgentId[])
        : (['claude', 'gemini'] as AgentId[]);

      const result = await installHooks(localPath, agents, { scope: 'user' });
      const installedByHook = new Map<string, AgentId[]>();
      for (const item of result.installed) {
        const [name, agentId] = item.split(':') as [string, AgentId];
        const list = installedByHook.get(name) || [];
        list.push(agentId);
        installedByHook.set(name, list);
      }

      const orderedHooks = Array.from(installedByHook.keys()).sort((a, b) => a.localeCompare(b));
      for (const name of orderedHooks) {
        console.log(`\n  ${chalk.cyan(name)}`);
        const agentIds = installedByHook.get(name) || [];
        agentIds.sort();
        for (const agentId of agentIds) {
          console.log(`    ${AGENTS[agentId].name}`);
        }
      }

      if (result.errors.length > 0) {
        console.log(chalk.red('\nErrors:'));
        for (const error of result.errors) {
          console.log(chalk.red(`  ${error}`));
        }
      }

      if (result.installed.length === 0) {
        console.log(chalk.yellow('\nNo hooks installed.'));
      } else {
        console.log(chalk.green('\nHooks installed.'));
      }
    } catch (err) {
      spinner.fail('Failed to add hooks');
      console.error(chalk.red((err as Error).message));
      process.exit(1);
    }
  });

hooksCmd
  .command('remove <name>')
  .description('Remove a hook')
  .option('-a, --agent <agents>', 'Target agents (comma-separated)')
  .action(async (name: string, options) => {
    const agents = options.agent
      ? (options.agent.split(',') as AgentId[])
      : (Array.from(HOOKS_CAPABLE_AGENTS) as AgentId[]);

    const result = await removeHook(name, agents);
    let removed = 0;
    for (const item of result.removed) {
      const [, agentId] = item.split(':') as [string, AgentId];
      console.log(`  ${AGENTS[agentId].name}`);
      removed++;
    }

    if (result.errors.length > 0) {
      console.log(chalk.red('\nErrors:'));
      for (const error of result.errors) {
        console.log(chalk.red(`  ${error}`));
      }
    }

    if (removed === 0) {
      console.log(chalk.yellow(`Hook '${name}' not found`));
    } else {
      console.log(chalk.green(`\nRemoved from ${removed} agents.`));
    }
  });

hooksCmd
  .command('push <name>')
  .description('Promote a project hook to user scope')
  .option('-a, --agent <agents>', 'Target agents (comma-separated)')
  .action((name: string, options) => {
    const cwd = process.cwd();
    const agents = options.agent
      ? (options.agent.split(',') as AgentId[])
      : (Array.from(HOOKS_CAPABLE_AGENTS) as AgentId[]);

    let pushed = 0;
    for (const agentId of agents) {
      const result = promoteHookToUser(agentId, name, cwd);
      if (result.success) {
        console.log(`  ${AGENTS[agentId].name}`);
        pushed++;
      } else if (result.error && !result.error.includes('not found')) {
        console.log(`  ${AGENTS[agentId].name}: ${result.error}`);
      }
    }

    if (pushed === 0) {
      console.log(chalk.yellow(`Project hook '${name}' not found for any agent`));
    } else {
      console.log(chalk.green(`\nPushed to user scope for ${pushed} agents.`));
    }
  });

// =============================================================================
// SKILLS COMMANDS (Agent Skills)
// =============================================================================

const skillsCmd = program
  .command('skills')
  .description('Manage skills (SKILL.md + rules/)');

skillsCmd
  .command('list [agent]')
  .description('List installed skills')
  .option('-a, --agent <agent>', 'Filter by agent')
  .option('-s, --scope <scope>', 'Filter by scope: user, project, or all', 'all')
  .action(async (agentArg, options) => {
    const spinner = ora({ text: 'Loading...', isSilent: !process.stdout.isTTY }).start();
    const cwd = process.cwd();

    // Resolve agent filter - positional arg takes precedence over -a flag
    const agentInput = agentArg || options.agent;
    let agents: AgentId[];
    if (agentInput) {
      const resolved = resolveAgentName(agentInput);
      if (!resolved) {
        spinner.stop();
        console.log(chalk.red(`Unknown agent '${agentInput}'. Use ${ALL_AGENT_IDS.join(', ')}`));
        process.exit(1);
      }
      agents = [resolved];
    } else {
      agents = SKILLS_CAPABLE_AGENTS;
    }
    const showPaths = !!agentInput;

    // Collect all data while spinner is active
    const agentSkills = agents.map((agentId) => ({
      agent: AGENTS[agentId],
      skills: AGENTS[agentId].capabilities.skills
        ? listInstalledSkillsWithScope(agentId, cwd).filter(
            (s) => options.scope === 'all' || s.scope === options.scope
          )
        : null,
    }));

    spinner.stop();
    console.log(chalk.bold('Installed Agent Skills\n'));

    for (const { agent, skills } of agentSkills) {
      if (skills === null) {
        console.log(`  ${chalk.bold(agent.name)}: ${chalk.gray('skills not supported')}`);
        console.log();
        continue;
      }

      if (skills.length === 0) {
        console.log(`  ${chalk.bold(agent.name)}: ${chalk.gray('none')}`);
      } else {
        console.log(`  ${chalk.bold(agent.name)}:`);

        const userSkills = skills.filter((s) => s.scope === 'user');
        const projectSkills = skills.filter((s) => s.scope === 'project');

        if (userSkills.length > 0 && (options.scope === 'all' || options.scope === 'user')) {
          console.log(`    ${chalk.gray('User:')}`);
          for (const skill of userSkills) {
            const desc = skill.metadata.description ? ` - ${chalk.gray(skill.metadata.description)}` : '';
            const ruleInfo = skill.ruleCount > 0 ? chalk.gray(` (${skill.ruleCount} rules)`) : '';
            console.log(`      ${chalk.cyan(skill.name)}${desc}${ruleInfo}`);
            if (showPaths) console.log(chalk.gray(`        ${skill.path}`));
          }
        }

        if (projectSkills.length > 0 && (options.scope === 'all' || options.scope === 'project')) {
          console.log(`    ${chalk.gray('Project:')}`);
          for (const skill of projectSkills) {
            const desc = skill.metadata.description ? ` - ${chalk.gray(skill.metadata.description)}` : '';
            const ruleInfo = skill.ruleCount > 0 ? chalk.gray(` (${skill.ruleCount} rules)`) : '';
            console.log(`      ${chalk.yellow(skill.name)}${desc}${ruleInfo}`);
            if (showPaths) console.log(chalk.gray(`        ${skill.path}`));
          }
        }
      }
      console.log();
    }
  });

skillsCmd
  .command('add <source>')
  .description('Install skills from a repo or local path')
  .option('-a, --agents <list>', 'Comma-separated agents to install to')
  .action(async (source: string, options) => {
    const spinner = ora('Fetching skills...').start();

    try {
      const { localPath } = await cloneRepo(source);
      const skills = discoverSkillsFromRepo(localPath);
      spinner.succeed(`Found ${skills.length} skills`);

      if (skills.length === 0) {
        console.log(chalk.yellow('No skills found (looking for SKILL.md files)'));
        return;
      }

      for (const skill of skills) {
        console.log(`\n  ${chalk.cyan(skill.name)}: ${skill.metadata.description || 'no description'}`);
        if (skill.ruleCount > 0) {
          console.log(`    ${chalk.gray(`${skill.ruleCount} rules`)}`);
        }
      }

      const cliStates = await getAllCliStates();
      const agents = options.agents
        ? (options.agents.split(',') as AgentId[])
        : await checkbox({
            message: 'Select agents to install skills to:',
            choices: SKILLS_CAPABLE_AGENTS.filter((id) => cliStates[id]?.installed || id === 'cursor').map((id) => ({
              name: AGENTS[id].name,
              value: id,
              checked: true,
            })),
          });

      if (agents.length === 0) {
        console.log(chalk.yellow('\nNo agents selected.'));
        return;
      }

      const installSpinner = ora('Installing skills...').start();
      let installed = 0;

      for (const skill of skills) {
        const result = installSkill(skill.path, skill.name, agents);
        if (result.success) {
          installed++;
        } else {
          console.log(chalk.red(`\n  Failed to install ${skill.name}: ${result.error}`));
        }
      }

      installSpinner.succeed(`Installed ${installed} skills to ${agents.length} agents`);
      console.log(chalk.green('\nSkills installed.'));
    } catch (err) {
      spinner.fail('Failed to add skills');
      console.error(chalk.red((err as Error).message));
      process.exit(1);
    }
  });

skillsCmd
  .command('remove <name>')
  .description('Remove a skill')
  .action((name: string) => {
    const result = uninstallSkill(name);
    if (result.success) {
      console.log(chalk.green(`Removed skill '${name}'`));
    } else {
      console.log(chalk.red(result.error || 'Failed to remove skill'));
    }
  });

skillsCmd
  .command('push <name>')
  .description('Promote a project skill to user scope')
  .option('-a, --agents <list>', 'Comma-separated agents to push for')
  .action((name: string, options) => {
    const cwd = process.cwd();
    const agents = options.agents
      ? (options.agents.split(',') as AgentId[])
      : SKILLS_CAPABLE_AGENTS;

    let pushed = 0;
    for (const agentId of agents) {
      if (!AGENTS[agentId].capabilities.skills) continue;

      const result = promoteSkillToUser(agentId, name, cwd);
      if (result.success) {
        console.log(`  ${chalk.green('+')} ${AGENTS[agentId].name}`);
        pushed++;
      } else if (result.error && !result.error.includes('not found')) {
        console.log(`  ${chalk.red('x')} ${AGENTS[agentId].name}: ${result.error}`);
      }
    }

    if (pushed === 0) {
      console.log(chalk.yellow(`Project skill '${name}' not found for any agent`));
    } else {
      console.log(chalk.green(`\nPushed to user scope for ${pushed} agents.`));
    }
  });

skillsCmd
  .command('view [name]')
  .alias('info')
  .description('Show installed skill details')
  .action(async (name?: string) => {
    // If no name provided, show interactive select
    if (!name) {
      const cwd = process.cwd();
      const allSkills: Array<{ name: string; description: string }> = [];
      const seenNames = new Set<string>();

      for (const agentId of SKILLS_CAPABLE_AGENTS) {
        const skills = listInstalledSkillsWithScope(agentId, cwd);
        for (const skill of skills) {
          if (!seenNames.has(skill.name)) {
            seenNames.add(skill.name);
            allSkills.push({
              name: skill.name,
              description: skill.metadata.description || '',
            });
          }
        }
      }

      if (allSkills.length === 0) {
        console.log(chalk.yellow('No skills installed'));
        return;
      }

      try {
        name = await select({
          message: 'Select a skill to view',
          choices: allSkills.map((s) => {
            const maxDescLen = Math.max(0, 70 - s.name.length);
            const desc = s.description.length > maxDescLen
              ? s.description.slice(0, maxDescLen - 3) + '...'
              : s.description;
            return {
              value: s.name,
              name: desc ? `${s.name} - ${desc}` : s.name,
            };
          }),
        });
      } catch (err) {
        if (isPromptCancelled(err)) {
          console.log(chalk.gray('Cancelled'));
          return;
        }
        throw err;
      }
    }

    const skill = getSkillInfo(name);
    if (!skill) {
      console.log(chalk.yellow(`Skill '${name}' not found`));
      return;
    }

    // Build output
    const lines: string[] = [];
    lines.push(chalk.bold(`\n${skill.metadata.name}\n`));
    if (skill.metadata.description) {
      lines.push(`  ${skill.metadata.description}`);
    }
    lines.push('');
    if (skill.metadata.author) {
      lines.push(`  Author: ${skill.metadata.author}`);
    }
    if (skill.metadata.version) {
      lines.push(`  Version: ${skill.metadata.version}`);
    }
    if (skill.metadata.license) {
      lines.push(`  License: ${skill.metadata.license}`);
    }
    lines.push(`  Path: ${skill.path}`);

    const rules = getSkillRules(name);
    if (rules.length > 0) {
      lines.push(chalk.bold(`\n  Rules (${rules.length}):\n`));
      for (const rule of rules) {
        lines.push(`    ${chalk.cyan(rule)}`);
      }
    }
    lines.push('');

    const output = lines.join('\n');

    // Pipe through less for scrolling (q to quit)
    const { spawnSync } = await import('child_process');
    const less = spawnSync('less', ['-R'], {
      input: output,
      stdio: ['pipe', 'inherit', 'inherit'],
    });

    // Fallback to direct output if less fails
    if (less.status !== 0) {
      console.log(output);
    }
  });

// =============================================================================
// MEMORY COMMANDS
// =============================================================================

const memoryCmd = program
  .command('memory')
  .description('Manage agent memory files');

memoryCmd
  .command('list [agent]')
  .description('List installed memory files')
  .option('-a, --agent <agent>', 'Filter by agent')
  .action(async (agentArg, options) => {
    const cwd = process.cwd();

    // Resolve agent filter - positional arg takes precedence over -a flag
    const agentInput = agentArg || options.agent;
    let agents: AgentId[];
    if (agentInput) {
      const resolved = resolveAgentName(agentInput);
      if (!resolved) {
        console.log(chalk.red(`Unknown agent '${agentInput}'. Use ${ALL_AGENT_IDS.join(', ')}`));
        process.exit(1);
      }
      agents = [resolved];
    } else {
      agents = ALL_AGENT_IDS;
    }
    const showPaths = !!agentInput;

    console.log(chalk.bold('Installed Memory\n'));

    for (const agentId of agents) {
      const agent = AGENTS[agentId];
      const installed = listInstalledInstructionsWithScope(agentId, cwd);
      const userInstr = installed.find((i) => i.scope === 'user');
      const projectInstr = installed.find((i) => i.scope === 'project');

      const userStatus = userInstr?.exists ? chalk.green(agent.instructionsFile) : chalk.gray('none');
      const projectStatus = projectInstr?.exists ? chalk.yellow(agent.instructionsFile) : chalk.gray('none');

      console.log(`  ${chalk.bold(agent.name)}:`);
      console.log(`    ${chalk.gray('User:')} ${userStatus}`);
      if (showPaths && userInstr?.exists) console.log(chalk.gray(`        ${userInstr.path}`));
      console.log(`    ${chalk.gray('Project:')} ${projectStatus}`);
      if (showPaths && projectInstr?.exists) console.log(chalk.gray(`        ${projectInstr.path}`));
      console.log();
    }
  });

memoryCmd
  .command('view [agent]')
  .alias('show')
  .description('Show memory content for an agent')
  .option('-s, --scope <scope>', 'Scope: user or project', 'user')
  .action(async (agentArg?: string, options?: { scope?: string }) => {
    const cwd = process.cwd();
    let agentId: AgentId | undefined;

    if (agentArg) {
      agentId = resolveAgentName(agentArg) || undefined;
      if (!agentId) {
        console.log(chalk.red(`Unknown agent: ${agentArg}`));
        process.exit(1);
      }
    } else {
      const choices = ALL_AGENT_IDS.filter((id) => instructionsExists(id, 'user', cwd) || instructionsExists(id, 'project', cwd));
      if (choices.length === 0) {
        console.log(chalk.yellow('No memory files found.'));
        return;
      }
      agentId = await select({
        message: 'Select agent:',
        choices: choices.map((id) => ({ name: AGENTS[id].name, value: id })),
      });
    }

    const scope = (options?.scope || 'user') as 'user' | 'project';
    const content = getInstructionsContent(agentId, scope, cwd);

    if (!content) {
      console.log(chalk.yellow(`No ${scope} memory found for ${AGENTS[agentId].name}`));
      return;
    }

    console.log(chalk.bold(`\n${AGENTS[agentId].name} Memory (${scope}):\n`));
    console.log(content);
  });

memoryCmd
  .command('diff [agent]')
  .description('Diff installed memory against repo')
  .action(async (agentArg?: string) => {
    const cwd = process.cwd();
    const meta = readMeta();
    const scopes = getReposByPriority();

    if (scopes.length === 0) {
      console.log(chalk.yellow('No repo configured. Run: agents repo add <source>'));
      return;
    }

    const agents = agentArg
      ? [resolveAgentName(agentArg)].filter(Boolean) as AgentId[]
      : ALL_AGENT_IDS;

    const diff = await import('diff');

    for (const { name: repoName, config } of scopes) {
      const localPath = getRepoLocalPath(config.source);
      const repoInstructions = discoverInstructionsFromRepo(localPath);

      for (const agentId of agents) {
        const repoInstr = repoInstructions.find((i) => i.agentId === agentId);
        if (!repoInstr) continue;

        const installedContent = getInstructionsContent(agentId, 'user', cwd);
        if (!installedContent) {
          console.log(`${chalk.bold(AGENTS[agentId].name)}: ${chalk.green('NEW')} (not installed)`);
          continue;
        }

        const repoContent = fs.readFileSync(repoInstr.sourcePath, 'utf-8');
        if (installedContent.trim() === repoContent.trim()) {
          console.log(`${chalk.bold(AGENTS[agentId].name)}: ${chalk.gray('up to date')}`);
          continue;
        }

        console.log(`${chalk.bold(AGENTS[agentId].name)}:`);
        const changes = diff.diffLines(installedContent, repoContent);
        for (const change of changes) {
          if (change.added) {
            process.stdout.write(chalk.green(change.value));
          } else if (change.removed) {
            process.stdout.write(chalk.red(change.value));
          }
        }
        console.log();
      }
    }
  });

memoryCmd
  .command('push <agent>')
  .description('Promote project memory to user scope')
  .action((agentArg: string) => {
    const cwd = process.cwd();
    const agentId = resolveAgentName(agentArg);

    if (!agentId) {
      console.log(chalk.red(`Unknown agent: ${agentArg}`));
      process.exit(1);
    }

    const result = promoteInstructionsToUser(agentId, cwd);
    if (result.success) {
      console.log(chalk.green(`Pushed ${AGENTS[agentId].instructionsFile} to user scope`));
    } else {
      console.log(chalk.red(result.error || 'Failed to push memory'));
    }
  });

memoryCmd
  .command('remove <agent>')
  .description('Remove user memory for an agent')
  .action((agentArg: string) => {
    const agentId = resolveAgentName(agentArg);

    if (!agentId) {
      console.log(chalk.red(`Unknown agent: ${agentArg}`));
      process.exit(1);
    }

    const result = uninstallInstructions(agentId);
    if (result) {
      console.log(chalk.green(`Removed ${AGENTS[agentId].instructionsFile}`));
    } else {
      console.log(chalk.yellow(`No memory file found for ${AGENTS[agentId].name}`));
    }
  });

// =============================================================================
// MCP COMMANDS
// =============================================================================

const mcpCmd = program
  .command('mcp')
  .description('Manage MCP servers');

mcpCmd
  .command('list [agent]')
  .description('List MCP servers and registration status')
  .option('-a, --agent <agent>', 'Filter by agent')
  .option('-s, --scope <scope>', 'Filter by scope: user, project, or all', 'all')
  .action(async (agentArg, options) => {
    const spinner = ora({ text: 'Loading...', isSilent: !process.stdout.isTTY }).start();
    const cwd = process.cwd();

    // Resolve agent filter - positional arg takes precedence over -a flag
    const agentInput = agentArg || options.agent;
    let agents: AgentId[];
    if (agentInput) {
      const resolved = resolveAgentName(agentInput);
      if (!resolved) {
        spinner.stop();
        console.log(chalk.red(`Unknown agent '${agentInput}'. Use ${ALL_AGENT_IDS.join(', ')}`));
        process.exit(1);
      }
      agents = [resolved];
    } else {
      agents = MCP_CAPABLE_AGENTS;
    }
    const showPaths = !!agentInput;

    // Collect all data while spinner is active
    const cliStates = await getAllCliStates();
    type McpData = {
      agent: typeof AGENTS[AgentId];
      mcps: ReturnType<typeof listInstalledMcpsWithScope> | null;
      notInstalled?: boolean;
    };
    const agentMcps: McpData[] = agents.map((agentId) => {
      const agent = AGENTS[agentId];
      if (!agent.capabilities.mcp) {
        return { agent, mcps: null };
      }
      if (!cliStates[agentId]?.installed) {
        return { agent, mcps: null, notInstalled: true };
      }
      return {
        agent,
        mcps: listInstalledMcpsWithScope(agentId, cwd).filter(
          (m) => options.scope === 'all' || m.scope === options.scope
        ),
      };
    });

    spinner.stop();
    console.log(chalk.bold('MCP Servers\n'));

    for (const { agent, mcps, notInstalled } of agentMcps) {
      if (mcps === null && notInstalled) {
        console.log(`  ${chalk.bold(agent.name)}: ${chalk.gray('CLI not installed')}`);
        continue;
      }
      if (mcps === null) {
        console.log(`  ${chalk.bold(agent.name)}: ${chalk.gray('mcp not supported')}`);
        console.log();
        continue;
      }

      if (mcps.length === 0) {
        console.log(`  ${chalk.bold(agent.name)}: ${chalk.gray('none')}`);
      } else {
        console.log(`  ${chalk.bold(agent.name)}:`);

        const userMcps = mcps.filter((m) => m.scope === 'user');
        const projectMcps = mcps.filter((m) => m.scope === 'project');

        if (userMcps.length > 0 && (options.scope === 'all' || options.scope === 'user')) {
          console.log(`    ${chalk.gray('User:')}`);
          for (const mcp of userMcps) {
            console.log(`      ${chalk.cyan(mcp.name)}`);
            if (showPaths && mcp.command) console.log(chalk.gray(`        ${mcp.command}`));
          }
        }

        if (projectMcps.length > 0 && (options.scope === 'all' || options.scope === 'project')) {
          console.log(`    ${chalk.gray('Project:')}`);
          for (const mcp of projectMcps) {
            console.log(`      ${chalk.yellow(mcp.name)}`);
            if (showPaths && mcp.command) console.log(chalk.gray(`        ${mcp.command}`));
          }
        }
      }
      console.log();
    }
  });

mcpCmd
  .command('add <name> [command_or_url...]')
  .description('Add an MCP server (stdio or HTTP)')
  .option('-a, --agents <list>', 'Comma-separated agents', MCP_CAPABLE_AGENTS.join(','))
  .option('-s, --scope <scope>', 'Scope: user or project', 'user')
  .option('-t, --transport <type>', 'Transport: stdio or http', 'stdio')
  .option('-H, --header <header>', 'HTTP header (name:value), can be repeated', (val, acc: string[]) => {
    acc.push(val);
    return acc;
  }, [])
  .action(async (name: string, commandOrUrl: string[], options) => {
    const transport = options.transport as 'stdio' | 'http';

    if (commandOrUrl.length === 0) {
      console.error(chalk.red('Error: Command or URL required'));
      console.log(chalk.gray('Stdio: agents mcp add <name> -- <command...>'));
      console.log(chalk.gray('HTTP:  agents mcp add <name> <url> --transport http'));
      process.exit(1);
    }

    const source = await ensureSource();
    const localPath = getRepoLocalPath(source);
    const manifest = readManifest(localPath) || createDefaultManifest();

    manifest.mcp = manifest.mcp || {};

    if (transport === 'http') {
      const url = commandOrUrl[0];
      const headers: Record<string, string> = {};

      if (options.header && options.header.length > 0) {
        for (const h of options.header) {
          const [key, ...valueParts] = h.split(':');
          if (key && valueParts.length > 0) {
            headers[key.trim()] = valueParts.join(':').trim();
          }
        }
      }

      manifest.mcp[name] = {
        url,
        transport: 'http',
        scope: options.scope as 'user' | 'project',
        agents: options.agents.split(',') as AgentId[],
        ...(Object.keys(headers).length > 0 && { headers }),
      };
    } else {
      const command = commandOrUrl.join(' ');
      manifest.mcp[name] = {
        command,
        transport: 'stdio',
        scope: options.scope as 'user' | 'project',
        agents: options.agents.split(',') as AgentId[],
      };
    }

    writeManifest(localPath, manifest);
    console.log(chalk.green(`Added MCP server '${name}' to manifest`));
    console.log(chalk.gray('Run: agents mcp register to apply'));
  });

mcpCmd
  .command('remove <name>')
  .description('Remove an MCP server from agents')
  .option('-a, --agents <list>', 'Comma-separated agents')
  .action(async (name: string, options) => {
    const agents = options.agents
      ? (options.agents.split(',') as AgentId[])
      : MCP_CAPABLE_AGENTS;

    const cliStates = await getAllCliStates();
    let removed = 0;
    for (const agentId of agents) {
      if (!cliStates[agentId]?.installed) continue;

      const result = await unregisterMcp(agentId, name);
      if (result.success) {
        console.log(`  ${chalk.red('-')} ${AGENTS[agentId].name}`);
        removed++;
      }
    }

    if (removed === 0) {
      console.log(chalk.yellow(`MCP '${name}' not found or not registered`));
    } else {
      console.log(chalk.green(`\nRemoved from ${removed} agents.`));
    }
  });

mcpCmd
  .command('register [name]')
  .description('Register MCP server(s) with agent CLIs')
  .option('-a, --agents <list>', 'Comma-separated agents')
  .action(async (name: string | undefined, options) => {
    if (!name) {
      const source = await ensureSource();
      const localPath = getRepoLocalPath(source);
      const manifest = readManifest(localPath);

      if (!manifest?.mcp) {
        console.log(chalk.yellow('No MCP servers in manifest'));
        return;
      }

      const cliStates = await getAllCliStates();
      for (const [mcpName, config] of Object.entries(manifest.mcp)) {
        // Skip HTTP transport MCPs for now (need different registration)
        if (config.transport === 'http' || !config.command) {
          console.log(`\n  ${chalk.cyan(mcpName)}: ${chalk.yellow('HTTP transport not yet supported')}`);
          continue;
        }

        console.log(`\n  ${chalk.cyan(mcpName)}:`);
        const mcpTargetAgents = config.agents?.length ? config.agents : MCP_CAPABLE_AGENTS;
        for (const agentId of mcpTargetAgents) {
          if (!cliStates[agentId]?.installed) continue;

          const result = await registerMcp(agentId, mcpName, config.command, config.scope, config.transport || 'stdio');
          if (result.success) {
            console.log(`    ${chalk.green('+')} ${AGENTS[agentId].name}`);
          } else {
            console.log(`    ${chalk.red('x')} ${AGENTS[agentId].name}: ${result.error}`);
          }
        }
      }
      return;
    }

    console.log(chalk.yellow('Single MCP registration not yet implemented'));
  });

mcpCmd
  .command('push <name>')
  .description('Promote a project MCP server to user scope')
  .option('-a, --agents <list>', 'Comma-separated agents to push for')
  .action(async (name: string, options) => {
    const cwd = process.cwd();
    const agents = options.agents
      ? (options.agents.split(',') as AgentId[])
      : MCP_CAPABLE_AGENTS;

    const cliStates = await getAllCliStates();
    let pushed = 0;
    for (const agentId of agents) {
      if (!cliStates[agentId]?.installed) continue;

      const result = await promoteMcpToUser(agentId, name, cwd);
      if (result.success) {
        console.log(`  ${chalk.green('+')} ${AGENTS[agentId].name}`);
        pushed++;
      } else if (result.error && !result.error.includes('not found')) {
        console.log(`  ${chalk.red('x')} ${AGENTS[agentId].name}: ${result.error}`);
      }
    }

    if (pushed === 0) {
      console.log(chalk.yellow(`Project MCP '${name}' not found for any agent`));
    } else {
      console.log(chalk.green(`\nPushed to user scope for ${pushed} agents.`));
    }
  });

// =============================================================================
// VERSION MANAGEMENT COMMANDS (add, remove, use, list, upgrade)
// =============================================================================

program
  .command('add <specs...>')
  .description('Install agent CLI versions')
  .option('-p, --project', 'Pin version in project manifest (.agents/agents.yaml)')
  .action(async (specs: string[], options) => {
    const isProject = options.project;

    for (const spec of specs) {
      const parsed = parseAgentSpec(spec);
      if (!parsed) {
        console.log(chalk.red(`Invalid agent: ${spec}`));
        console.log(chalk.gray(`Format: <agent>[@version]. Available: ${ALL_AGENT_IDS.join(', ')}`));
        continue;
      }

      const { agent, version } = parsed;
      const agentConfig = AGENTS[agent];

      if (!agentConfig.npmPackage) {
        console.log(chalk.yellow(`${agentConfig.name} has no npm package. Install manually.`));
        continue;
      }

      // Check if already installed
      if (isVersionInstalled(agent, version)) {
        console.log(chalk.gray(`${agentConfig.name}@${version} already installed`));

        // Ensure shim exists (in case it was deleted or needs updating)
        createShim(agent);
      } else {
        const spinner = ora(`Installing ${agentConfig.name}@${version}...`).start();

        const result = await installVersion(agent, version, (msg) => {
          spinner.text = msg;
        });

        if (result.success) {
          spinner.succeed(`Installed ${agentConfig.name}@${result.installedVersion}`);

          // Create shim if first install
          if (!shimExists(agent)) {
            createShim(agent);
            console.log(chalk.gray(`  Created shim: ${getShimsDir()}/${agentConfig.cliCommand}`));
          }

          // Check if shims in PATH
          if (!isShimsInPath()) {
            console.log();
            console.log(chalk.yellow('Shims directory not in PATH. Add it to use version switching:'));
            console.log(chalk.gray(getPathSetupInstructions()));
            console.log();
          }
        } else {
          spinner.fail(`Failed to install ${agentConfig.name}@${version}`);
          console.error(chalk.gray(result.error || 'Unknown error'));
          continue;
        }
      }

      // Update project manifest if -p flag
      if (isProject) {
        const projectManifestDir = path.join(process.cwd(), '.agents');
        const projectManifestPath = path.join(projectManifestDir, 'agents.yaml');

        if (!fs.existsSync(projectManifestDir)) {
          fs.mkdirSync(projectManifestDir, { recursive: true });
        }

        const manifest = fs.existsSync(projectManifestPath)
          ? readManifest(process.cwd()) || createDefaultManifest()
          : createDefaultManifest();

        manifest.agents = manifest.agents || {};
        manifest.agents[agent] = version === 'latest' ? (await getInstalledVersionForAgent(agent, version)) : version;

        writeManifest(process.cwd(), manifest);
        console.log(chalk.green(`  Pinned ${agentConfig.name}@${version} in .agents/agents.yaml`));
      }
    }
  });

/**
 * Helper to get actual installed version for an agent.
 */
async function getInstalledVersionForAgent(agent: AgentId, requestedVersion: string): Promise<string> {
  const versions = listInstalledVersions(agent);
  if (versions.length > 0) {
    return versions[versions.length - 1];
  }
  return requestedVersion;
}

program
  .command('remove <specs...>')
  .description('Remove agent CLI versions')
  .option('-p, --project', 'Also remove from project manifest')
  .action(async (specs: string[], options) => {
    const isProject = options.project;

    for (const spec of specs) {
      const parsed = parseAgentSpec(spec);
      if (!parsed) {
        console.log(chalk.red(`Invalid agent: ${spec}`));
        console.log(chalk.gray(`Format: <agent>[@version]. Available: ${ALL_AGENT_IDS.join(', ')}`));
        continue;
      }

      const { agent, version } = parsed;
      const agentConfig = AGENTS[agent];

      if (version === 'latest' || !spec.includes('@')) {
        // Remove all versions
        const versions = listInstalledVersions(agent);
        if (versions.length === 0) {
          console.log(chalk.gray(`No versions of ${agentConfig.name} installed`));
        } else {
          const count = removeAllVersions(agent);
          removeShim(agent);
          console.log(chalk.green(`Removed ${count} version(s) of ${agentConfig.name}`));
        }
      } else {
        // Remove specific version
        if (!isVersionInstalled(agent, version)) {
          console.log(chalk.gray(`${agentConfig.name}@${version} not installed`));
        } else {
          removeVersion(agent, version);
          console.log(chalk.green(`Removed ${agentConfig.name}@${version}`));

          // Remove shim if no versions left
          const remaining = listInstalledVersions(agent);
          if (remaining.length === 0) {
            removeShim(agent);
          }
        }
      }

      // Update project manifest if -p flag
      if (isProject) {
        const projectManifestPath = path.join(process.cwd(), '.agents', 'agents.yaml');
        if (fs.existsSync(projectManifestPath)) {
          const manifest = readManifest(process.cwd());
          if (manifest?.agents?.[agent]) {
            delete manifest.agents[agent];
            writeManifest(process.cwd(), manifest);
            console.log(chalk.gray(`  Removed from .agents/agents.yaml`));
          }
        }
      }
    }
  });

program
  .command('use <spec>')
  .description('Set the default agent CLI version')
  .option('-p, --project', 'Set in project manifest instead of global default')
  .action(async (spec: string, options) => {
    try {
    const parsed = parseAgentSpec(spec);
    if (!parsed) {
      console.log(chalk.red(`Invalid agent: ${spec}`));
      console.log(chalk.gray(`Format: <agent>@<version>. Available: ${ALL_AGENT_IDS.join(', ')}`));
      return;
    }

    const { agent, version } = parsed;
    const agentConfig = AGENTS[agent];

    let selectedVersion = version;

    if (!spec.includes('@') || version === 'latest') {
      // Interactive version picker
      const versions = listInstalledVersions(agent);
      if (versions.length === 0) {
        console.log(chalk.red(`No versions of ${agentConfig.name} installed`));
        console.log(chalk.gray(`Run: agents add ${agent}@latest`));
        return;
      }

      const globalDefault = getGlobalDefault(agent);

      // Pre-fetch emails for picker labels
      const pickerEmails = await Promise.all(
        versions.map((v) =>
          getAccountEmail(agent, getVersionHomePath(agent, v)).then((email) => ({ v, email }))
        )
      );
      const pickerEmailMap = new Map(pickerEmails.map((e) => [e.v, e.email]));

      selectedVersion = await select({
        message: `Select ${agentConfig.name} version:`,
        choices: versions.map((v) => {
          let label = v;
          if (v === globalDefault) label += chalk.green(' (default)');
          const email = pickerEmailMap.get(v);
          if (email) label += chalk.cyan(`  ${email}`);
          return { name: label, value: v };
        }),
      });
    }

    if (!isVersionInstalled(agent, selectedVersion)) {
      console.log(chalk.red(`${agentConfig.name}@${selectedVersion} not installed`));
      console.log(chalk.gray(`Run: agents add ${agent}@${selectedVersion}`));
      return;
    }

    if (options.project) {
      // Set in project manifest
      const projectManifestDir = path.join(process.cwd(), '.agents');
      const projectManifestPath = path.join(projectManifestDir, 'agents.yaml');

      if (!fs.existsSync(projectManifestDir)) {
        fs.mkdirSync(projectManifestDir, { recursive: true });
      }

      const manifest = fs.existsSync(projectManifestPath)
        ? readManifest(process.cwd()) || createDefaultManifest()
        : createDefaultManifest();

      manifest.agents = manifest.agents || {};
      manifest.agents[agent] = selectedVersion;

      writeManifest(process.cwd(), manifest);
      const projEmail = await getAccountEmail(agent, getVersionHomePath(agent, selectedVersion));
      const projEmailStr = projEmail ? chalk.cyan(` (${projEmail})`) : '';
      console.log(chalk.green(`Set ${agentConfig.name}@${selectedVersion} for this project`) + projEmailStr);
    } else {
      // Set global default
      setGlobalDefault(agent, selectedVersion);
      const useEmail = await getAccountEmail(agent, getVersionHomePath(agent, selectedVersion));
      const useEmailStr = useEmail ? chalk.cyan(` (${useEmail})`) : '';
      console.log(chalk.green(`Set ${agentConfig.name}@${selectedVersion} as global default`) + useEmailStr);
    }
    } catch (err) {
      if (isPromptCancelled(err)) return;
      throw err;
    }
  });

program
  .command('list [agent]')
  .description('List installed agent CLI versions')
  .action(async (agentArg?: string) => {
    // Resolve agent filter before spinner so we can personalize the message
    let filterAgentId: AgentId | undefined;
    if (agentArg) {
      const agentMap: Record<string, AgentId> = {
        claude: 'claude',
        'claude-code': 'claude',
        codex: 'codex',
        gemini: 'gemini',
        cursor: 'cursor',
        opencode: 'opencode',
      };
      filterAgentId = agentMap[agentArg.toLowerCase()];
      if (!filterAgentId) {
        console.log(chalk.red(`Unknown agent: ${agentArg}`));
        console.log(chalk.gray(`Valid agents: claude, codex, gemini, cursor, opencode`));
        process.exit(1);
      }
    }

    const spinnerText = filterAgentId
      ? `Checking ${AGENTS[filterAgentId].name} agents...`
      : 'Checking installed agents...';
    const spinner = ora(spinnerText).start();
    const cliStates = await getAllCliStates();
    spinner.stop();

    const agentsToShow = filterAgentId ? [filterAgentId] : ALL_AGENT_IDS;
    const showPaths = !!filterAgentId; // Show paths when filtering to single agent

    console.log(chalk.bold('Installed Agent CLIs\n'));

    // Pre-fetch emails for all versions in parallel
    const emailFetches: Promise<{ agentId: AgentId; version: string; email: string | null }>[] = [];
    const globalEmailFetches: Promise<{ agentId: AgentId; email: string | null }>[] = [];
    for (const agentId of agentsToShow) {
      const versions = listInstalledVersions(agentId);
      if (versions.length > 0) {
        for (const ver of versions) {
          emailFetches.push(
            getAccountEmail(agentId, getVersionHomePath(agentId, ver)).then((email) => ({
              agentId,
              version: ver,
              email,
            }))
          );
        }
      } else {
        globalEmailFetches.push(
          getAccountEmail(agentId).then((email) => ({ agentId, email }))
        );
      }
    }
    const emailResults = await Promise.all(emailFetches);
    const globalEmailResults = await Promise.all(globalEmailFetches);

    // Build lookup: agentId:version -> email
    const listEmailMap = new Map<string, string | null>();
    for (const { agentId, version, email } of emailResults) {
      listEmailMap.set(`${agentId}:${version}`, email);
    }
    const globalListEmailMap = new Map<string, string | null>();
    for (const { agentId, email } of globalEmailResults) {
      globalListEmailMap.set(agentId, email);
    }

    let hasAny = false;
    let hasVersionManaged = false;

    for (const agentId of agentsToShow) {
      const agent = AGENTS[agentId];
      const versions = listInstalledVersions(agentId);
      const globalDefault = getGlobalDefault(agentId);
      const cliState = cliStates[agentId];

      if (versions.length > 0) {
        // Version-managed install
        hasAny = true;
        hasVersionManaged = true;
        console.log(`  ${chalk.bold(agent.name)}`);

        for (const version of versions) {
          const isDefault = version === globalDefault;
          const marker = isDefault ? chalk.green(' (default)') : '';
          const vEmail = listEmailMap.get(`${agentId}:${version}`);
          const vEmailStr = vEmail ? `    ${chalk.cyan(vEmail)}` : '';
          console.log(`    ${version}${marker}${vEmailStr}`);
          if (showPaths) {
            const versionDir = getVersionDir(agentId, version);
            console.log(chalk.gray(`      ${versionDir}`));
          }
        }

        // Check for project override
        const projectVersion = getProjectVersionFromCwd(agentId);
        if (projectVersion && projectVersion !== globalDefault) {
          console.log(chalk.cyan(`    -> ${projectVersion} (project)`));
        }

        console.log();
      } else if (cliState?.installed) {
        // Globally installed (not version-managed)
        hasAny = true;
        console.log(`  ${chalk.bold(agent.name)}`);
        const gEmail = globalListEmailMap.get(agentId);
        const gEmailStr = gEmail ? `    ${chalk.cyan(gEmail)}` : '';
        console.log(`    ${cliState.version || 'installed'} ${chalk.gray('(global)')}${gEmailStr}`);
        if (showPaths && cliState.path) {
          console.log(chalk.gray(`      ${cliState.path}`));
        }
        console.log();
      } else if (filterAgentId) {
        // Filtered to a specific agent but not installed
        console.log(`  ${chalk.bold(agent.name)}: ${chalk.gray('not installed')}`);
        console.log();
      }
    }

    if (!hasAny && !filterAgentId) {
      console.log(chalk.gray('  No agent CLIs installed.'));
      console.log(chalk.gray('  Run: agents add claude@latest'));
      console.log();
    }

    // Show shims path status (only for full list)
    if (hasVersionManaged && !filterAgentId) {
      const shimsDir = getShimsDir();
      if (isShimsInPath()) {
        console.log(chalk.gray(`Shims: ${shimsDir} (in PATH)`));
      } else {
        console.log(chalk.yellow(`Shims: ${shimsDir} (not in PATH)`));
        console.log(chalk.gray('Add to PATH for automatic version switching'));
      }
    }
  });

/**
 * Helper to get project version from current working directory.
 */
function getProjectVersionFromCwd(agent: AgentId): string | null {
  const manifestPath = path.join(process.cwd(), '.agents', 'agents.yaml');
  if (!fs.existsSync(manifestPath)) {
    return null;
  }

  try {
    const manifest = readManifest(process.cwd());
    return manifest?.agents?.[agent] || null;
  } catch {
    return null;
  }
}


// =============================================================================
// REPO COMMANDS
// =============================================================================

const repoCmd = program
  .command('repo')
  .description('Manage .agents repos');

repoCmd
  .command('list')
  .description('List configured repos')
  .action(() => {
    const scopes = getReposByPriority();

    if (scopes.length === 0) {
      console.log(chalk.yellow('No repos configured.'));
      console.log(chalk.gray('  Run: agents repo add <source>'));
      console.log();
      return;
    }

    console.log(chalk.bold('Configured Repos\n'));
    console.log(chalk.gray('  Repos are applied in priority order (higher overrides lower)\n'));

    for (const { name, config } of scopes) {
      const readonlyTag = config.readonly ? chalk.gray(' (readonly)') : '';
      console.log(`  ${chalk.bold(name)}${readonlyTag}`);
      console.log(`    Source:   ${config.source}`);
      console.log(`    Branch:   ${config.branch}`);
      console.log(`    Commit:   ${config.commit.substring(0, 8)}`);
      console.log(`    Priority: ${config.priority}`);
      console.log(`    Synced:   ${new Date(config.lastSync).toLocaleString()}`);
      console.log();
    }
  });

repoCmd
  .command('add <source>')
  .description('Add or update a repo')
  .option('-s, --scope <scope>', 'Target repo name', 'user')
  .option('-y, --yes', 'Skip confirmation prompts')
  .action(async (source: string, options) => {
    const repoName = options.scope as RepoName;
    const existingRepo = getRepo(repoName);

    if (existingRepo && !options.yes) {
      const shouldOverwrite = await confirm({
        message: `Repo '${repoName}' already exists (${existingRepo.source}). Overwrite?`,
        default: false,
      });
      if (!shouldOverwrite) {
        console.log(chalk.yellow('Cancelled.'));
        return;
      }
    }

    if (existingRepo?.readonly && !options.yes) {
      console.log(chalk.red(`Repo '${repoName}' is readonly. Cannot overwrite.`));
      return;
    }

    const parsed = parseSource(source);
    const spinner = ora(`Cloning repository for ${repoName} repo...`).start();

    try {
      const { commit, isNew } = await cloneRepo(source);
      spinner.succeed(isNew ? 'Repository cloned' : 'Repository updated');

      const priority = getRepoPriority(repoName);
      setRepo(repoName, {
        source,
        branch: parsed.ref || 'main',
        commit,
        lastSync: new Date().toISOString(),
        priority,
        readonly: repoName === 'system',
      });

      console.log(chalk.green(`\nAdded repo '${repoName}' with priority ${priority}`));
      const repoHint = repoName === 'user' ? '' : ` --scope ${repoName}`;
      console.log(chalk.gray(`  Run: agents pull${repoHint} to sync commands`));
    } catch (err) {
      spinner.fail('Failed to add repo');
      console.error(chalk.red((err as Error).message));
      process.exit(1);
    }
  });

repoCmd
  .command('remove <scope>')
  .description('Remove a repo')
  .option('-y, --yes', 'Skip confirmation prompts')
  .action(async (repoName: string, options) => {
    const existingRepo = getRepo(repoName);

    if (!existingRepo) {
      console.log(chalk.yellow(`Repo '${repoName}' not found.`));
      return;
    }

    if (existingRepo.readonly) {
      console.log(chalk.red(`Repo '${repoName}' is readonly. Cannot remove.`));
      return;
    }

    if (!options.yes) {
      const shouldRemove = await confirm({
        message: `Remove repo '${repoName}' (${existingRepo.source})?`,
        default: false,
      });
      if (!shouldRemove) {
        console.log(chalk.yellow('Cancelled.'));
        return;
      }
    }

    const removed = removeRepo(repoName);
    if (removed) {
      console.log(chalk.green(`Removed repo '${repoName}'`));
    } else {
      console.log(chalk.yellow(`Failed to remove repo '${repoName}'`));
    }
  });

// =============================================================================
// REGISTRY COMMANDS
// =============================================================================

const registryCmd = program
  .command('registry')
  .description('Manage package registries');

registryCmd
  .command('list')
  .description('List configured registries')
  .option('-t, --type <type>', 'Filter by type: mcp or skill')
  .action((options) => {
    const types: RegistryType[] = options.type ? [options.type] : ['mcp', 'skill'];

    console.log(chalk.bold('Configured Registries\n'));

    for (const type of types) {
      console.log(chalk.bold(`  ${type.toUpperCase()}`));

      const registries = getRegistries(type);
      const entries = Object.entries(registries);

      if (entries.length === 0) {
        console.log(chalk.gray('    No registries configured'));
      } else {
        for (const [name, config] of entries) {
          const status = config.enabled ? chalk.green('enabled') : chalk.gray('disabled');
          const isDefault = DEFAULT_REGISTRIES[type]?.[name] ? chalk.gray(' (default)') : '';
          console.log(`    ${name}${isDefault}: ${status}`);
          console.log(chalk.gray(`      ${config.url}`));
        }
      }
      console.log();
    }
  });

registryCmd
  .command('add <type> <name> <url>')
  .description('Add a registry (type: mcp or skill)')
  .option('--api-key <key>', 'API key for authentication')
  .action((type: string, name: string, url: string, options) => {
    if (type !== 'mcp' && type !== 'skill') {
      console.log(chalk.red(`Invalid type '${type}'. Use 'mcp' or 'skill'.`));
      process.exit(1);
    }

    setRegistry(type as RegistryType, name, {
      url,
      enabled: true,
      apiKey: options.apiKey,
    });

    console.log(chalk.green(`Added ${type} registry '${name}'`));
  });

registryCmd
  .command('remove <type> <name>')
  .description('Remove a registry')
  .action((type: string, name: string) => {
    if (type !== 'mcp' && type !== 'skill') {
      console.log(chalk.red(`Invalid type '${type}'. Use 'mcp' or 'skill'.`));
      process.exit(1);
    }

    // Check if it's a default registry
    if (DEFAULT_REGISTRIES[type as RegistryType]?.[name]) {
      console.log(chalk.yellow(`Cannot remove default registry '${name}'. Use 'agents registry disable' instead.`));
      process.exit(1);
    }

    if (removeRegistry(type as RegistryType, name)) {
      console.log(chalk.green(`Removed ${type} registry '${name}'`));
    } else {
      console.log(chalk.yellow(`Registry '${name}' not found`));
    }
  });

registryCmd
  .command('enable <type> <name>')
  .description('Enable a registry')
  .action((type: string, name: string) => {
    if (type !== 'mcp' && type !== 'skill') {
      console.log(chalk.red(`Invalid type '${type}'. Use 'mcp' or 'skill'.`));
      process.exit(1);
    }

    const registries = getRegistries(type as RegistryType);
    if (!registries[name]) {
      console.log(chalk.yellow(`Registry '${name}' not found`));
      process.exit(1);
    }

    setRegistry(type as RegistryType, name, { enabled: true });
    console.log(chalk.green(`Enabled ${type} registry '${name}'`));
  });

registryCmd
  .command('disable <type> <name>')
  .description('Disable a registry')
  .action((type: string, name: string) => {
    if (type !== 'mcp' && type !== 'skill') {
      console.log(chalk.red(`Invalid type '${type}'. Use 'mcp' or 'skill'.`));
      process.exit(1);
    }

    const registries = getRegistries(type as RegistryType);
    if (!registries[name]) {
      console.log(chalk.yellow(`Registry '${name}' not found`));
      process.exit(1);
    }

    setRegistry(type as RegistryType, name, { enabled: false });
    console.log(chalk.green(`Disabled ${type} registry '${name}'`));
  });

registryCmd
  .command('config <type> <name>')
  .description('Configure a registry')
  .option('--api-key <key>', 'Set API key')
  .option('--url <url>', 'Update URL')
  .action((type: string, name: string, options) => {
    if (type !== 'mcp' && type !== 'skill') {
      console.log(chalk.red(`Invalid type '${type}'. Use 'mcp' or 'skill'.`));
      process.exit(1);
    }

    const registries = getRegistries(type as RegistryType);
    if (!registries[name]) {
      console.log(chalk.yellow(`Registry '${name}' not found`));
      process.exit(1);
    }

    const updates: Record<string, unknown> = {};
    if (options.apiKey) updates.apiKey = options.apiKey;
    if (options.url) updates.url = options.url;

    if (Object.keys(updates).length === 0) {
      console.log(chalk.yellow('No options provided. Use --api-key or --url.'));
      process.exit(1);
    }

    setRegistry(type as RegistryType, name, updates);
    console.log(chalk.green(`Updated ${type} registry '${name}'`));
  });

// =============================================================================
// SEARCH COMMAND
// =============================================================================

program
  .command('search <query>')
  .description('Search package registries')
  .option('-t, --type <type>', 'Filter by type: mcp or skill')
  .option('-r, --registry <name>', 'Search specific registry')
  .option('-l, --limit <n>', 'Max results', '20')
  .action(async (query: string, options) => {
    const spinner = ora('Searching registries...').start();

    try {
      const results = await searchRegistries(query, {
        type: options.type as RegistryType | undefined,
        registry: options.registry,
        limit: parseInt(options.limit, 10),
      });

      spinner.stop();

      if (results.length === 0) {
        console.log(chalk.yellow('\nNo packages found.'));

        if (!options.type) {
          console.log(chalk.gray('\nTip: skill registries not yet available. Use gh:user/repo for skills.'));
        }
        return;
      }

      console.log(chalk.bold(`Found ${results.length} packages`));

      // Group by type
      const mcpResults = results.filter((r) => r.type === 'mcp');
      const skillResults = results.filter((r) => r.type === 'skill');

      if (mcpResults.length > 0) {
        console.log(chalk.bold('\n  MCP Servers'));
        for (const result of mcpResults) {
          const desc = result.description
            ? chalk.gray(` - ${result.description.slice(0, 50)}${result.description.length > 50 ? '...' : ''}`)
            : '';
          console.log(`    ${chalk.cyan(result.name)}${desc}`);
          console.log(chalk.gray(`      Registry: ${result.registry}  Install: agents add mcp:${result.name}`));
        }
      }

      if (skillResults.length > 0) {
        console.log(chalk.bold('\n  Skills'));
        for (const result of skillResults) {
          const desc = result.description
            ? chalk.gray(` - ${result.description.slice(0, 50)}${result.description.length > 50 ? '...' : ''}`)
            : '';
          console.log(`    ${chalk.cyan(result.name)}${desc}`);
          console.log(chalk.gray(`      Registry: ${result.registry}  Install: agents add skill:${result.name}`));
        }
      }
    } catch (err) {
      spinner.fail('Search failed');
      console.error(chalk.red((err as Error).message));
      process.exit(1);
    }
  });

// =============================================================================
// INSTALL COMMAND (unified package installation)
// =============================================================================

program
  .command('install <identifier>')
  .description('Install a package from a registry or Git source')
  .option('-a, --agents <list>', 'Comma-separated agents to install to')
  .action(async (identifier: string, options) => {
    const spinner = ora('Resolving package...').start();

    try {
      const resolved = await resolvePackage(identifier);

      if (!resolved) {
        spinner.fail('Package not found');
        console.log(chalk.gray('\nTip: Use explicit prefix (mcp:, skill:, gh:) or check the identifier.'));
        process.exit(1);
      }

      spinner.succeed(`Found ${resolved.type} package`);

      if (resolved.type === 'mcp') {
        // Install MCP server
        const entry = resolved.mcpEntry;
        if (!entry) {
          console.log(chalk.red('Failed to get MCP server details'));
          process.exit(1);
        }

        console.log(chalk.bold(`\n${entry.name}`));
        if (entry.description) {
          console.log(chalk.gray(`  ${entry.description}`));
        }
        if (entry.repository?.url) {
          console.log(chalk.gray(`  ${entry.repository.url}`));
        }

        // Get package info
        const pkg = entry.packages?.[0];
        if (!pkg) {
          console.log(chalk.yellow('\nNo installable package found for this server.'));
          console.log(chalk.gray('You may need to install it manually.'));
          process.exit(1);
        }

        console.log(chalk.bold('\nPackage:'));
        console.log(`  Name: ${pkg.name || pkg.registry_name}`);
        console.log(`  Runtime: ${pkg.runtime || 'unknown'}`);
        console.log(`  Transport: ${pkg.transport || 'stdio'}`);

        if (pkg.packageArguments && pkg.packageArguments.length > 0) {
          console.log(chalk.bold('\nRequired arguments:'));
          for (const arg of pkg.packageArguments) {
            const req = arg.required ? chalk.red('*') : '';
            console.log(`  ${arg.name}${req}: ${arg.description || ''}`);
          }
        }

        // Determine command based on runtime
        let command: string;
        if (pkg.runtime === 'node') {
          command = `npx -y ${pkg.name || pkg.registry_name}`;
        } else if (pkg.runtime === 'python') {
          command = `uvx ${pkg.name || pkg.registry_name}`;
        } else {
          command = pkg.name || pkg.registry_name;
        }

        const cliStates = await getAllCliStates();
        const agents = options.agents
          ? (options.agents.split(',') as AgentId[])
          : MCP_CAPABLE_AGENTS.filter((id) => cliStates[id]?.installed);

        if (agents.length === 0) {
          console.log(chalk.yellow('\nNo MCP-capable agents installed.'));
          process.exit(1);
        }

        console.log(chalk.bold('\nInstalling to agents...'));
        for (const agentId of agents) {
          if (!cliStates[agentId]?.installed) continue;

          const result = await registerMcp(agentId, entry.name, command, 'user');
          if (result.success) {
            console.log(`  ${chalk.green('+')} ${AGENTS[agentId].name}`);
          } else {
            console.log(`  ${chalk.red('x')} ${AGENTS[agentId].name}: ${result.error}`);
          }
        }

        console.log(chalk.green('\nMCP server installed.'));
      } else if (resolved.type === 'git' || resolved.type === 'skill') {
        // Install from git source (skills/commands/hooks)
        console.log(chalk.bold(`\nInstalling from ${resolved.source}`));

        const { localPath } = await cloneRepo(resolved.source);

        // Discover what's in the repo
        const commands = discoverCommands(localPath);
        const skills = discoverSkillsFromRepo(localPath);
        const hooks = discoverHooksFromRepo(localPath);

        const hasCommands = commands.length > 0;
        const hasSkills = skills.length > 0;
        const hasHooks = hooks.shared.length > 0 || Object.values(hooks.agentSpecific).some((h) => h.length > 0);

        if (!hasCommands && !hasSkills && !hasHooks) {
          console.log(chalk.yellow('No installable content found in repository.'));
          process.exit(1);
        }

        console.log(chalk.bold('\nFound:'));
        if (hasCommands) console.log(`  ${commands.length} commands`);
        if (hasSkills) console.log(`  ${skills.length} skills`);
        if (hasHooks) console.log(`  ${hooks.shared.length + Object.values(hooks.agentSpecific).flat().length} hooks`);

        const agents = options.agents
          ? (options.agents.split(',') as AgentId[])
          : ALL_AGENT_IDS;

        const gitCliStates = await getAllCliStates();
        // Install commands
        if (hasCommands) {
          console.log(chalk.bold('\nInstalling commands...'));
          let installed = 0;
          let failed = 0;
          for (const command of commands) {
            for (const agentId of agents) {
              if (!gitCliStates[agentId]?.installed && agentId !== 'cursor') continue;

              const sourcePath = resolveCommandSource(localPath, command.name, agentId);
              if (sourcePath) {
                const result = installCommand(sourcePath, agentId, command.name, 'symlink');
                if (result.error) {
                  failed++;
                } else {
                  installed++;
                }
              }
            }
          }
          if (failed > 0) {
            console.log(`  Installed ${installed} command instances (${failed} failed)`);
          } else {
            console.log(`  Installed ${installed} command instances`);
          }
        }

        // Install skills
        if (hasSkills) {
          console.log(chalk.bold('\nInstalling skills...'));
          for (const skill of skills) {
            const result = installSkill(skill.path, skill.name, agents);
            if (result.success) {
              console.log(`  ${chalk.green('+')} ${skill.name}`);
            } else {
              console.log(`  ${chalk.red('x')} ${skill.name}: ${result.error}`);
            }
          }
        }

        // Install hooks
        if (hasHooks) {
          console.log(chalk.bold('\nInstalling hooks...'));
          const hookAgents = agents.filter((id) => AGENTS[id].supportsHooks) as AgentId[];
          const result = await installHooks(localPath, hookAgents, { scope: 'user' });
          console.log(`  Installed ${result.installed.length} hooks`);
        }

        console.log(chalk.green('\nPackage installed.'));
      }
    } catch (err) {
      spinner.fail('Installation failed');
      console.error(chalk.red((err as Error).message));
      process.exit(1);
    }
  });

// =============================================================================
// DAEMON COMMANDS
// =============================================================================

import {
  startDaemon,
  stopDaemon,
  isDaemonRunning,
  readDaemonPid,
  readDaemonLog,
  runDaemon,
  signalDaemonReload,
} from './lib/daemon.js';
import {
  listJobs as listAllJobs,
  readJob,
  validateJob,
  writeJob,
  setJobEnabled,
  listRuns,
  getLatestRun,
  getRunDir,
  discoverJobsFromRepo,
  jobExists,
  jobContentMatches,
  installJobFromSource,
} from './lib/jobs.js';
import type { JobConfig } from './lib/jobs.js';
import { executeJob } from './lib/runner.js';
import { JobScheduler } from './lib/scheduler.js';

const daemonCmd = program.command('daemon').description('Manage the jobs daemon');

daemonCmd
  .command('start')
  .description('Start the daemon')
  .action(() => {
    const result = startDaemon();
    if (result.method === 'already-running') {
      console.log(chalk.yellow(`Daemon already running (PID: ${result.pid})`));
    } else {
      console.log(chalk.green(`Daemon started (PID: ${result.pid}, method: ${result.method})`));
    }
  });

daemonCmd
  .command('stop')
  .description('Stop the daemon')
  .action(() => {
    if (!isDaemonRunning()) {
      console.log(chalk.yellow('Daemon is not running'));
      return;
    }
    stopDaemon();
    console.log(chalk.green('Daemon stopped'));
  });

daemonCmd
  .command('status')
  .description('Show daemon status')
  .action(() => {
    const running = isDaemonRunning();
    const pid = readDaemonPid();

    console.log(chalk.bold('Daemon Status\n'));
    console.log(`  Status:  ${running ? chalk.green('running') : chalk.gray('stopped')}`);
    if (pid) console.log(`  PID:     ${pid}`);

    const jobs = listAllJobs();
    const enabled = jobs.filter((j) => j.enabled);
    console.log(`  Jobs:    ${enabled.length} enabled / ${jobs.length} total`);

    if (running && enabled.length > 0) {
      const scheduler = new JobScheduler(async () => {});
      scheduler.loadAll();
      const scheduled = scheduler.listScheduled();
      console.log(chalk.bold('\n  Scheduled Jobs\n'));
      for (const job of scheduled) {
        const next = job.nextRun ? job.nextRun.toLocaleString() : 'unknown';
        console.log(`    ${chalk.cyan(job.name.padEnd(24))} next: ${chalk.gray(next)}`);
      }
      scheduler.stopAll();
    }
  });

daemonCmd
  .command('logs')
  .description('Show daemon logs')
  .option('-n, --lines <number>', 'Number of lines to show', '50')
  .option('-f, --follow', 'Follow log output')
  .action(async (options) => {
    if (options.follow) {
      const { exec: execCb } = await import('child_process');
      const { getAgentsDir } = await import('./lib/state.js');
      const logPath = path.join(getAgentsDir(), 'daemon.log');
      const child = execCb(`tail -f "${logPath}"`);
      child.stdout?.pipe(process.stdout);
      child.stderr?.pipe(process.stderr);
      child.on('exit', () => process.exit(0));
      process.on('SIGINT', () => { child.kill(); process.exit(0); });
      return;
    }

    const lines = parseInt(options.lines, 10);
    const output = readDaemonLog(lines);
    if (output) {
      console.log(output);
    } else {
      console.log(chalk.gray('No daemon logs'));
    }
  });

daemonCmd
  .command('_run', { hidden: true })
  .description('Run daemon in foreground (internal)')
  .action(async () => {
    await runDaemon();
  });

// =============================================================================
// JOBS COMMANDS
// =============================================================================

const jobsCmd = program.command('jobs').description('Manage scheduled jobs');

jobsCmd
  .command('list')
  .description('List all jobs')
  .action(() => {
    const jobs = listAllJobs();
    if (jobs.length === 0) {
      console.log(chalk.gray('No jobs configured'));
      console.log(chalk.gray('  Add a job: agents jobs add <path-to-job.yml>'));
      return;
    }

    const scheduler = new JobScheduler(async () => {});
    scheduler.loadAll();

    console.log(chalk.bold('Scheduled Jobs\n'));

    const header = `  ${'Name'.padEnd(24)} ${'Agent'.padEnd(10)} ${'Schedule'.padEnd(20)} ${'Enabled'.padEnd(10)} ${'Next Run'.padEnd(24)} ${'Last Status'}`;
    console.log(chalk.gray(header));
    console.log(chalk.gray('  ' + '-'.repeat(110)));

    for (const job of jobs) {
      const nextRun = scheduler.getNextRun(job.name);
      const nextStr = nextRun ? nextRun.toLocaleString() : '-';
      const latestRun = getLatestRun(job.name);
      const lastStatus = latestRun?.status || '-';

      const enabledStr = job.enabled ? chalk.green('yes') : chalk.gray('no');
      const statusColor = lastStatus === 'completed' ? chalk.green : lastStatus === 'failed' ? chalk.red : lastStatus === 'timeout' ? chalk.yellow : chalk.gray;

      console.log(
        `  ${chalk.cyan(job.name.padEnd(24))} ${job.agent.padEnd(10)} ${job.schedule.padEnd(20)} ${enabledStr.padEnd(10 + 10)} ${chalk.gray(nextStr.padEnd(24))} ${statusColor(lastStatus)}`
      );
    }

    scheduler.stopAll();
    console.log();
  });

jobsCmd
  .command('add <path>')
  .description('Add a job from a YAML file')
  .action(async (filePath: string) => {
    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) {
      console.log(chalk.red(`File not found: ${resolved}`));
      process.exit(1);
    }

    const content = fs.readFileSync(resolved, 'utf-8');
    let parsed: any;
    try {
      const yamlMod = await import('yaml');
      parsed = yamlMod.parse(content);
    } catch (err) {
      console.log(chalk.red(`Invalid YAML: ${(err as Error).message}`));
      process.exit(1);
    }

    const name = parsed.name || path.basename(resolved).replace(/\.ya?ml$/, '');
    parsed.name = name;

    const errors = validateJob(parsed);
    if (errors.length > 0) {
      console.log(chalk.red('Validation errors:'));
      for (const err of errors) {
        console.log(chalk.red(`  - ${err}`));
      }
      process.exit(1);
    }

    const config: JobConfig = {
      mode: 'plan',
      effort: 'default',
      timeout: '30m',
      enabled: true,
      ...parsed,
    } as JobConfig;

    writeJob(config);
    console.log(chalk.green(`Job '${name}' added`));

    if (isDaemonRunning()) {
      signalDaemonReload();
      console.log(chalk.gray('Daemon reloaded'));
    }
  });

jobsCmd
  .command('run <name>')
  .description('Run a job immediately in the foreground')
  .action(async (name: string) => {
    const job = readJob(name);
    if (!job) {
      console.log(chalk.red(`Job '${name}' not found`));
      process.exit(1);
    }

    console.log(chalk.bold(`Running job '${name}' (agent: ${job.agent}, mode: ${job.mode})\n`));
    const spinner = ora('Executing...').start();

    try {
      const result = await executeJob(job);
      if (result.meta.status === 'completed') {
        spinner.succeed(`Job completed (exit code: ${result.meta.exitCode})`);
      } else if (result.meta.status === 'timeout') {
        spinner.warn(`Job timed out after ${job.timeout}`);
      } else {
        spinner.fail(`Job failed (exit code: ${result.meta.exitCode})`);
      }

      console.log(chalk.gray(`  Run: ${result.meta.runId}`));
      console.log(chalk.gray(`  Log: ${getRunDir(name, result.meta.runId)}/stdout.log`));

      if (result.reportPath) {
        console.log(chalk.bold('\nReport:\n'));
        console.log(fs.readFileSync(result.reportPath, 'utf-8'));
      }
    } catch (err) {
      spinner.fail('Execution failed');
      console.error(chalk.red((err as Error).message));
      process.exit(1);
    }
  });

jobsCmd
  .command('logs <name>')
  .description('Show stdout from the latest (or specific) run')
  .option('-r, --run <runId>', 'Specific run ID')
  .action((name: string, options) => {
    let runId = options.run;
    if (!runId) {
      const latest = getLatestRun(name);
      if (!latest) {
        console.log(chalk.yellow(`No runs found for job '${name}'`));
        return;
      }
      runId = latest.runId;
    }

    const logPath = path.join(getRunDir(name, runId), 'stdout.log');
    if (!fs.existsSync(logPath)) {
      console.log(chalk.yellow(`Log not found: ${logPath}`));
      return;
    }

    console.log(chalk.gray(`Run: ${runId}\n`));
    console.log(fs.readFileSync(logPath, 'utf-8'));
  });

jobsCmd
  .command('report <name>')
  .description('Show report from the latest (or specific) run')
  .option('-r, --run <runId>', 'Specific run ID')
  .action((name: string, options) => {
    let runId = options.run;
    if (!runId) {
      const latest = getLatestRun(name);
      if (!latest) {
        console.log(chalk.yellow(`No runs found for job '${name}'`));
        return;
      }
      runId = latest.runId;
    }

    const reportPath = path.join(getRunDir(name, runId), 'report.md');
    if (!fs.existsSync(reportPath)) {
      console.log(chalk.yellow(`No report found for run ${runId}`));
      console.log(chalk.gray(`  Reports are extracted from agent output on completion`));
      return;
    }

    console.log(chalk.gray(`Run: ${runId}\n`));
    console.log(fs.readFileSync(reportPath, 'utf-8'));
  });

jobsCmd
  .command('enable <name>')
  .description('Enable a job')
  .action((name: string) => {
    try {
      setJobEnabled(name, true);
      console.log(chalk.green(`Job '${name}' enabled`));
      if (isDaemonRunning()) {
        signalDaemonReload();
        console.log(chalk.gray('Daemon reloaded'));
      }
    } catch (err) {
      console.log(chalk.red((err as Error).message));
      process.exit(1);
    }
  });

jobsCmd
  .command('disable <name>')
  .description('Disable a job')
  .action((name: string) => {
    try {
      setJobEnabled(name, false);
      console.log(chalk.green(`Job '${name}' disabled`));
      if (isDaemonRunning()) {
        signalDaemonReload();
        console.log(chalk.gray('Daemon reloaded'));
      }
    } catch (err) {
      console.log(chalk.red((err as Error).message));
      process.exit(1);
    }
  });

// =============================================================================
// DRIVE COMMANDS
// =============================================================================

import {
  createDrive,
  readDrive,
  listDrives as listAllDrives,
  deleteDrive,
  updateDriveFrontmatter,
  getDriveContent,
  getDriveForProject,
  driveExists,
  discoverDrivesFromRepo,
  installDriveFromSource,
  driveContentMatches,
} from './lib/drives.js';
import { runDriveServer } from './lib/drive-server.js';

const driveCmd = program.command('drive').description('Manage context drives (experimental)');

driveCmd.hook('preAction', () => {
  console.log(chalk.yellow('Note: Context drives is an experimental feature.\n'));
});

driveCmd
  .command('create <name>')
  .description('Create a new empty drive')
  .option('-d, --description <desc>', 'Drive description')
  .option('-p, --project <path>', 'Link to a project directory')
  .action((name: string, options) => {
    try {
      const filePath = createDrive(name, options.description);
      if (options.project) {
        updateDriveFrontmatter(name, { project: path.resolve(options.project) });
      }
      console.log(chalk.green(`Drive '${name}' created`));
      console.log(chalk.gray(`  ${filePath}`));
    } catch (err) {
      console.log(chalk.red((err as Error).message));
      process.exit(1);
    }
  });

driveCmd
  .command('list')
  .description('List all drives')
  .action(() => {
    const drives = listAllDrives();
    if (drives.length === 0) {
      console.log(chalk.gray('No drives configured'));
      console.log(chalk.gray('  Create a drive: agents drive create <name>'));
      return;
    }

    console.log(chalk.bold('Context Drives\n'));
    const header = `  ${'Name'.padEnd(24)} ${'Description'.padEnd(40)} ${'Project'}`;
    console.log(chalk.gray(header));
    console.log(chalk.gray('  ' + '-'.repeat(90)));

    for (const drive of drives) {
      const desc = (drive.description || '-').slice(0, 38);
      const proj = drive.project || '-';
      console.log(
        `  ${chalk.cyan(drive.name.padEnd(24))} ${desc.padEnd(40)} ${chalk.gray(proj)}`
      );
    }
    console.log();
  });

driveCmd
  .command('info <name>')
  .description('Show drive metadata and content preview')
  .action((name: string) => {
    const drive = readDrive(name);
    if (!drive) {
      console.log(chalk.red(`Drive '${name}' not found`));
      process.exit(1);
    }

    console.log(chalk.bold(`Drive: ${drive.frontmatter.name}\n`));

    if (drive.frontmatter.description) {
      console.log(chalk.gray(`  Description: ${drive.frontmatter.description}`));
    }
    if (drive.frontmatter.project) {
      console.log(chalk.gray(`  Project:     ${drive.frontmatter.project}`));
    }
    if (drive.frontmatter.repo) {
      console.log(chalk.gray(`  Repo:        ${drive.frontmatter.repo}`));
    }
    if (drive.frontmatter.updated) {
      console.log(chalk.gray(`  Updated:     ${drive.frontmatter.updated}`));
    }
    console.log(chalk.gray(`  Path:        ${drive.path}`));

    const content = drive.content.trim();
    if (content) {
      console.log(chalk.bold('\nContent:\n'));
      const lines = content.split('\n');
      const preview = lines.slice(0, 30);
      for (const line of preview) {
        console.log(`  ${line}`);
      }
      if (lines.length > 30) {
        console.log(chalk.gray(`\n  ... ${lines.length - 30} more lines`));
      }
    }
    console.log();
  });

driveCmd
  .command('edit <name>')
  .description('Open drive in $EDITOR')
  .action((name: string) => {
    const drive = readDrive(name);
    if (!drive) {
      console.log(chalk.red(`Drive '${name}' not found`));
      process.exit(1);
    }

    const editor = process.env.EDITOR || process.env.VISUAL || 'vi';
    const { execSync } = require('child_process');
    try {
      execSync(`${editor} "${drive.path}"`, { stdio: 'inherit' });
    } catch {
      console.log(chalk.red(`Failed to open editor: ${editor}`));
      process.exit(1);
    }
  });

driveCmd
  .command('delete <name>')
  .description('Delete a drive')
  .action(async (name: string) => {
    if (!driveExists(name)) {
      console.log(chalk.red(`Drive '${name}' not found`));
      process.exit(1);
    }

    try {
      const answer = await confirm({ message: `Delete drive '${name}'?` });
      if (!answer) return;
    } catch (err) {
      if (isPromptCancelled(err)) return;
      throw err;
    }

    deleteDrive(name);
    console.log(chalk.green(`Drive '${name}' deleted`));
  });

driveCmd
  .command('link <name> <path>')
  .description('Link a drive to a project directory')
  .action((name: string, projectPath: string) => {
    if (!driveExists(name)) {
      console.log(chalk.red(`Drive '${name}' not found`));
      process.exit(1);
    }

    const resolved = path.resolve(projectPath);
    if (!fs.existsSync(resolved)) {
      console.log(chalk.red(`Directory not found: ${resolved}`));
      process.exit(1);
    }

    updateDriveFrontmatter(name, { project: resolved });
    console.log(chalk.green(`Drive '${name}' linked to ${resolved}`));
  });

driveCmd
  .command('sync')
  .description('Sync drives with .agents repo')
  .action(async () => {
    const source = await ensureSource();
    const repoPath = getRepoLocalPath(source);

    const discovered = discoverDrivesFromRepo(repoPath);
    if (discovered.length === 0) {
      console.log(chalk.gray('No drives found in repo'));
      return;
    }

    let installed = 0;
    let skipped = 0;

    for (const d of discovered) {
      if (driveExists(d.name) && driveContentMatches(d.name, d.path)) {
        skipped++;
        continue;
      }

      const result = installDriveFromSource(d.path, d.name);
      if (result.success) {
        installed++;
        console.log(chalk.green(`  + ${d.name}`));
      } else {
        console.log(chalk.red(`  x ${d.name}: ${result.error}`));
      }
    }

    if (installed === 0 && skipped > 0) {
      console.log(chalk.gray(`All ${skipped} drives up to date`));
    } else if (installed > 0) {
      console.log(chalk.green(`\nSynced ${installed} drive(s)`));
    }
  });

driveCmd
  .command('generate <name>')
  .description('Run a drive generation job now')
  .action(async (name: string) => {
    if (!driveExists(name)) {
      console.log(chalk.red(`Drive '${name}' not found`));
      process.exit(1);
    }

    const jobName = `update-drive-${name}`;
    const job = readJob(jobName);
    if (!job) {
      console.log(chalk.red(`No generation job found for drive '${name}'`));
      console.log(chalk.gray(`  Expected job name: ${jobName}`));
      console.log(chalk.gray(`  Create one at: ~/.agents/jobs/${jobName}.yml`));
      process.exit(1);
    }

    console.log(chalk.bold(`Generating drive '${name}' (job: ${jobName})\n`));
    const spinner = ora('Executing...').start();

    try {
      const result = await executeJob(job);
      if (result.meta.status === 'completed') {
        spinner.succeed(`Drive '${name}' updated`);
      } else if (result.meta.status === 'timeout') {
        spinner.warn(`Generation timed out after ${job.timeout}`);
      } else {
        spinner.fail(`Generation failed (exit code: ${result.meta.exitCode})`);
      }
    } catch (err) {
      spinner.fail('Generation failed');
      console.error(chalk.red((err as Error).message));
      process.exit(1);
    }
  });

driveCmd
  .command('serve')
  .description('Start the drive MCP server (stdio)')
  .action(async () => {
    await runDriveServer();
  });

async function showWhatsNew(fromVersion: string, toVersion: string): Promise<void> {
  try {
    // Fetch changelog from npm package
    const response = await fetch(`https://unpkg.com/@swarmify/agents-cli@${toVersion}/CHANGELOG.md`);
    if (!response.ok) return;

    const changelog = await response.text();
    const lines = changelog.split('\n');

    // Parse changelog to find relevant sections
    const relevantChanges: string[] = [];
    let inRelevantSection = false;
    let currentVersion = '';

    for (const line of lines) {
      // Check for version header (## 1.5.0)
      const versionMatch = line.match(/^## (\d+\.\d+\.\d+)/);
      if (versionMatch) {
        currentVersion = versionMatch[1];
        // Include versions newer than fromVersion
        const isNewer = currentVersion !== fromVersion &&
          compareVersions(currentVersion, fromVersion) > 0;
        inRelevantSection = isNewer;
        if (inRelevantSection) {
          relevantChanges.push('');
          relevantChanges.push(chalk.bold(`v${currentVersion}`));
        }
        continue;
      }

      if (inRelevantSection && line.trim()) {
        // Format the line
        if (line.startsWith('**') && line.endsWith('**')) {
          // Section header like **Pull command redesign**
          relevantChanges.push(chalk.cyan(line.replace(/\*\*/g, '')));
        } else if (line.startsWith('- ')) {
          // Bullet point
          relevantChanges.push(chalk.gray(`  ${line}`));
        }
      }
    }

    if (relevantChanges.length > 0) {
      console.log(chalk.bold("\nWhat's new:\n"));
      for (const line of relevantChanges) {
        console.log(line);
      }
      console.log();
    }
  } catch {
    // Silently ignore changelog fetch errors
  }
}

function compareVersions(a: string, b: string): number {
  const partsA = a.split('.').map(Number);
  const partsB = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (partsA[i] > partsB[i]) return 1;
    if (partsA[i] < partsB[i]) return -1;
  }
  return 0;
}

program.parse();
