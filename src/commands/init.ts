/**
 * First-run initialization command.
 *
 * Registers the `agents init` command which clones the system repo into
 * ~/.agents-system/ and installs agent CLIs with resource syncing.
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { confirm } from '@inquirer/prompts';
import type { AgentId } from '../lib/types.js';
import { DEFAULT_SYSTEM_REPO, systemRepoSlug } from '../lib/types.js';
import { getAgentsDir, getVersionsDir } from '../lib/state.js';
import { isGitRepo } from '../lib/git.js';
import { isPromptCancelled, isInteractiveTerminal } from './utils.js';
import { AGENTS, getUnmanagedAgentInstalls, countSessionFiles, agentLabel } from '../lib/agents.js';
import { setGlobalDefault } from '../lib/versions.js';
import { ensureShimCurrent, switchHomeFileSymlinks, isShimsInPath, addShimsToPath, getPathSetupInstructions } from '../lib/shims.js';

const HOME = os.homedir();

/**
 * Import an existing unmanaged agent installation into agents-cli.
 * Moves the config dir into the versions structure and creates a symlink.
 */
async function importAgent(agentId: AgentId, version: string): Promise<{ success: boolean; skipped?: boolean; error?: string }> {
  const agent = AGENTS[agentId];
  const configDir = agent.configDir;
  const versionsDir = getVersionsDir();
  const versionHome = path.join(versionsDir, agentId, version, 'home');
  const versionConfigDir = path.join(versionHome, `.${agentId}`);

  // Skip if version dir already exists (collision)
  if (fs.existsSync(versionConfigDir)) {
    return { success: false, skipped: true, error: `${version} already installed` };
  }

  try {
    // Create version home directory
    fs.mkdirSync(versionHome, { recursive: true });

    // Move existing config dir into version home
    fs.renameSync(configDir, versionConfigDir);

    // Create symlink from original location to version config
    fs.symlinkSync(versionConfigDir, configDir);

    // Set as global default
    setGlobalDefault(agentId, version);

    // Handle home-level files (e.g. ~/.claude.json)
    switchHomeFileSymlinks(agentId, version);

    // Ensure shim exists
    ensureShimCurrent(agentId);

    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

/** First-run setup. Delegates to `agents pull`, which clones the system repo if needed. */
export async function runInit(program: Command, options: { force?: boolean } = {}): Promise<void> {
  const agentsDir = getAgentsDir();
  const metaFile = path.join(agentsDir, 'agents.yaml');
  const alreadyConfigured = fs.existsSync(metaFile) || isGitRepo(agentsDir);

  if (alreadyConfigured && !options.force) {
    console.log(chalk.gray('~/.agents-system/ is already set up.'));
    console.log(chalk.gray('\nTo sync updates:      agents pull'));
    console.log(chalk.gray('To re-initialize:     agents init --force'));
    return;
  }

  // Detect existing installations BEFORE cloning (they won't exist after if we import)
  const unmanaged = await getUnmanagedAgentInstalls();
  const sessionCounts: Partial<Record<AgentId, number>> = {};
  for (const install of unmanaged) {
    sessionCounts[install.agentId] = countSessionFiles(install.agentId);
  }

  console.log(chalk.bold('\nWelcome to agents-cli.'));
  console.log(chalk.gray(`Cloning the system repo from ${systemRepoSlug(DEFAULT_SYSTEM_REPO)} into ~/.agents-system/.\n`));

  console.log();
  await program.parseAsync(['node', 'agents', 'pull']);

  // `agents pull` prints its own error but doesn't throw — verify the clone actually
  // landed before claiming success. Without this check the wizard would celebrate even
  // when pull failed (e.g. empty repo, bad ref, network error).
  if (!isGitRepo(agentsDir)) {
    console.log(chalk.red('\nSetup did not complete — see errors above.'));
    console.log(chalk.gray('Fix the issue and re-run: agents init --force'));
    process.exit(1);
  }

  // Offer to import existing unmanaged installations
  if (unmanaged.length > 0 && isInteractiveTerminal()) {
    console.log(chalk.bold('\nFound existing installations:\n'));

    const maxAgentLen = Math.max(...unmanaged.map(i => agentLabel(i.agentId).length));
    for (const install of unmanaged) {
      const label = agentLabel(install.agentId).padEnd(maxAgentLen);
      const sessions = sessionCounts[install.agentId] || 0;
      const sessionStr = sessions > 0 ? `${sessions} sessions` : 'no sessions';
      const versionStr = install.version ? `v${install.version}` : '';
      console.log(`  ${chalk.cyan(label)}  ${install.configDir}  ${chalk.gray(sessionStr)}  ${chalk.gray(versionStr)}`);
    }

    console.log();
    const shouldImport = await confirm({
      message: 'Import these under agents-cli management?',
      default: true,
    });

    if (shouldImport) {
      console.log();
      for (const install of unmanaged) {
        const version = install.version || 'unknown';
        const spinner = ora(`Importing ${agentLabel(install.agentId)} v${version}...`).start();

        const result = await importAgent(install.agentId, version);
        if (result.success) {
          spinner.succeed(`${agentLabel(install.agentId)} imported`);
        } else if (result.skipped) {
          spinner.warn(`${agentLabel(install.agentId)}: ${result.error} (skipped)`);
        } else {
          spinner.fail(`${agentLabel(install.agentId)}: ${result.error}`);
        }
      }

      // Ensure shims are in PATH
      if (!isShimsInPath()) {
        const pathResult = addShimsToPath();
        if (pathResult.success && !pathResult.alreadyPresent) {
          console.log(chalk.green(`\nAdded shims to ~/${pathResult.rcFile}`));
          console.log(chalk.gray('Restart your shell or run: source ~/' + pathResult.rcFile));
        } else if (!pathResult.success) {
          console.log(chalk.yellow('\nTo enable version switching, add shims to PATH:'));
          console.log(chalk.gray(getPathSetupInstructions()));
        }
      }

      // Show total session count
      const totalSessions = Object.values(sessionCounts).reduce((a, b) => a + (b || 0), 0);
      if (totalSessions > 0) {
        const breakdown = unmanaged
          .filter(i => (sessionCounts[i.agentId] || 0) > 0)
          .map(i => `${agentLabel(i.agentId)} (${sessionCounts[i.agentId] || 0})`)
          .join(', ');
        console.log(chalk.gray(`\n${totalSessions} sessions available across ${breakdown}`));
        console.log(chalk.cyan('  agents sessions') + chalk.gray('  # browse them'));
      }
    }
  }

  console.log(chalk.bold('\nSetup complete. Try:'));
  console.log(chalk.cyan('  agents view                 ') + chalk.gray(' # see what\'s installed'));
  console.log(chalk.cyan('  agents run <agent> "hello"  ') + chalk.gray(' # run an agent'));
  console.log(chalk.gray('\nWhen you want your own editable repo, scaffold one with:'));
  console.log(chalk.cyan('  agents repo init'));
}

/** Register the `agents init` command. */
export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description('Set up agents-cli for the first time. Clones a config repo and installs agent CLIs.')
    .option('-f, --force', 'Reinitialize even if ~/.agents-system/ already exists (use with caution)')
    .addHelpText('after', `
Examples:
  # First-time setup (clones the system repo into ~/.agents-system/)
  agents init

  # Re-initialize after corruption
  agents init --force

When to use:
  - First time running agents-cli: this is your starting point
  - Onboarding a new machine: restore the system repo and installed CLIs
  - Repairing ~/.agents-system/ after accidental deletion or corruption

What it does:
  1. Clones the system repo into ~/.agents-system/
  2. Installs agent CLIs based on agents.yaml in that repo
  3. Syncs commands, skills, hooks, and MCP servers to each version

Non-interactive alternative:
  Skip 'init' and run:
    agents pull
`)
    .action(async (options) => {
      try {
        await runInit(program, options);
      } catch (err) {
        if (isPromptCancelled(err)) {
          console.log(chalk.yellow('\nCancelled'));
          return;
        }
        throw err;
      }
    });
}
