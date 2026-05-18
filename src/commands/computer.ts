import { Command } from 'commander';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { registerCommandGroups } from '../lib/help.js';
import {
  openComputerClient,
  resolveHelperApp,
  resolveHelperExec,
  resolveSocketPath,
  resolveLogPath,
  describeTransport,
} from '../lib/computer-rpc.js';

// Help groups — mirror `agents browser` so the mental model carries over.
const COMPUTER_HELP_GROUPS = [
  { title: 'Session lifecycle', names: ['status', 'install-helper'] },
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
  registerInstallHelperCommand(program);
  registerCommandGroups(program, COMPUTER_HELP_GROUPS);
}

function reportMissingHelper(): never {
  console.error('helper not built. Run: ./packages/computer-helper/scripts/build.sh debug');
  process.exit(1);
}

function registerStatusCommand(program: Command): void {
  program
    .command('status')
    .description('Report Accessibility trust + helper identity')
    .action(async () => {
      const transport = describeTransport();
      if (transport.kind === 'none') reportMissingHelper();

      const client = openComputerClient();
      try {
        const r = await client.call('trust_status');
        if (r.error) {
          console.error(`error: ${r.error.code}: ${r.error.message}`);
          process.exit(1);
        }
        const trusted = Boolean(r.result?.trusted);
        const helperPid = r.result?.pid;
        const helperPath = r.result?.path as string | undefined;
        console.log(`trust: ${trusted ? 'granted' : 'denied'}`);
        console.log(`transport: ${transport.kind} (${transport.path})`);
        if (helperPath) console.log(`helper: ${helperPath}`);
        if (typeof helperPid === 'number') console.log(`pid: ${helperPid}`);
        if (!trusted) {
          const appPath = helperPath ? path.resolve(helperPath, '..', '..', '..') : HELPER_APP_DEST;
          console.error('');
          console.error('Accessibility is not granted to ComputerHelper.app.');
          console.error('Open System Settings > Privacy & Security > Accessibility and add:');
          console.error(`  ${appPath}`);
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
      const transport = describeTransport();
      if (transport.kind === 'none') reportMissingHelper();

      const quality = Math.max(1, Math.min(100, opts.quality || 85));

      const client = openComputerClient();
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

// install-helper:
//   1. resolve dist .app
//   2. copy to /Applications/Computer Helper.app
//   3. codesign --verify the destination
//   4. write LaunchAgent plist with absolute HOME paths
//   5. launchctl bootout (ignore failure) -> bootstrap -> kickstart -k
//   6. wait for socket to appear
//   7. probe trust_status, print grant instructions if needed
//
// macOS TCC is keyed by signed-bundle identity + bundle id. Putting the
// .app at a stable absolute path under /Applications/ means the AX grant
// survives across npm updates. The CLI itself is unsigned but doesn't
// need AX — it sends JSON-RPC to the daemon, which has AX.
const HELPER_BUNDLE_ID = 'com.phnx-labs.computer-helper';
const HELPER_APP_NAME = 'Computer Helper.app';
const HELPER_APP_DEST = `/Applications/${HELPER_APP_NAME}`;
const HELPER_LABEL = HELPER_BUNDLE_ID;

function registerInstallHelperCommand(program: Command): void {
  program
    .command('install-helper')
    .description('Install ComputerHelper.app to /Applications/, register launchd daemon, open Unix socket')
    .action(async () => {
      const srcApp = resolveHelperApp();
      if (!srcApp || !fs.existsSync(srcApp)) {
        console.error('helper not built. Run: ./packages/computer-helper/scripts/build.sh debug');
        process.exit(1);
      }

      const home = os.homedir();
      const socketPath = resolveSocketPath();
      const logPath = resolveLogPath();
      const plistPath = path.join(home, 'Library', 'LaunchAgents', `${HELPER_LABEL}.plist`);

      console.log(`source:  ${srcApp}`);
      console.log(`dest:    ${HELPER_APP_DEST}`);

      // 1. Copy to /Applications/. Use ditto to preserve xattrs (Gatekeeper
      // provenance + codesign metadata). Wipe any prior install first.
      if (fs.existsSync(HELPER_APP_DEST)) {
        try {
          fs.rmSync(HELPER_APP_DEST, { recursive: true, force: true });
          console.log(`removed prior install`);
        } catch (err) {
          console.error(`failed to remove prior install at ${HELPER_APP_DEST}: ${(err as Error).message}`);
          console.error('try: sudo rm -rf "' + HELPER_APP_DEST + '"');
          process.exit(1);
        }
      }
      try {
        execFileSync('/usr/bin/ditto', [srcApp, HELPER_APP_DEST], { stdio: 'inherit' });
      } catch (err) {
        console.error(`ditto copy failed: ${(err as Error).message}`);
        process.exit(1);
      }
      console.log(`copied to ${HELPER_APP_DEST}`);

      // 2. Verify codesign on the destination. Fail loud if the copy
      // somehow stripped the signature — TCC needs a valid signature.
      try {
        execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', HELPER_APP_DEST], { stdio: 'inherit' });
        console.log('codesign verify: OK');
      } catch {
        console.error('codesign verify FAILED. The destination .app is unsigned or its signature was stripped.');
        console.error('rebuild the helper with a Developer ID cert: ./packages/computer-helper/scripts/build.sh release');
        process.exit(1);
      }

      // 3. Ensure socket + log parent dirs exist. ~/.agents/.cache/helpers/
      // is the canonical home for helper-subprocess scratch (matches the
      // browser daemon's ~/.agents/.cache/helpers/browser.sock). logs/ is
      // the runtime log bucket.
      fs.mkdirSync(path.dirname(socketPath), { recursive: true });
      fs.mkdirSync(path.dirname(logPath), { recursive: true });

      // 4. Write plist with HOME paths resolved (launchd does not expand ~).
      const execInsideApp = path.join(HELPER_APP_DEST, 'Contents', 'MacOS', 'ComputerHelper');
      const plistContent = renderLaunchAgentPlist({
        label: HELPER_LABEL,
        exec: execInsideApp,
        socketPath,
        logPath,
      });
      fs.mkdirSync(path.dirname(plistPath), { recursive: true });
      fs.writeFileSync(plistPath, plistContent);
      console.log(`wrote plist: ${plistPath}`);

      // 5. Load via launchctl. UID-keyed gui/ domain so it runs at login.
      const uid = process.getuid?.();
      if (typeof uid !== 'number') {
        console.error('cannot resolve uid (process.getuid unavailable)');
        process.exit(1);
      }
      const domain = `gui/${uid}`;

      // Bootout first to clear any prior registration. Ignore failure
      // (most common when nothing is loaded yet).
      try {
        execFileSync('/bin/launchctl', ['bootout', domain, plistPath], { stdio: 'pipe' });
        console.log('launchctl bootout: ok (cleared prior registration)');
      } catch {
        // expected when not previously loaded
      }

      try {
        execFileSync('/bin/launchctl', ['bootstrap', domain, plistPath], { stdio: 'inherit' });
        console.log('launchctl bootstrap: ok');
      } catch (err) {
        console.error(`launchctl bootstrap failed: ${(err as Error).message}`);
        console.error('the plist may be malformed or the label already in use.');
        process.exit(1);
      }

      // Kickstart -k: force restart so we pick up the new binary even if a
      // previous instance is still running.
      try {
        execFileSync('/bin/launchctl', ['kickstart', '-k', `${domain}/${HELPER_LABEL}`], { stdio: 'inherit' });
        console.log('launchctl kickstart: ok');
      } catch (err) {
        console.error(`launchctl kickstart failed: ${(err as Error).message}`);
        process.exit(1);
      }

      // 6. Wait up to 5s for the socket to appear.
      const deadline = Date.now() + 5000;
      let socketReady = false;
      while (Date.now() < deadline) {
        if (fs.existsSync(socketPath)) {
          socketReady = true;
          break;
        }
        await sleep(100);
      }
      if (!socketReady) {
        console.error(`socket did not appear at ${socketPath} within 5s`);
        console.error(`check ${logPath} for helper startup errors`);
        process.exit(1);
      }
      console.log(`socket up: ${socketPath}`);

      // 7. Probe trust_status through the socket.
      let trustStr = 'unknown';
      try {
        const client = openComputerClient();
        try {
          const r = await client.call('trust_status');
          if (r.error) {
            trustStr = `error (${r.error.code})`;
          } else {
            trustStr = r.result?.trusted ? 'granted' : 'denied';
          }
        } finally {
          await client.close();
        }
      } catch (err) {
        trustStr = `error (${(err as Error).message})`;
      }

      console.log('');
      console.log('Helper installed.');
      console.log('');
      console.log(`  app:    ${HELPER_APP_DEST}`);
      console.log(`  socket: ${socketPath}`);
      console.log(`  log:    ${logPath}`);
      console.log(`  trust:  ${trustStr}`);
      console.log('');
      if (trustStr !== 'granted') {
        console.log('One-time setup (only needed if trust is \'denied\'):');
        console.log('  1. Open: System Settings > Privacy & Security > Accessibility');
        console.log('  2. Click the + button, navigate to /Applications/');
        console.log(`  3. Add: ${HELPER_APP_NAME}`);
        console.log('  4. Toggle it ON');
        console.log('');
        console.log('After granting, run: agents computer status');
      } else {
        console.log('Trust already granted. Try: agents computer status');
      }
    });
}

function renderLaunchAgentPlist(opts: { label: string; exec: string; socketPath: string; logPath: string }): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${escapeXml(opts.label)}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${escapeXml(opts.exec)}</string>
        <string>--socket</string>
        <string>${escapeXml(opts.socketPath)}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ProcessType</key>
    <string>Background</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(opts.logPath)}</string>
    <key>StandardOutPath</key>
    <string>${escapeXml(opts.logPath)}</string>
</dict>
</plist>
`;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Backwards-compat: a few external callers may still import these.
// Re-export from the shared lib so existing imports keep working.
export { resolveHelperExec as resolveHelperPath };
export { resolveSocketPath };
