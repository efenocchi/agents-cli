/**
 * Extra DotAgent repo management.
 *
 * Registers `agents repo add|init|list|remove|enable|disable` which manage
 * additional DotAgent repos alongside the primary ~/.agents-system/ repo so
 * private, work, or team skills can ship separately from public ones.
 *
 * Extras are user-level config: managed clones live at ~/.agents-<alias>/ as
 * peer dirs to ~/.agents/, and user-owned repos may live anywhere. All extras
 * are registered in meta.extraRepos. Sync functions merge their resources into
 * agent version homes after the user repo's (user-wins on name collisions).
 */
import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import simpleGit from 'simple-git';
import { confirm, input } from '@inquirer/prompts';
import { isInteractiveTerminal, isPromptCancelled } from './utils.js';
import { setHelpSections } from '../lib/help.js';

const HOME = os.homedir();

/**
 * Resolve a target argument to an absolute path.
 * - No arg: ~/.agents/
 * - Looks like a path (starts with /, ~, .): resolve as path
 * - Otherwise: ~/.agents-{name}/
 */
function resolveRepoPath(target?: string): string {
  if (!target) return path.join(HOME, '.agents');
  const trimmed = target.trim();
  if (trimmed.startsWith('/') || trimmed.startsWith('~') || trimmed.startsWith('.')) {
    return path.resolve(trimmed.replace(/^~/, HOME));
  }
  return path.join(HOME, `.agents-${trimmed}`);
}

import {
  ensureAgentsDir,
  getExtraRepoDir,
  getSystemAgentsDir,
  getUserAgentsDir,
  readMeta,
  resolveExtraRepoDir,
  updateMeta,
} from '../lib/state.js';
import { parseSource, pullRepo, commitAndPush, isGitRepo, isSystemRepoOrigin } from '../lib/git.js';
import { DEFAULT_SYSTEM_REPO } from '../lib/types.js';
import type { ExtraRepoConfig } from '../lib/types.js';

const ALIAS_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

/** Derive a default alias from a source URL (e.g. gh:foo/.agents-work -> agents-work). */
function deriveAlias(source: string): string {
  const parsed = parseSource(source);
  let base: string;
  if (parsed.type === 'local') {
    base = path.basename(parsed.url);
  } else {
    const match = parsed.url.match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
    base = match ? match[2] : parsed.url;
  }
  // Strip leading dots and any "agents-" prefix so the alias is short and
  // becomes ~/.agents-<alias>/ on disk (e.g. ".agents-work" -> "work").
  return base.replace(/^\.+/, '').replace(/^agents-/, '') || 'repo';
}

/** Get the last commit short hash for a repo, or null if unavailable. */
async function getShortCommit(repoDir: string): Promise<string | null> {
  try {
    const git = simpleGit(repoDir);
    const log = await git.log({ maxCount: 1 });
    return log.latest?.hash.slice(0, 8) || null;
  } catch {
    return null;
  }
}

/**
 * Categorized working-tree summary: `M:2 A:1 D:1 ?:3` — letters match the git
 * porcelain shorthand (Modified / Added / Deleted / Renamed / Unmerged /
 * Untracked). Zero counts are omitted so the column stays compact.
 */
function formatDirtyCounts(status: {
  modified: string[];
  created: string[];
  deleted: string[];
  renamed: unknown[];
  conflicted: string[];
  not_added: string[];
}): string {
  const parts: string[] = [];
  if (status.modified.length) parts.push(chalk.yellow(`M:${status.modified.length}`));
  if (status.created.length) parts.push(chalk.green(`A:${status.created.length}`));
  if (status.deleted.length) parts.push(chalk.red(`D:${status.deleted.length}`));
  if (status.renamed.length) parts.push(chalk.cyan(`R:${status.renamed.length}`));
  if (status.conflicted.length) parts.push(chalk.magenta(`U:${status.conflicted.length}`));
  if (status.not_added.length) parts.push(chalk.gray(`?:${status.not_added.length}`));
  return parts.join(' ');
}

/** Register the `agents repo` command tree. */
export function registerRepoCommands(program: Command): void {
  const repoCmd = program
    .command('repo')
    .description('Manage extra DotAgent repos alongside ~/.agents/ (for private or team skills).');

  setHelpSections(repoCmd, {
    examples: `
      # Scaffold an editable repo (default: ~/.agents/)
      agents repo init

      # Scaffold a named repo at ~/.agents-work/
      agents repo init work

      # Register an existing repo (clones to ~/.agents-<alias>/)
      agents repo add gh:yourname/.agents-work

      # Register with a custom alias
      agents repo add git@github.com:acme/team-skills.git --as acme

      # See what's registered
      agents repo list

      # Temporarily disable without deleting
      agents repo disable acme
    `,
    notes: `
      Managed extras live at ~/.agents-<alias>/ as peer dirs to ~/.agents/. User-owned
      repos can also live anywhere and be registered by path.

      Resolution: skills/commands/hooks merge into agent version homes after the user
      repo's, so ~/.agents/ wins on name collisions.
    `,
  });

  repoCmd
    .command('init [target]')
    .description('Create a user-owned repo from a template and register it as an extra')
    .option('--from <source>', 'Template repo to clone from', DEFAULT_SYSTEM_REPO)
    .option('--as <alias>', 'Alias to register under (defaults to the directory name)')
    .action(async (target: string | undefined, options: { from: string; as?: string }) => {
      let targetDir = resolveRepoPath(target);

      if (!target && fs.existsSync(targetDir)) {
        if (!isInteractiveTerminal()) {
          console.log(chalk.red(`Path already exists: ${targetDir}`));
          console.log(chalk.gray('Pass a name (e.g. `agents repo init work` -> ~/.agents-work) or a path.'));
          process.exitCode = 1;
          return;
        }
        try {
          const name = await input({
            message: 'Name for your repo:',
            default: 'work',
            validate: (raw: string) => {
              const v = raw.trim();
              if (!v) return 'Required';
              if (!ALIAS_PATTERN.test(v)) return 'Letters, digits, "_" or "-"; must start with letter/digit';
              const candidate = path.join(HOME, `.agents-${v}`);
              if (fs.existsSync(candidate)) return `~/.agents-${v} already exists`;
              return true;
            },
            theme: { prefix: chalk.gray('Will be created at $HOME/.agents-<name>/') } as any,
          });
          targetDir = path.join(HOME, `.agents-${name.trim()}`);
        } catch (err) {
          if (isPromptCancelled(err)) {
            process.exit(130);
          }
          throw err;
        }
      }

      const alias = options.as ? options.as.trim() : (path.basename(targetDir).replace(/^\.+/, '') || 'repo');
      if (!ALIAS_PATTERN.test(alias)) {
        console.log(chalk.red(`Invalid alias "${alias}".`));
        process.exitCode = 1;
        return;
      }

      const meta = readMeta();
      const extras: Record<string, ExtraRepoConfig> = { ...(meta.extraRepos || {}) };
      if (extras[alias]) {
        console.log(chalk.red(`Alias "${alias}" is already registered.`));
        process.exitCode = 1;
        return;
      }
      if (fs.existsSync(targetDir)) {
        console.log(chalk.red(`Path already exists: ${targetDir}`));
        process.exitCode = 1;
        return;
      }

      const parsed = parseSource(options.from);
      const spinner = ora(`Cloning ${options.from} into ${targetDir}...`).start();
      try {
        fs.mkdirSync(path.dirname(targetDir), { recursive: true });
        await simpleGit().clone(parsed.url, targetDir);
        await simpleGit(targetDir).removeRemote('origin');
        const log = await simpleGit(targetDir).log({ maxCount: 1 });
        const commit = log.latest?.hash.slice(0, 8) || 'unknown';
        extras[alias] = { url: targetDir, path: targetDir, enabled: true };
        updateMeta({ extraRepos: extras });
        spinner.succeed(`Created ${targetDir} (${commit})`);
        console.log(chalk.gray(`\nRegistered as "${alias}". Edit files there, then add your own git remote when ready.`));
      } catch (err) {
        spinner.fail(`Init failed: ${(err as Error).message}`);
        try {
          fs.rmSync(targetDir, { recursive: true, force: true });
        } catch {
          /* best-effort cleanup */
        }
        process.exitCode = 1;
      }
    });

  repoCmd
    .command('add <source>')
    .description('Register an existing local repo or clone a remote repo into ~/.agents-<alias>/')
    .option('--as <alias>', 'Override the auto-derived alias (letters, digits, _ or -)')
    .action(async (source: string, options: { as?: string }) => {
      const meta = readMeta();
      const extras: Record<string, ExtraRepoConfig> = { ...(meta.extraRepos || {}) };

      const alias = options.as ? options.as.trim() : deriveAlias(source);
      if (!ALIAS_PATTERN.test(alias)) {
        console.log(chalk.red(`Invalid alias "${alias}".`));
        console.log(chalk.gray('Alias must start with a letter/digit and contain only letters, digits, "_" or "-".'));
        process.exitCode = 1;
        return;
      }
      if (extras[alias]) {
        console.log(chalk.red(`Alias "${alias}" is already registered.`));
        console.log(chalk.gray(`Existing: ${extras[alias].url}`));
        console.log(chalk.gray(`Use --as <other-alias>, or: agents repo remove ${alias}`));
        process.exitCode = 1;
        return;
      }

      let parsed;
      try {
        parsed = parseSource(source);
      } catch (err) {
        console.log(chalk.red((err as Error).message));
        process.exitCode = 1;
        return;
      }

      if (parsed.type === 'local') {
        extras[alias] = { url: parsed.url, path: parsed.url, enabled: true };
        updateMeta({ extraRepos: extras });
        console.log(chalk.green(`Registered local repo "${alias}" -> ${parsed.url}`));
        return;
      }

      ensureAgentsDir();
      const targetDir = getExtraRepoDir(alias);
      if (fs.existsSync(targetDir)) {
        console.log(chalk.red(`Directory already exists: ${targetDir}`));
        console.log(chalk.gray('Remove it manually or pick a different alias with --as.'));
        process.exitCode = 1;
        return;
      }

      const spinner = ora(`Cloning ${source}...`).start();
      try {
        fs.mkdirSync(path.dirname(targetDir), { recursive: true });
        await simpleGit().clone(parsed.url, targetDir);
        if (parsed.ref) {
          await simpleGit(targetDir).checkout(parsed.ref);
        }
        const log = await simpleGit(targetDir).log({ maxCount: 1 });
        const commit = log.latest?.hash.slice(0, 8) || 'unknown';
        spinner.succeed(`Cloned ${source} -> ${targetDir} (${commit})`);
      } catch (err) {
        spinner.fail(`Clone failed: ${(err as Error).message}`);
        try {
          fs.rmSync(targetDir, { recursive: true, force: true });
        } catch {
          /* best-effort cleanup */
        }
        process.exitCode = 1;
        return;
      }

      extras[alias] = { url: parsed.url, path: targetDir, enabled: true };
      updateMeta({ extraRepos: extras });

      console.log(chalk.gray(`\nRegistered as "${alias}". Skills and commands from this repo will be`));
      console.log(chalk.gray(`picked up automatically the next time you launch any agent.`));
    });

  repoCmd
    .command('list')
    .alias('ls')
    .description('Show all repos: system, user, and any registered extras')
    .action(async () => {
      const meta = readMeta();
      console.log('');

      // System repo
      const systemUrl = meta.source || DEFAULT_SYSTEM_REPO;
      const systemDir = getSystemAgentsDir();
      const systemOnDisk = fs.existsSync(systemDir);
      const systemIsGit = systemOnDisk && isGitRepo(systemDir);
      const systemCommit = systemIsGit ? await getShortCommit(systemDir) : null;
      const systemStatus = !systemOnDisk
        ? chalk.red('missing')
        : !systemIsGit
          ? chalk.yellow('not a git repo — run: agents setup')
          : chalk.green('cloned');
      const systemCommitLabel = systemCommit ? chalk.gray(`(${systemCommit})`) : '';
      console.log(chalk.bold('System  (~/.agents-system/)'));
      console.log(`  ${chalk.cyan('system'.padEnd(12))}  ${systemUrl}  ${systemStatus}  ${systemCommitLabel}`);

      // User repo
      const userDir = getUserAgentsDir();
      const userOnDisk = fs.existsSync(userDir);
      const userIsGit = userOnDisk && isGitRepo(userDir);
      const userCommit = userIsGit ? await getShortCommit(userDir) : null;
      let userRemoteUrl = '';
      if (userIsGit) {
        try {
          const git = simpleGit(userDir);
          const remotes = await git.getRemotes(true);
          const origin = remotes.find(r => r.name === 'origin');
          userRemoteUrl = origin?.refs?.fetch || '';
        } catch { /* no remote */ }
      }
      const userStatus = !userOnDisk
        ? chalk.gray('not created')
        : !userIsGit
          ? chalk.gray('local (no remote)')
          : chalk.green('cloned');
      const userCommitLabel = userCommit ? chalk.gray(`(${userCommit})`) : '';
      console.log(chalk.bold('\nUser  (~/.agents/)'));
      console.log(`  ${chalk.cyan('user'.padEnd(12))}  ${userRemoteUrl || '~/.agents/'}  ${userStatus}  ${userCommitLabel}`);
      if (!userIsGit) {
        console.log(chalk.gray(`  ${''.padEnd(12)}  scaffold one with: agents repo init`));
      }

      // Extra repos
      const extras = meta.extraRepos || {};
      const aliases = Object.keys(extras);
      console.log(chalk.bold('\nExtras:'));
      if (aliases.length === 0) {
        console.log(chalk.gray('  (none — add one with `agents repo add <source>`)\n'));
        return;
      }

      for (const alias of aliases) {
        const config = extras[alias];
        const dir = resolveExtraRepoDir(alias, config);
        const onDisk = fs.existsSync(dir);
        const commit = onDisk ? await getShortCommit(dir) : null;

        const status = !config.enabled
          ? chalk.yellow('disabled')
          : !onDisk
            ? chalk.red('missing')
            : chalk.green('enabled');
        const commitLabel = commit ? chalk.gray(`(${commit})`) : '';
        console.log(`  ${chalk.cyan(alias.padEnd(12))}  ${config.url}  ${status}  ${commitLabel}`);
      }
      console.log('');
    });

  repoCmd
    .command('remove <alias>')
    .alias('rm')
    .description('Unregister an extra repo. Managed clones are deleted; external paths are kept.')
    .action(async (alias: string) => {
      const meta = readMeta();
      const extras: Record<string, ExtraRepoConfig> = { ...(meta.extraRepos || {}) };
      if (!extras[alias]) {
        console.log(chalk.red(`No extra repo registered as "${alias}".`));
        process.exitCode = 1;
        return;
      }

      const dir = resolveExtraRepoDir(alias, extras[alias]);
      // Managed clones live at the default ~/.agents-<alias>/ — those we own
      // and should delete on remove. Anything else is user-owned, leave alone.
      const isManagedClone = path.resolve(dir) === path.resolve(getExtraRepoDir(alias));
      try {
        if (isManagedClone && fs.existsSync(dir)) {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      } catch (err) {
        console.log(chalk.yellow(`Warning: could not delete ${dir}: ${(err as Error).message}`));
      }

      delete extras[alias];
      updateMeta({ extraRepos: extras });
      console.log(chalk.green(`Removed "${alias}"`));
    });

  repoCmd
    .command('enable <alias>')
    .description('Re-enable a previously disabled extra repo')
    .action(async (alias: string) => {
      await toggle(alias, true);
    });

  repoCmd
    .command('disable <alias>')
    .description('Stop merging this repo during sync without deleting the clone')
    .action(async (alias: string) => {
      await toggle(alias, false);
    });

  repoCmd
    .command('pull [alias]')
    .description('Pull updates. Aliases: "system" (~/.agents-system/), "user" (~/.agents/), or any registered extra. No arg pulls all.')
    .action(async (alias: string | undefined) => {
      const targets = collectRepoTargets(alias);
      if (!targets) {
        process.exitCode = 1;
        return;
      }
      if (targets.length === 0) {
        console.log(chalk.gray('No repos to pull.'));
        return;
      }
      for (const t of targets) {
        if (!fs.existsSync(t.dir) || !isGitRepo(t.dir)) {
          console.log(chalk.yellow(`  ${t.alias}: not a git repo, skipping`));
          continue;
        }
        if (t.alias === 'system') {
          // Skip system repo unless explicitly requested
          if (alias !== 'system') continue;

          // User explicitly asked for system repo — show status and offer to pull
          try {
            const git = simpleGit(t.dir);
            await git.fetch();
            const status = await git.status();
            const behind = status.behind ?? 0;
            if (behind === 0) {
              console.log(chalk.green('Up to date'));
            } else {
              // Count changed resources by type
              const diff = await git.diff(['--name-only', 'HEAD..@{upstream}']);
              const files = diff.split('\n').filter(Boolean);
              const counts: Record<string, number> = {};
              for (const f of files) {
                if (f.startsWith('skills/')) counts['skills'] = (counts['skills'] || 0) + 1;
                else if (f.startsWith('commands/')) counts['commands'] = (counts['commands'] || 0) + 1;
                else if (f.startsWith('hooks/')) counts['hooks'] = (counts['hooks'] || 0) + 1;
                else if (f.startsWith('rules/')) counts['rules'] = (counts['rules'] || 0) + 1;
                else counts['other'] = (counts['other'] || 0) + 1;
              }
              const parts: string[] = [];
              if (counts['skills']) parts.push(`${counts['skills']} skill${counts['skills'] > 1 ? 's' : ''}`);
              if (counts['commands']) parts.push(`${counts['commands']} command${counts['commands'] > 1 ? 's' : ''}`);
              if (counts['hooks']) parts.push(`${counts['hooks']} hook${counts['hooks'] > 1 ? 's' : ''}`);
              if (counts['rules']) parts.push(`${counts['rules']} rule${counts['rules'] > 1 ? 's' : ''}`);
              if (counts['other']) parts.push(`${counts['other']} other`);
              const summary = parts.length > 0 ? parts.join(', ') : `${behind} update${behind > 1 ? 's' : ''}`;
              console.log(chalk.yellow(`${summary} available`));

              if (isInteractiveTerminal()) {
                const doPull = await confirm({ message: 'Pull now?', default: true });
                if (doPull) {
                  const result = await pullRepo(t.dir);
                  if (result.success) {
                    console.log(chalk.green('Updated'));
                  } else {
                    console.log(chalk.red(result.error || 'Pull failed'));
                  }
                }
              }
            }
          } catch (err) {
            console.log(chalk.red((err as Error).message));
          }
          continue;
        }
        const spinner = ora(`Pulling ${t.alias}...`).start();
        const result = await pullRepo(t.dir);
        if (result.success) {
          spinner.succeed(`${t.alias} -> ${result.commit}`);
        } else {
          spinner.fail(`${t.alias}: ${result.error}`);
        }
      }
    });

  repoCmd
    .command('push [alias]')
    .description('Commit and push the user repo or a user-owned extra. Refuses to push the system repo.')
    .option('-m, --message <msg>', 'Commit message', 'Update via agents repo push')
    .action(async (alias: string | undefined, options: { message: string }) => {
      const targets = collectRepoTargets(alias);
      if (!targets) {
        process.exitCode = 1;
        return;
      }
      // Drop system-repo targets — read-only by design.
      const pushable: RepoTarget[] = [];
      for (const t of targets) {
        if (t.alias === 'system') {
          console.log(chalk.yellow('Skipping system repo (read-only — managed via the agents-cli upstream).'));
          continue;
        }
        if (!fs.existsSync(t.dir) || !isGitRepo(t.dir)) {
          console.log(chalk.yellow(`  ${t.alias}: not a git repo, skipping`));
          continue;
        }
        // Defense in depth: refuse if origin happens to be the system upstream.
        if (await isSystemRepoOrigin(t.dir)) {
          console.log(chalk.red(`  ${t.alias}: origin tracks the system repo — refusing to push.`));
          continue;
        }
        pushable.push(t);
      }
      if (pushable.length === 0) {
        console.log(chalk.gray('No pushable repos.'));
        return;
      }
      for (const t of pushable) {
        const spinner = ora(`Pushing ${t.alias}...`).start();
        const result = await commitAndPush(t.dir, options.message);
        if (result.success) {
          spinner.succeed(`${t.alias} pushed`);
        } else {
          spinner.fail(`${t.alias}: ${result.error}`);
        }
      }
    });

  repoCmd
    .command('status [alias]')
    .description('Per-repo summary: branch, ahead/behind upstream, working-tree state')
    .action(async (alias: string | undefined) => {
      const targets = collectRepoTargets(alias) || [];
      if (targets.length === 0) {
        console.log(chalk.gray('No git repos found.'));
        return;
      }
      console.log('');
      console.log(`  ${chalk.gray('REPO'.padEnd(12))} ${chalk.gray('BRANCH'.padEnd(28))}  ${chalk.gray('REMOTE'.padEnd(12))}  ${chalk.gray('LOCAL')}`);
      for (const t of targets) {
        if (!fs.existsSync(t.dir)) {
          console.log(`  ${chalk.cyan(t.alias.padEnd(12))} ${chalk.red('missing')} ${chalk.gray(t.dir)}`);
          continue;
        }
        if (!isGitRepo(t.dir)) {
          console.log(`  ${chalk.cyan(t.alias.padEnd(12))} ${chalk.gray('not a git repo')} ${chalk.gray(t.dir)}`);
          continue;
        }
        try {
          const git = simpleGit(t.dir);
          const status = await git.status();
          const branch = status.tracking || status.current || '(detached)';
          const remoteRaw =
            (status.ahead ?? 0) === 0 && (status.behind ?? 0) === 0
              ? 'in sync'
              : `+${status.ahead ?? 0} -${status.behind ?? 0}`;
          const remoteColored =
            (status.ahead ?? 0) === 0 && (status.behind ?? 0) === 0
              ? chalk.green(remoteRaw)
              : chalk.yellow(remoteRaw);
          const tree = status.isClean()
            ? chalk.green('clean')
            : formatDirtyCounts(status);
          const remotePad = ' '.repeat(Math.max(0, 12 - remoteRaw.length));
          console.log(`  ${chalk.cyan(t.alias.padEnd(12))} ${branch.padEnd(28)}  ${remoteColored}${remotePad}  ${tree}`);
        } catch (err) {
          console.log(`  ${chalk.cyan(t.alias.padEnd(12))} ${chalk.red('error')} ${(err as Error).message}`);
        }
      }
      console.log('');
    });
}

interface RepoTarget {
  alias: string;
  dir: string;
}

/**
 * Resolve an alias (or undefined for "all") to a list of repo targets.
 * Returns null when a named alias isn't found (callers should set exit code).
 */
function collectRepoTargets(alias: string | undefined): RepoTarget[] | null {
  const meta = readMeta();
  const extras = meta.extraRepos || {};

  const all: RepoTarget[] = [
    { alias: 'system', dir: getSystemAgentsDir() },
    { alias: 'user', dir: getUserAgentsDir() },
    ...Object.keys(extras)
      .filter((a) => extras[a].enabled)
      .map((a) => ({ alias: a, dir: resolveExtraRepoDir(a, extras[a]) })),
  ];

  if (!alias) return all;
  const found = all.find((t) => t.alias === alias) || (extras[alias]
    ? { alias, dir: resolveExtraRepoDir(alias, extras[alias]) }
    : null);
  if (!found) {
    console.log(chalk.red(`Unknown repo "${alias}". Use "system", "user", or a registered extra alias.`));
    return null;
  }
  return [found];
}

async function toggle(alias: string, enabled: boolean): Promise<void> {
  const meta = readMeta();
  const extras: Record<string, ExtraRepoConfig> = { ...(meta.extraRepos || {}) };
  if (!extras[alias]) {
    console.log(chalk.red(`No extra repo registered as "${alias}".`));
    process.exitCode = 1;
    return;
  }
  if (extras[alias].enabled === enabled) {
    console.log(chalk.gray(`"${alias}" is already ${enabled ? 'enabled' : 'disabled'}.`));
    return;
  }
  extras[alias] = { ...extras[alias], enabled };
  updateMeta({ extraRepos: extras });
  console.log(chalk.green(`${enabled ? 'Enabled' : 'Disabled'} "${alias}"`));
}
