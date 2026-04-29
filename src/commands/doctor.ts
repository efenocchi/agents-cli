/**
 * `agents doctor` — diagnostic readout across the install.
 *
 * Three sections:
 *   1. CLI availability — which agent binaries can be invoked.
 *   2. Sync status — per (agent, default-version), is the version-home sync
 *      manifest fresh? (sync runs at launch; this surfaces what would happen.)
 *   3. Orphans — per resource type per default version, count of files that
 *      would be removed by `agents prune`.
 *
 * Read-only: doctor never mutates state. Run `agents prune` to act on the
 * orphan readout, or just launch the agent to apply pending sync.
 */
import type { Command } from 'commander';
import chalk from 'chalk';
import { checkAllClis } from '../lib/teams/agents.js';
import { AGENTS, ALL_AGENT_IDS } from '../lib/agents.js';
import type { AgentId } from '../lib/types.js';
import {
  getAvailableResources,
  getGlobalDefault,
} from '../lib/versions.js';
import { loadSyncManifest, isSyncStale } from '../lib/sync-manifest.js';
import { diffVersionCommands, iterCommandsCapableVersions } from '../lib/commands.js';
import { diffVersionSkills, iterSkillsCapableVersions } from '../lib/skills.js';
import { diffVersionHooks, iterHooksCapableVersions } from '../lib/hooks.js';

const AGENT_NAMES: Record<string, string> = Object.fromEntries(
  ALL_AGENT_IDS.map((id) => [id, AGENTS[id].name]),
);

interface DoctorOptions {
  json?: boolean;
}

interface SyncStatusRow {
  agent: AgentId;
  version: string;
  status: 'fresh' | 'stale' | 'never-synced';
}

interface OrphanRow {
  agent: AgentId;
  version: string;
  commands: number;
  skills: number;
  hooks: number;
}

function checkSyncStatus(cwd: string): SyncStatusRow[] {
  const rows: SyncStatusRow[] = [];
  for (const agent of ALL_AGENT_IDS) {
    const version = getGlobalDefault(agent);
    if (!version) continue;
    const manifest = loadSyncManifest(agent, version);
    if (!manifest) {
      rows.push({ agent, version, status: 'never-synced' });
      continue;
    }
    const available = getAvailableResources(cwd);
    const stale = isSyncStale(manifest, available, agent, version, cwd);
    rows.push({ agent, version, status: stale ? 'stale' : 'fresh' });
  }
  return rows;
}

function countOrphans(): OrphanRow[] {
  const byKey = new Map<string, OrphanRow>();

  const ensure = (agent: AgentId, version: string): OrphanRow => {
    const key = `${agent}@${version}`;
    let row = byKey.get(key);
    if (!row) {
      row = { agent, version, commands: 0, skills: 0, hooks: 0 };
      byKey.set(key, row);
    }
    return row;
  };

  for (const { agent, version } of iterCommandsCapableVersions()) {
    if (version !== getGlobalDefault(agent)) continue;
    const diff = diffVersionCommands(agent, version);
    if (diff.orphans.length > 0) ensure(agent, version).commands = diff.orphans.length;
  }
  for (const { agent, version } of iterSkillsCapableVersions()) {
    if (version !== getGlobalDefault(agent)) continue;
    const diff = diffVersionSkills(agent, version);
    if (diff.orphans.length > 0) ensure(agent, version).skills = diff.orphans.length;
  }
  for (const { agent, version } of iterHooksCapableVersions()) {
    if (version !== getGlobalDefault(agent)) continue;
    const diff = diffVersionHooks(agent, version);
    if (diff.orphans.length > 0) ensure(agent, version).hooks = diff.orphans.length;
  }

  return Array.from(byKey.values()).filter((r) => r.commands + r.skills + r.hooks > 0);
}

function renderText(
  clis: ReturnType<typeof checkAllClis>,
  syncRows: SyncStatusRow[],
  orphanRows: OrphanRow[],
): void {
  console.log(chalk.bold('Agent CLIs'));
  if (Object.keys(clis).length === 0) {
    console.log(chalk.gray('  (no agents reported)'));
  } else {
    for (const [name, entry] of Object.entries(clis)) {
      const pretty = AGENT_NAMES[name] || name;
      if (entry.installed) {
        console.log(`  ${chalk.green('ready')}  ${pretty.padEnd(10)} ${chalk.gray(entry.path || '')}`);
      } else {
        console.log(`  ${chalk.red('no   ')}  ${pretty.padEnd(10)} ${chalk.gray(entry.error || 'not installed')}`);
      }
    }
  }
  console.log();

  console.log(chalk.bold('Sync status (default versions)'));
  if (syncRows.length === 0) {
    console.log(chalk.gray('  (no default versions set; pin one with `agents use <agent>@<version>`)'));
  } else {
    for (const row of syncRows) {
      const label = `${AGENT_NAMES[row.agent] || row.agent}@${row.version}`;
      if (row.status === 'fresh') {
        console.log(`  ${chalk.green('fresh')}  ${label}`);
      } else if (row.status === 'stale') {
        console.log(`  ${chalk.yellow('stale')}  ${label}  ${chalk.gray('— will sync on next launch')}`);
      } else {
        console.log(`  ${chalk.gray('cold ')}  ${label}  ${chalk.gray('— never synced; first launch will populate')}`);
      }
    }
  }
  console.log();

  console.log(chalk.bold('Orphans (default versions)'));
  if (orphanRows.length === 0) {
    console.log(chalk.gray('  (none — version homes match central sources)'));
  } else {
    for (const row of orphanRows) {
      const parts: string[] = [];
      if (row.commands > 0) parts.push(`${row.commands} command${row.commands === 1 ? '' : 's'}`);
      if (row.skills > 0) parts.push(`${row.skills} skill${row.skills === 1 ? '' : 's'}`);
      if (row.hooks > 0) parts.push(`${row.hooks} hook${row.hooks === 1 ? '' : 's'}`);
      const label = `${AGENT_NAMES[row.agent] || row.agent}@${row.version}`;
      console.log(`  ${chalk.yellow('warn ')}  ${label}  ${chalk.gray(parts.join(', '))}`);
    }
    console.log(chalk.gray('  Run `agents prune` to remove.'));
  }
}

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('Diagnose CLI availability, sync status, and orphan resources')
    .option('--json', 'Output machine-readable JSON')
    .action((opts: DoctorOptions) => {
      const cwd = process.cwd();
      const clis = checkAllClis();
      const syncRows = checkSyncStatus(cwd);
      const orphanRows = countOrphans();

      if (opts.json) {
        console.log(JSON.stringify({ clis, sync: syncRows, orphans: orphanRows }, null, 2));
        return;
      }

      renderText(clis, syncRows, orphanRows);
    });
}
