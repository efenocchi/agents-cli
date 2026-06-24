/**
 * `agents sessions sync` — push this machine's transcripts to R2 and pull every
 * other machine's, merging copies of the same session via CRDT union. The local
 * sessions index is rebuilt from the synced-in mirror by the normal scanner.
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import { setHelpSections } from '../lib/help.js';
import { isSyncConfigured, SYNC_BUNDLE } from '../lib/session/sync/config.js';
import { syncSessions } from '../lib/session/sync/sync.js';

interface SyncCmdOptions {
  verbose?: boolean;
  json?: boolean;
}

export async function runSessionsSync(options: SyncCmdOptions): Promise<void> {
  if (!isSyncConfigured()) {
    console.error(
      chalk.red(`Sessions sync is not configured.`) +
      `\nAdd R2 credentials to the '${SYNC_BUNDLE}' bundle:\n` +
      `  agents secrets add ${SYNC_BUNDLE} R2_ACCOUNT_ID\n` +
      `  agents secrets add ${SYNC_BUNDLE} R2_BUCKET_NAME\n` +
      `  agents secrets add ${SYNC_BUNDLE} R2_ACCESS_KEY_ID\n` +
      `  agents secrets add ${SYNC_BUNDLE} R2_SECRET_ACCESS_KEY`,
    );
    process.exitCode = 1;
    return;
  }

  try {
    const result = await syncSessions({
      verbose: options.verbose,
      log: msg => console.error(chalk.dim(msg)),
    });

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      const parts = [
        `pushed ${result.pushed}`,
        `pulled ${result.pulled}`,
        result.merged > 0 ? `merged ${result.merged}` : null,
      ].filter(Boolean);
      console.log(
        chalk.green('synced') + ` ${result.machine}: ` + parts.join(', ') +
        chalk.dim(` (${result.pushSkipped + result.pullSkipped} unchanged)`),
      );
    }

    if (result.errors.length > 0) {
      for (const e of result.errors) console.error(chalk.yellow(`  ! ${e}`));
      process.exitCode = 1;
    }
  } catch (err) {
    console.error(chalk.red(`sync failed: ${(err as Error).message}`));
    process.exitCode = 1;
  }
}

export function registerSessionsSyncCommand(sessionsCmd: Command): void {
  const syncCmd = sessionsCmd
    .command('sync')
    .description('Sync session transcripts across machines via R2 (CRDT merge). Claude and Codex.')
    .option('-v, --verbose', 'Log each pushed and pulled session')
    .option('--json', 'Output the sync result as JSON');

  setHelpSections(syncCmd, {
    examples: `
      # One sync cycle (push local changes, pull + merge from other machines)
      agents sessions sync

      # See exactly what moved
      agents sessions sync --verbose
    `,
    notes: `
      - Credentials come from the '${SYNC_BUNDLE}' secrets bundle (R2 S3 API, read+write).
      - Each machine writes only its own prefix; conflicts are impossible by construction.
      - The daemon runs this automatically (~90s); this command forces an immediate cycle.
      - Sessions present locally always win; synced-in copies fill in other machines' sessions.
    `,
  });

  syncCmd.action(async (options: SyncCmdOptions) => {
    await runSessionsSync(options);
  });
}
