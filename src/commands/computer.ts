import { Command } from 'commander';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { registerCommandGroups } from '../lib/help.js';

// Help groups — mirror `agents browser` so the mental model carries over.
// For this first chunk we ship two commands; the structure leaves room
// for the future "drive the page" / "capture evidence" groups without
// re-shuffling.
const COMPUTER_HELP_GROUPS = [
  { title: 'Session lifecycle', names: ['status'] },
  { title: 'Capture evidence', names: ['screenshot'] },
] as const;

export function registerComputerCommand(program: Command): void {
  const computer = program
    .command('computer')
    .description('Drive macOS apps via Accessibility — list, screenshot, click, type');

  registerComputerSubcommands(computer);
  registerCommandGroups(computer, COMPUTER_HELP_GROUPS);
}

export function registerComputerSubcommands(program: Command): void {
  registerStatusCommand(program);
  registerScreenshotCommand(program);
  registerCommandGroups(program, COMPUTER_HELP_GROUPS);
}

// Resolve the helper binary path.
//
// 1. Locally-built helper next to the package source — used during
//    development and for any user who ran `./packages/computer-helper/scripts/build.sh`.
// 2. Future: a `dist/` directory bundled with the published npm package
//    (downloaded from CDN on postinstall — wired in a later chunk).
//
// Returns the absolute path to the executable inside the .app bundle so
// the helper gets its TCC identity from the bundle id, not the parent shell.
function resolveHelperPath(): string | null {
  // src/commands/ at runtime resolves to dist/commands/ — walk up two
  // levels to find the package root.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // 1. Local build (when running from the agents-cli checkout).
    path.resolve(here, '..', '..', 'packages', 'computer-helper', 'dist', 'ComputerHelper.app', 'Contents', 'MacOS', 'ComputerHelper'),
    // 2. Bundled with the npm package (later: CDN download lands here).
    path.resolve(here, '..', 'computer-helper', 'ComputerHelper.app', 'Contents', 'MacOS', 'ComputerHelper'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function reportMissingHelper(): never {
  console.error('helper not built. Run: ./packages/computer-helper/scripts/build.sh debug');
  process.exit(1);
}

// Line-delimited JSON-RPC client. The helper terminates on stdin EOF, so
// each invocation = one short-lived helper process for one or two calls.
// This is the same shape as `rush/app/native/computer-mac/scripts/probe.py`,
// just in TypeScript.
interface RPCResponse {
  id: number | null;
  result?: Record<string, unknown>;
  error?: { code: string; message: string };
}

class HelperClient {
  private proc: ChildProcessWithoutNullStreams;
  private buf = '';
  private waiters: Map<number, (r: RPCResponse) => void> = new Map();
  private nextId = 1;
  private exited = false;

  constructor(helperPath: string) {
    this.proc = spawn(helperPath, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk: string) => {
      this.buf += chunk;
      let nl: number;
      while ((nl = this.buf.indexOf('\n')) !== -1) {
        const line = this.buf.slice(0, nl);
        this.buf = this.buf.slice(nl + 1);
        if (!line) continue;
        try {
          const obj = JSON.parse(line) as RPCResponse;
          const id = typeof obj.id === 'number' ? obj.id : null;
          if (id !== null && this.waiters.has(id)) {
            const resolve = this.waiters.get(id)!;
            this.waiters.delete(id);
            resolve(obj);
          }
        } catch {
          // Drop garbage; the helper writes diagnostics to stderr, not stdout.
        }
      }
    });
    this.proc.on('exit', () => {
      this.exited = true;
      // Resolve any pending waiters with an error so callers don't hang
      // when the helper crashes.
      for (const [id, resolve] of this.waiters) {
        resolve({ id, error: { code: 'helper_exited', message: 'helper exited before reply' } });
      }
      this.waiters.clear();
    });
  }

  async call(method: string, params?: Record<string, unknown>): Promise<RPCResponse> {
    if (this.exited) {
      return { id: null, error: { code: 'helper_exited', message: 'helper not running' } };
    }
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params: params ?? {} }) + '\n';
    return new Promise((resolve) => {
      this.waiters.set(id, resolve);
      this.proc.stdin.write(payload);
    });
  }

  async close(): Promise<void> {
    if (this.exited) return;
    this.proc.stdin.end();
    await new Promise<void>((resolve) => {
      if (this.exited) return resolve();
      this.proc.on('exit', () => resolve());
    });
  }
}

function registerStatusCommand(program: Command): void {
  program
    .command('status')
    .description('Report Accessibility trust + helper identity')
    .action(async () => {
      const helperPath = resolveHelperPath();
      if (!helperPath) reportMissingHelper();

      const client = new HelperClient(helperPath);
      try {
        const r = await client.call('trust_status');
        if (r.error) {
          console.error(`error: ${r.error.code}: ${r.error.message}`);
          process.exit(1);
        }
        const trusted = Boolean(r.result?.trusted);
        const helperPid = r.result?.pid;
        console.log(`trust: ${trusted ? 'granted' : 'denied'}`);
        console.log(`helper: ${helperPath}`);
        if (typeof helperPid === 'number') console.log(`pid: ${helperPid}`);
        if (!trusted) {
          console.error('');
          console.error('Accessibility is not granted to ComputerHelper.app.');
          console.error('Open System Settings > Privacy & Security > Accessibility and add:');
          console.error(`  ${path.resolve(helperPath, '..', '..', '..')}`);
        }
      } finally {
        await client.close();
      }
    });
}

function registerScreenshotCommand(program: Command): void {
  program
    .command('screenshot')
    .description('Capture a JPEG of the frontmost window of a bundle id (default: frontmost app)')
    .option('--bundle <id>', 'Bundle id to capture (default: bundle id of frontmost app)')
    .option('--out <path>', 'Output JPEG path', './computer-screenshot.jpg')
    .option('--quality <n>', 'JPEG quality 1-100', (v) => parseInt(v, 10), 85)
    .action(async (opts: { bundle?: string; out: string; quality: number }) => {
      const helperPath = resolveHelperPath();
      if (!helperPath) reportMissingHelper();

      const quality = Math.max(1, Math.min(100, opts.quality || 85));

      const client = new HelperClient(helperPath);
      try {
        // Step 1: list_apps to get the candidate set.
        const apps = await client.call('list_apps');
        if (apps.error) {
          console.error(`error: ${apps.error.code}: ${apps.error.message}`);
          process.exit(1);
        }
        const list = (apps.result?.apps as Array<{
          pid: number;
          name: string;
          bundle_id: string;
          active: boolean;
          excluded: boolean;
        }>) || [];

        // Resolve the target bundle id.
        let target: typeof list[number] | undefined;
        if (opts.bundle) {
          target = list.find((a) => a.bundle_id === opts.bundle);
          if (!target) {
            console.error(`bundle not running: ${opts.bundle}`);
            process.exit(1);
          }
        } else {
          target = list.find((a) => a.active);
          if (!target) {
            console.error('no active app found');
            process.exit(1);
          }
        }
        if (target.excluded) {
          console.error(`bundle is excluded by deny-list: ${target.bundle_id}`);
          process.exit(1);
        }

        // Step 2: screenshot.
        const shot = await client.call('screenshot', { pid: target.pid, quality });
        if (shot.error) {
          console.error(`error: ${shot.error.code}: ${shot.error.message}`);
          process.exit(1);
        }
        const b64 = shot.result?.image_data as string | undefined;
        const width = shot.result?.width as number | undefined;
        const height = shot.result?.height as number | undefined;
        if (!b64) {
          console.error('helper returned no image_data');
          process.exit(1);
        }
        const buf = Buffer.from(b64, 'base64');
        const outPath = path.resolve(opts.out);
        fs.writeFileSync(outPath, buf);
        console.log(`saved: ${outPath} (${width ?? '?'}x${height ?? '?'}, ${buf.byteLength} bytes)`);
      } finally {
        await client.close();
      }
    });
}
