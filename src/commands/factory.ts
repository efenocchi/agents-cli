/**
 * Software Factory CLI -- thin client over `prix/factory/service`.
 *
 * One verb today:
 *
 *   agents factory submit <linear-ref>   POST /factory/submit
 *
 * Everything else (planner pod, worker dispatch, PR-merged/CI-failed
 * webhooks, retry caps, heartbeat reaper) lives server-side in
 * `agents/prix/factory/service/src/factory.ts`, driven by the
 * `factory-tick` k8s CronJob. The laptop is optional after submit.
 *
 * Future verbs (list / status / tail / cancel / message) are intentionally
 * deferred until the matching server endpoints land; they'll be thin
 * clients too. No supervisor, ledger, oracle, or `~/.agents/factory/`
 * registry on the laptop -- ever.
 */
import type { Command } from 'commander';
import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';
import { betaEnableHint, isBetaEnabled } from '../lib/beta.js';

const FACTORY_URL = process.env.FACTORY_FLOOR_URL ?? 'https://factory.example.com';

function die(msg: string, code = 1): never {
  console.error(chalk.red(msg));
  process.exit(code);
}

function readRushToken(): string {
  const userYaml = path.join(homedir(), '.rush', 'user.yaml');
  if (!fs.existsSync(userYaml)) {
    die('Not logged in to Rush. Run `rush login` first.');
  }
  const raw = fs.readFileSync(userYaml, 'utf-8');
  const match = raw.match(/access_token:\s*([^\s#]+)/);
  if (!match) {
    die('No session token in ~/.rush/user.yaml. Run `rush login` first.');
  }
  return match[1].replace(/^['"]|['"]$/g, '');
}

interface SubmitResponse {
  ticket_id: string;
  linear_identifier: string;
  label: string;
  cloud_execution_id: string;
}

async function postFactorySubmit(ref: string): Promise<SubmitResponse> {
  const token = readRushToken();
  const res = await fetch(`${FACTORY_URL}/factory/submit`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ref }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    die(`Factory submit failed (${res.status}): ${body.slice(0, 400)}`);
  }
  return res.json() as Promise<SubmitResponse>;
}

export function registerFactoryCommands(program: Command): void {
  const enabled = isBetaEnabled('factory');
  const factory = program
    .command('factory', { hidden: !enabled })
    .description('Software Factory -- submit Linear tickets to the cloud orchestrator.')
    .addHelpText('after', `
Examples:
  agents factory submit EXAMPLE-2451
  agents factory submit https://linear.app/example/issue/EXAMPLE-2451
`);

  factory.hook('preAction', () => {
    if (enabled) return;
    console.error(chalk.red('agents factory is in beta.'));
    console.error(chalk.gray(betaEnableHint('factory')));
    process.exit(1);
  });

  factory
    .command('submit <linear-ref>')
    .description('Submit a Linear issue (EXAMPLE-123 or URL) to the Software Factory.')
    .option('--json', 'Output machine-readable JSON')
    .action(async (ref: string, opts: { json?: boolean }) => {
      const result = await postFactorySubmit(ref);
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(chalk.green(`Submitted ${result.linear_identifier} (${result.label})`));
      console.log(`  ticket       ${result.ticket_id}`);
      console.log(`  execution    ${result.cloud_execution_id}`);
      console.log(`  tail output  agents cloud tail ${result.cloud_execution_id}`);
    });
}
