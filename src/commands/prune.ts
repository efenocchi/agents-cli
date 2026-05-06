/**
 * Top-level `agents prune` — destructive cleanup across the install.
 *
 * Two kinds of cleanup, one verb:
 *   - Resource orphans: command/skill/hook files inside a version home that no
 *     longer come from any source (deleted from ~/.agents/ but never reconciled
 *     into the version install).
 *   - Version duplicates: older installed versions of an agent that share an
 *     account with a newer installed version of the same agent (the older copy
 *     is redundant; the newer one is what's signed in and active).
 *
 * Sync (additive: copy missing/changed files into version homes) is no longer
 * a user-facing verb — `syncResourcesToVersion` runs at agent launch and
 * applies adds/updates automatically. Pruning, however, is destructive, so it
 * stays explicit.
 *
 * Default scope: each agent's currently-pinned default version for orphan
 * cleanup, plus the standard cross-agent version-dedup pass. Pass `--all`
 * to widen orphan cleanup to every installed version.
 */
import type { Command } from 'commander';
import chalk from 'chalk';
import { confirm } from '@inquirer/prompts';
import type { AgentId } from '../lib/types.js';
import {
  diffVersionCommands,
  iterCommandsCapableVersions,
  removeCommandFromVersion,
} from '../lib/commands.js';
import {
  diffVersionSkills,
  iterSkillsCapableVersions,
  removeSkillFromVersion,
} from '../lib/skills.js';
import {
  diffVersionHooks,
  iterHooksCapableVersions,
  removeHookFromVersion,
} from '../lib/hooks.js';
import { getGlobalDefault } from '../lib/versions.js';
import { resolveAgentName, formatAgentError } from '../lib/agents.js';
import { pruneDuplicates } from './view.js';
import { isInteractiveTerminal, isPromptCancelled } from './utils.js';

type ResourceType = 'commands' | 'skills' | 'hooks';
type PruneType = ResourceType | 'versions';

const RESOURCE_TYPES: ResourceType[] = ['commands', 'skills', 'hooks'];
const ALL_TYPES: PruneType[] = [...RESOURCE_TYPES, 'versions'];

interface PruneOptions {
  all?: boolean;
  dryRun?: boolean;
  yes?: boolean;
}

interface OrphanGroup {
  type: ResourceType;
  agent: AgentId;
  version: string;
  orphans: string[];
}

function scopePairs(
  pairs: Array<{ agent: AgentId; version: string }>,
  all: boolean,
): Array<{ agent: AgentId; version: string }> {
  if (all) return pairs;
  return pairs.filter((p) => p.version === getGlobalDefault(p.agent));
}

function collectOrphans(types: ResourceType[], all: boolean): OrphanGroup[] {
  const groups: OrphanGroup[] = [];

  if (types.includes('commands')) {
    for (const { agent, version } of scopePairs(iterCommandsCapableVersions(), all)) {
      const diff = diffVersionCommands(agent, version);
      if (diff.orphans.length > 0) {
        groups.push({ type: 'commands', agent, version, orphans: diff.orphans });
      }
    }
  }

  if (types.includes('skills')) {
    for (const { agent, version } of scopePairs(iterSkillsCapableVersions(), all)) {
      const diff = diffVersionSkills(agent, version);
      if (diff.orphans.length > 0) {
        groups.push({ type: 'skills', agent, version, orphans: diff.orphans });
      }
    }
  }

  if (types.includes('hooks')) {
    for (const { agent, version } of scopePairs(iterHooksCapableVersions(), all)) {
      const diff = diffVersionHooks(agent, version);
      if (diff.orphans.length > 0) {
        groups.push({ type: 'hooks', agent, version, orphans: diff.orphans });
      }
    }
  }

  return groups;
}

function removeOne(group: OrphanGroup, name: string): { success: boolean; error?: string } {
  switch (group.type) {
    case 'commands':
      return removeCommandFromVersion(group.agent, group.version, name);
    case 'skills':
      return removeSkillFromVersion(group.agent, group.version, name);
    case 'hooks':
      return removeHookFromVersion(group.agent, group.version, name);
  }
}

/**
 * Resolve the optional positional. It can be a resource type, the literal
 * "versions", or an agent name (shorthand for `prune versions <agent>`).
 */
interface ParsedTarget {
  resourceTypes: ResourceType[];
  includeVersions: boolean;
  versionAgent?: AgentId;
}

function parseTarget(arg: string | undefined): ParsedTarget {
  if (!arg) {
    return { resourceTypes: RESOURCE_TYPES, includeVersions: true };
  }
  if (RESOURCE_TYPES.includes(arg as ResourceType)) {
    return { resourceTypes: [arg as ResourceType], includeVersions: false };
  }
  if (arg === 'versions') {
    return { resourceTypes: [], includeVersions: true };
  }
  // Try treating as an agent name — shortcut for `prune versions <agent>`.
  const agentId = resolveAgentName(arg);
  if (agentId) {
    return { resourceTypes: [], includeVersions: true, versionAgent: agentId };
  }
  console.log(chalk.red(`Unknown prune target: ${arg}`));
  console.log(chalk.gray(`Available types: ${ALL_TYPES.join(', ')}`));
  console.log(chalk.gray(formatAgentError(arg)));
  process.exit(1);
}

async function runOrphanPrune(
  resourceTypes: ResourceType[],
  options: PruneOptions,
): Promise<void> {
  const groups = collectOrphans(resourceTypes, options.all === true);

  if (groups.length === 0) {
    console.log(chalk.green('No orphans.'));
    return;
  }

  const total = groups.reduce((n, g) => n + g.orphans.length, 0);

  console.log(chalk.bold('Orphans (in version home, not in any source)\n'));
  for (const g of groups) {
    const label = `${g.type} · ${g.agent}@${g.version}`;
    console.log(`  ${chalk.cyan(label)}  ${g.orphans.join(', ')}`);
  }
  console.log();

  if (options.dryRun) {
    console.log(chalk.gray(`${total} orphan(s). Run without --dry-run to delete.`));
    return;
  }

  if (!options.yes) {
    if (!isInteractiveTerminal()) {
      console.log(chalk.yellow('Non-interactive shell: pass -y to confirm, or --dry-run to preview.'));
      process.exit(1);
    }
    let ok = false;
    try {
      ok = await confirm({
        message: `Delete ${total} orphan${total === 1 ? '' : 's'}?`,
        default: false,
      });
    } catch (err) {
      if (isPromptCancelled(err)) {
        console.log(chalk.gray('Cancelled'));
        return;
      }
      throw err;
    }
    if (!ok) {
      console.log(chalk.gray('Cancelled'));
      return;
    }
  }

  let removed = 0;
  let failures = 0;
  for (const g of groups) {
    for (const name of g.orphans) {
      const r = removeOne(g, name);
      if (r.success) {
        removed++;
      } else {
        failures++;
        console.log(chalk.red(`  ! ${g.type} ${g.agent}@${g.version} ${name}: ${r.error}`));
      }
    }
  }

  const summary = `Pruned ${removed} orphan${removed === 1 ? '' : 's'}`;
  console.log(chalk.green(summary) + (failures > 0 ? chalk.red(`, ${failures} failed`) : '') + '.');
}

export function registerPruneCommand(program: Command): void {
  program
    .command('prune [target]')
    .description('Remove orphan resources (commands/skills/hooks) and/or older duplicate version installs (versions soft-deleted to ~/.agents-system/trash/)')
    .option('--all', 'For orphan cleanup: sweep every installed version (default: current default version per agent)')
    .option('--dry-run', 'Show what would be removed without deleting')
    .option('-y, --yes', 'Skip confirmation prompt')
    .addHelpText('after', `
Targets:
  (none)     Orphans across commands, skills, hooks + duplicate versions
  commands   Orphan command files only
  skills     Orphan skill directories only
  hooks      Orphan hook scripts only
  versions   Older duplicate version installs only
  <agent>    Older duplicate versions for one agent (e.g. 'claude')

Examples:
  # Full sweep: orphan resources + duplicate versions for current defaults
  agents prune

  # Just orphan skills
  agents prune skills

  # Just version dedup
  agents prune versions

  # Just version dedup for one agent
  agents prune claude

  # Sweep every installed version's orphans, not only the defaults
  agents prune --all

  # Preview without deleting
  agents prune --dry-run

What's an orphan?
  A command, skill, or hook present inside a version home but missing from every
  configured source (project .agents/, central ~/.agents/, and any enabled extra
  repos). Usually leftovers from a resource that was deleted or moved but never
  reconciled into the version install.

What this does NOT do:
  Adds and updates flow through the auto-sync that runs when you launch the
  agent — there is no manual sync verb.

Soft-delete:
  Version directories are NEVER hard-deleted. \`prune\` moves them to
  ~/.agents-system/trash/versions/<agent>/<version>/<timestamp>/. Recover
  with \`agents trash list\` and \`agents trash restore <agent>@<version>\`.
  The trash never auto-expires; \`rm -rf\` it manually when you're sure.
`)
    .action(async (target: string | undefined, options: PruneOptions) => {
      const parsed = parseTarget(target);

      if (parsed.resourceTypes.length > 0) {
        await runOrphanPrune(parsed.resourceTypes, options);
        if (parsed.includeVersions) console.log();
      }

      if (parsed.includeVersions) {
        const versionLabel = parsed.versionAgent ? ` for ${parsed.versionAgent}` : '';
        console.log(chalk.bold(`Duplicate versions${versionLabel}`));
        await pruneDuplicates(parsed.versionAgent, options.yes === true, options.dryRun === true);
      }
    });
}
