/**
 * Top-level `agents prune` — remove orphan resources from version homes.
 *
 * Orphans are files in a version's home directory that no longer correspond to
 * anything in central storage (deleted from ~/.agents/ or never sourced from
 * an enabled extras repo). They accumulate when you remove a command/skill/hook
 * locally but never reconcile the version homes that still hold the old copy.
 *
 * Sync is no longer a user-facing concept — `syncResourcesToVersion` runs at
 * agent launch and applies adds/updates automatically. Pruning, however, is
 * destructive, so it stays an explicit verb.
 *
 * Default scope: each agent's currently-pinned default version. Pass `--all`
 * to sweep every installed version of every capable agent.
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
import { isInteractiveTerminal, isPromptCancelled } from './utils.js';

type ResourceType = 'commands' | 'skills' | 'hooks';
const ALL_TYPES: ResourceType[] = ['commands', 'skills', 'hooks'];

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

/**
 * Filter a (agent, version) iterator down to each agent's default version when
 * `--all` is not passed. Agents without a default are dropped silently — the
 * intent of bare `agents prune` is "clean up what I'm using right now."
 */
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

function parseType(arg: string | undefined): ResourceType[] {
  if (!arg) return ALL_TYPES;
  if (!ALL_TYPES.includes(arg as ResourceType)) {
    console.log(chalk.red(`Unknown resource type: ${arg}`));
    console.log(chalk.gray(`Available: ${ALL_TYPES.join(', ')}`));
    process.exit(1);
  }
  return [arg as ResourceType];
}

export function registerPruneCommand(program: Command): void {
  program
    .command('prune [type]')
    .description('Remove orphan resources from version homes (files locally that no longer source from anywhere)')
    .option('--all', 'Sweep every installed version (default: current default version per agent)')
    .option('--dry-run', 'Show orphans without deleting')
    .option('-y, --yes', 'Skip confirmation prompt')
    .addHelpText('after', `
Examples:
  # Prune orphans across commands, skills, and hooks for current default versions
  agents prune

  # Scope to one resource type
  agents prune skills

  # Sweep every installed version of every agent
  agents prune --all

  # Preview without deleting
  agents prune --dry-run

  # Skip the confirmation (for scripts)
  agents prune -y

What's an orphan?
  A command, skill, or hook present inside a version home but missing from every
  configured source (project .agents/, central ~/.agents/, and any enabled extra
  repos). Usually leftovers from a resource that was deleted or moved but never
  reconciled into the version install.

What this does NOT do:
  This is destructive cleanup only. Adds and updates flow through the auto-sync
  that runs when you launch the agent — there's no manual sync verb.
`)
    .action(async (typeArg: string | undefined, options: PruneOptions) => {
      const types = parseType(typeArg);
      const groups = collectOrphans(types, options.all === true);

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
    });
}
