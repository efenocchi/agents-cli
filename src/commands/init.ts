/**
 * First-run initialization command.
 *
 * Registers the `agents init` command which clones the system repo into
 * ~/.agents-system/ and installs agent CLIs with resource syncing.
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';
import { DEFAULT_SYSTEM_REPO, systemRepoSlug } from '../lib/types.js';
import { getAgentsDir } from '../lib/state.js';
import { isGitRepo } from '../lib/git.js';
import { isPromptCancelled } from './utils.js';

/** First-run setup. Delegates to `agents pull`, which clones the system repo if needed. */
export async function runInit(program: Command, options: { force?: boolean } = {}): Promise<void> {
  const agentsDir = getAgentsDir();
  const metaFile = path.join(agentsDir, 'agents.yaml');
  const alreadyConfigured = fs.existsSync(metaFile) || isGitRepo(agentsDir);

  if (alreadyConfigured && !options.force) {
    console.log(chalk.yellow('~/.agents-system/ is already set up.'));
    console.log(chalk.gray('\nTo sync updates:      agents pull'));
    console.log(chalk.gray('To re-initialize:     agents init --force'));
    return;
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

  console.log(chalk.bold('\nSetup complete. Try:'));
  console.log(chalk.cyan('  agents view                 ') + chalk.gray(' # see what\'s installed'));
  console.log(chalk.cyan('  agents run <agent> "hello"  ') + chalk.gray(' # run an agent'));
  console.log(chalk.gray('\nWhen you want your own editable repo, scaffold one with:'));
  console.log(chalk.cyan('  agents repo init --path ~/.agents'));
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
