/**
 * Internal resource sync command.
 *
 * Registers the hidden `agents sync` command invoked by shims to
 * synchronize resources (commands, skills, hooks, memory, MCP, etc.)
 * into a specific agent version home before launch.
 */

import * as path from 'path';
import { Command } from 'commander';
import chalk from 'chalk';
import { AGENTS } from '../lib/agents.js';
import { isVersionInstalled, syncResourcesToVersion } from '../lib/versions.js';
import { compileRulesForProject } from '../lib/rules/compile.js';

/** Register the hidden `agents sync` command. */
export function registerSyncCommand(program: Command): void {
  program
    .command('sync', { hidden: true })
    .description('Internal: sync resources to a version home. Called by shims, not directly by users.')
    .requiredOption('--agent <agent>', 'Agent identifier (claude, codex, gemini, cursor, opencode, openclaw)')
    .requiredOption('--agent-version <version>', 'Installed version to sync resources into')
    .option('--project-dir <path>', 'Path to project-level .agents/ directory containing project-scoped resources')
    .option('--cwd <path>', 'Working directory for discovering project manifest and resources')
    .option('--quiet', 'Suppress all output (exit code indicates success)', false)
    .action((opts) => {
      const agentId = opts.agent as keyof typeof AGENTS;
      const version = opts.agentVersion as string;
      const projectDir = opts.projectDir as string | undefined;
      const cwd = opts.cwd as string | undefined;
      const quiet = !!opts.quiet;

      if (!AGENTS[agentId]) {
        if (!quiet) {
          console.error(chalk.red(`Unknown agent '${agentId}'`));
        }
        process.exitCode = 1;
        return;
      }

      if (!isVersionInstalled(agentId, version)) {
        if (!quiet) {
          console.error(chalk.red(`${AGENTS[agentId].name}@${version} is not installed`));
        }
        process.exitCode = 1;
        return;
      }

      const result = syncResourcesToVersion(agentId, version, undefined, { projectDir, cwd });

      // Compile project-scope rules into the workspace itself so each agent's
      // native loader picks up cwd/<INSTRUCTIONS_FILE>. projectDir is the
      // .agents/ directory; the workspace root is its parent.
      let projectCompile: ReturnType<typeof compileRulesForProject> | null = null;
      if (projectDir) {
        const projectRoot = path.dirname(projectDir);
        projectCompile = compileRulesForProject(projectRoot);
      }

      if (quiet) {
        return;
      }

      const synced: string[] = [];
      if (result.commands) synced.push('commands');
      if (result.skills) synced.push('skills');
      if (result.hooks) synced.push('hooks');
      if (result.memory.length > 0) synced.push('memory');
      if (result.permissions) synced.push('permissions');
      if (result.mcp.length > 0) synced.push('mcp');
      if (result.subagents.length > 0) synced.push('subagents');
      if (result.plugins.length > 0) synced.push('plugins');

      if (synced.length > 0) {
        console.log(chalk.green(`Synced ${synced.join(', ')} to ${agentId}@${version}`));
      } else {
        console.log(chalk.gray('No resources to sync'));
      }

      if (projectCompile?.compiled) {
        const linkInfo = projectCompile.symlinks.length > 0
          ? ` (+ ${projectCompile.symlinks.join(', ')})`
          : '';
        console.log(chalk.gray(`Compiled project rules → ${projectCompile.agentsPath}${linkInfo}`));
      }
      if (projectCompile && projectCompile.skippedClobber.length > 0) {
        console.log(chalk.yellow(
          `Skipped (user-authored, not overwritten): ${projectCompile.skippedClobber.join(', ')}`,
        ));
      }
    });
}
