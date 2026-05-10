import { Command } from 'commander';
import {
  listProfiles,
  getProfile,
  createProfile,
  deleteProfile,
  type BrowserProfile,
} from '../lib/browser/profiles.js';
import { sendIPCRequest } from '../lib/browser/ipc.js';

export function registerBrowserCommand(program: Command): void {
  const browser = program
    .command('browser')
    .description('Browser automation via CDP');

  registerProfilesCommands(browser);
  registerTaskCommands(browser);
}

export function registerBrowserSubcommands(program: Command): void {
  registerProfilesCommands(program);
  registerTaskCommands(program);
}

function registerProfilesCommands(browser: Command): void {
  const profiles = browser
    .command('profiles')
    .description('Manage browser profiles');

  profiles
    .command('list')
    .alias('ls')
    .description('List all browser profiles')
    .action(async () => {
      const allProfiles = await listProfiles();
      if (allProfiles.length === 0) {
        console.log('No browser profiles configured.');
        console.log('Create one with: agents browser profiles create <name> --endpoint <url>');
        return;
      }

      console.log('NAME'.padEnd(20) + 'BROWSER'.padEnd(12) + 'ENDPOINTS');
      console.log('-'.repeat(72));
      for (const p of allProfiles) {
        const endpoints = p.endpoints.join(', ');
        console.log(p.name.padEnd(20) + (p.browser || '-').padEnd(12) + endpoints);
      }
    });

  const VALID_BROWSERS = ['chrome', 'comet', 'chromium', 'brave', 'edge'];

  profiles
    .command('create <name>')
    .description('Create a new browser profile')
    .requiredOption('-b, --browser <type>', `Browser type: ${VALID_BROWSERS.join(', ')}`)
    .requiredOption('-e, --endpoint <url>', 'CDP endpoint URL (repeatable)', collect, [])
    .option('-s, --secrets <bundle>', 'Secrets bundle to inject')
    .option('-d, --description <text>', 'Profile description')
    .option('--headless', 'Run in headless mode')
    .action(async (name: string, opts) => {
      if (!/^[a-z][a-z0-9-]*$/.test(name)) {
        console.error('Profile name must be lowercase alphanumeric with hyphens');
        process.exit(1);
      }

      if (!VALID_BROWSERS.includes(opts.browser)) {
        console.error(`Invalid browser type. Must be one of: ${VALID_BROWSERS.join(', ')}`);
        process.exit(1);
      }

      const profile: BrowserProfile = {
        name,
        description: opts.description,
        browser: opts.browser,
        endpoints: opts.endpoint,
        secrets: opts.secrets,
        chrome: opts.headless ? { headless: true } : undefined,
      };

      await createProfile(profile);
      console.log(`Created profile: ${name}`);
    });

  profiles
    .command('show <name>')
    .description('Show profile details')
    .option('--json', 'Output machine-readable JSON')
    .action(async (name: string, opts) => {
      const profile = await getProfile(name);
      if (!profile) {
        if (opts.json) {
          console.log(JSON.stringify({ ok: false, error: `Profile "${name}" not found` }));
        } else {
          console.error(`Profile "${name}" not found`);
        }
        process.exit(1);
      }

      if (opts.json) {
        console.log(JSON.stringify(profile, null, 2));
        return;
      }

      console.log(`Name: ${profile.name}`);
      console.log(`Browser: ${profile.browser}`);
      if (profile.description) console.log(`Description: ${profile.description}`);
      console.log(`Endpoints:`);
      for (const e of profile.endpoints) {
        console.log(`  - ${e}`);
      }
      if (profile.secrets) console.log(`Secrets: ${profile.secrets}`);
      if (profile.chrome?.headless) console.log(`Headless: true`);
    });

  profiles
    .command('delete <name>')
    .description('Delete a browser profile')
    .action(async (name: string) => {
      await deleteProfile(name);
      console.log(`Deleted profile: ${name}`);
    });
}

function registerTaskCommands(browser: Command): void {
  browser
    .command('start')
    .description('Start a browser task with a profile')
    .requiredOption('-p, --profile <name>', 'Browser profile to use')
    .option('-t, --task <name>', 'Task name (auto-generated if omitted)')
    .option('-u, --url <url>', 'Open URL in first tab')
    .action(async (opts) => {
      const response = await sendIPCRequest({
        action: 'start',
        profile: opts.profile,
        taskName: opts.task,
        url: opts.url,
      });

      if (!response.ok) {
        console.error(response.error);
        process.exit(1);
      }

      if (opts.url && response.tabId) {
        console.log(`Started task "${response.task}" with tab ${response.tabId}`);
      } else {
        console.log(`Started task "${response.task}"`);
      }
    });

  browser
    .command('done <task>')
    .description('Complete a task and close its tabs')
    .action(async (task: string) => {
      const response = await sendIPCRequest({
        action: 'done',
        task,
      });

      if (!response.ok) {
        console.error(response.error);
        process.exit(1);
      }

      console.log(`Completed task: ${task}`);
    });

  browser
    .command('stop <task>')
    .description('Stop a browser task and close its tabs')
    .action(async (task: string) => {
      const response = await sendIPCRequest({
        action: 'stop',
        task,
      });

      if (!response.ok) {
        console.error(response.error);
        process.exit(1);
      }

      console.log(`Stopped task: ${task}`);
    });

  browser
    .command('navigate <task> <url>')
    .description('Navigate current tab to URL (creates tab if none exist)')
    .option('-p, --profile <name>', 'Browser profile (optional if task is unique)')
    .action(async (task: string, url: string, opts) => {
      const response = await sendIPCRequest({
        action: 'navigate',
        task,
        url,
        profile: opts.profile,
      });

      if (!response.ok) {
        console.error(response.error);
        process.exit(1);
      }

      console.log(`Navigated ${response.tabId} to ${url}`);
    });

  // Tab subcommand group
  const tab = browser.command('tab').description('Manage tabs');

  tab
    .command('add <task> <url>')
    .description('Open URL in new tab (becomes current)')
    .option('-p, --profile <name>', 'Browser profile')
    .action(async (task: string, url: string, opts) => {
      const response = await sendIPCRequest({
        action: 'tab-add',
        task,
        url,
        profile: opts.profile,
      });

      if (!response.ok) {
        console.error(response.error);
        process.exit(1);
      }

      console.log(`Opened tab ${response.tabId}: ${url}`);
    });

  tab
    .command('focus <task> <tabId>')
    .description('Switch to tab (by ID, prefix, or URL substring)')
    .action(async (task: string, tabId: string) => {
      const response = await sendIPCRequest({
        action: 'tab-focus',
        task,
        tabId,
      });

      if (!response.ok) {
        console.error(response.error);
        process.exit(1);
      }

      console.log(`Focused tab ${response.tabId}`);
    });

  tab
    .command('close <task> [tabId]')
    .description('Close tab(s) — omit tabId to close all')
    .action(async (task: string, tabId: string | undefined) => {
      const response = await sendIPCRequest({
        action: 'tab-close',
        task,
        tabId,
      });

      if (!response.ok) {
        console.error(response.error);
        process.exit(1);
      }

      console.log(tabId ? `Closed tab ${tabId}` : `Closed all tabs for ${task}`);
    });

  tab
    .command('list <task>')
    .description('List tabs for a task')
    .option('--json', 'Output machine-readable JSON')
    .action(async (task: string, opts) => {
      const response = await sendIPCRequest({
        action: 'tab-list',
        task,
      });

      if (!response.ok) {
        if (opts.json) {
          console.log(JSON.stringify({ ok: false, error: response.error }));
        } else {
          console.error(response.error);
        }
        process.exit(1);
      }

      if (opts.json) {
        console.log(JSON.stringify(response.tabs ?? [], null, 2));
        return;
      }

      if (!response.tabs || response.tabs.length === 0) {
        console.log('No tabs open');
        return;
      }

      console.log('TAB'.padEnd(12) + 'URL');
      console.log('-'.repeat(70));
      for (const t of response.tabs) {
        const current = (t as { id: string; url: string; current?: boolean }).current ? ' *' : '';
        console.log(t.id.padEnd(12) + t.url.slice(0, 55) + current);
      }
    });


  browser
    .command('screenshot <task> [tabId]')
    .description('Take a screenshot')
    .option('-o, --output <path>', 'Output path')
    .action(async (task: string, tabId: string | undefined, opts) => {
      const response = await sendIPCRequest({
        action: 'screenshot',
        task,
        tabId,
        path: opts.output,
      });

      if (!response.ok) {
        console.error(response.error);
        process.exit(1);
      }

      console.log(response.path);
    });

  browser
    .command('evaluate <task> <expression>')
    .description('Evaluate JavaScript in current tab')
    .option('-t, --tab <tabId>', 'Tab ID (defaults to current)')
    .action(async (task: string, expression: string, opts) => {
      const response = await sendIPCRequest({
        action: 'evaluate',
        task,
        tabId: opts.tab,
        expr: expression,
      });

      if (!response.ok) {
        console.error(response.error);
        process.exit(1);
      }

      console.log(JSON.stringify(response.result, null, 2));
    });

  browser
    .command('status')
    .description('Show running browser tasks')
    .option('-p, --profile <name>', 'Filter by profile')
    .option('--json', 'Output machine-readable JSON')
    .action(async (opts) => {
      const response = await sendIPCRequest({
        action: 'status',
        profile: opts.profile,
      });

      if (!response.ok) {
        if (opts.json) {
          console.log(JSON.stringify({ ok: false, error: response.error }));
        } else {
          console.error(response.error);
        }
        process.exit(1);
      }

      if (opts.json) {
        console.log(JSON.stringify(response.profiles ?? [], null, 2));
        return;
      }

      if (!response.profiles || response.profiles.length === 0) {
        console.log('No browser profiles running');
        return;
      }

      for (const profile of response.profiles) {
        const portLabel =
          profile.configuredPort && profile.configuredPort !== profile.port
            ? `port ${profile.port} (configured ${profile.configuredPort})`
            : `port ${profile.port}`;
        console.log(`\n${profile.name} (${portLabel}, pid ${profile.pid})`);
        if (profile.tasks.length === 0) {
          console.log('  No active tasks');
        } else {
          console.log('  TASK'.padEnd(25) + 'TABS'.padEnd(8) + 'CREATED');
          for (const task of profile.tasks) {
            const age = formatAge(task.createdAt);
            const name = (task as { name?: string }).name || task.id;
            console.log(
              '  ' +
                name.padEnd(23) +
                String(task.tabCount).padEnd(8) +
                age
            );
          }
        }
      }
    });

  browser
    .command('tasks')
    .description('List all browser tasks')
    .option('-p, --profile <name>', 'Filter by profile')
    .option('--json', 'Output machine-readable JSON')
    .action(async (opts) => {
      const response = await sendIPCRequest({
        action: 'status',
        profile: opts.profile,
      });

      if (!response.ok) {
        if (opts.json) {
          console.log(JSON.stringify({ ok: false, error: response.error }));
        } else {
          console.error(response.error);
        }
        process.exit(1);
      }

      const allTasks: Array<{ profile: string; id: string; tabs: number; created: number }> = [];
      for (const profile of response.profiles || []) {
        for (const task of profile.tasks) {
          allTasks.push({
            profile: profile.name,
            id: task.id,
            tabs: task.tabCount,
            created: task.createdAt,
          });
        }
      }

      if (opts.json) {
        console.log(JSON.stringify(allTasks, null, 2));
        return;
      }

      if (allTasks.length === 0) {
        console.log('No active tasks');
        return;
      }

      console.log('PROFILE'.padEnd(18) + 'TASK'.padEnd(15) + 'TABS'.padEnd(8) + 'CREATED');
      console.log('-'.repeat(55));
      for (const t of allTasks) {
        console.log(
          t.profile.padEnd(18) +
            t.id.padEnd(15) +
            String(t.tabs).padEnd(8) +
            formatAge(t.created)
        );
      }
    });

  browser
    .command('refs <task>')
    .description('Get DOM refs for interactive elements')
    .option('-t, --tab <tabId>', 'Tab ID (defaults to current)')
    .option('--all', 'Include non-interactive elements')
    .option('-l, --limit <n>', 'Max elements (default 500)', '500')
    .action(async (task: string, opts) => {
      const response = await sendIPCRequest({
        action: 'refs',
        task,
        tabId: opts.tab,
        interactive: !opts.all,
        limit: parseInt(opts.limit, 10),
      });

      if (!response.ok) {
        console.error(response.error);
        process.exit(1);
      }

      console.log(response.refs);
    });

  browser
    .command('click <task> <ref>')
    .description('Click an element by ref')
    .option('-t, --tab <tabId>', 'Tab ID (defaults to current)')
    .action(async (task: string, ref: string, opts) => {
      const response = await sendIPCRequest({
        action: 'click',
        task,
        tabId: opts.tab,
        ref: parseInt(ref, 10),
      });

      if (!response.ok) {
        console.error(response.error);
        process.exit(1);
      }

      console.log('Clicked');
    });

  browser
    .command('type <task> <ref> <text>')
    .description('Type text into an element by ref')
    .option('-t, --tab <tabId>', 'Tab ID (defaults to current)')
    .action(async (task: string, ref: string, text: string, opts) => {
      const response = await sendIPCRequest({
        action: 'type',
        task,
        tabId: opts.tab,
        ref: parseInt(ref, 10),
        text,
      });

      if (!response.ok) {
        console.error(response.error);
        process.exit(1);
      }

      console.log('Typed');
    });

  browser
    .command('press <task> <key>')
    .description('Press a key (Enter, Tab, Escape, etc)')
    .option('-t, --tab <tabId>', 'Tab ID (defaults to current)')
    .action(async (task: string, key: string, opts) => {
      const response = await sendIPCRequest({
        action: 'press',
        task,
        tabId: opts.tab,
        key,
      });

      if (!response.ok) {
        console.error(response.error);
        process.exit(1);
      }

      console.log('Pressed');
    });

  browser
    .command('hover <task> <ref>')
    .description('Hover over an element by ref')
    .option('-t, --tab <tabId>', 'Tab ID (defaults to current)')
    .action(async (task: string, ref: string, opts) => {
      const response = await sendIPCRequest({
        action: 'hover',
        task,
        tabId: opts.tab,
        ref: parseInt(ref, 10),
      });

      if (!response.ok) {
        console.error(response.error);
        process.exit(1);
      }

      console.log('Hovered');
    });
}

function collect(val: string, memo: string[]): string[] {
  memo.push(val);
  return memo;
}

function formatAge(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}
