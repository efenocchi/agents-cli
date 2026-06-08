import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { snapshotSessions, awaitNewSession, claudeSessionDirs } from '../src/adapters/claude.js';

async function main() {
  const cwd = await fs.promises.realpath(
    await fs.promises.mkdtemp(path.join(os.tmpdir(), 'session-tracker-test-')),
  );
  console.log('[diag] cwd =', cwd);

  const dirs = await claudeSessionDirs(cwd);
  console.log('[diag] candidate session dirs (', dirs.length, '):');
  for (const d of dirs) console.log('   ', d);

  const before = await snapshotSessions(cwd);
  console.log('[diag] before snapshot:', before.size, 'files');

  const launchId = randomUUID();
  console.log('[diag] launching agents run claude');
  const proc = spawn('agents', ['run', 'claude', 'say ok', '--mode', 'plan'], {
    cwd,
    env: { ...process.env, AGENT_LAUNCH_ID: launchId },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  console.log('[diag] spawned pid =', proc.pid);

  let stdout = '';
  let stderr = '';
  proc.stdout?.on('data', (d) => (stdout += d.toString()));
  proc.stderr?.on('data', (d) => (stderr += d.toString()));

  const truthPromise = awaitNewSession(cwd, before, 15_000).then((r) => {
    console.log('[diag] awaitNewSession resolved:', r);
    return r;
  });

  await new Promise<void>((resolve) => {
    proc.once('exit', (code, sig) => {
      console.log('[diag] proc exit:', { code, sig });
      console.log('[diag] stdout:', stdout.slice(0, 400));
      console.log('[diag] stderr:', stderr.slice(0, 400));
      resolve();
    });
  });

  await truthPromise;

  console.log('[diag] post-spawn snapshot:');
  for (const d of dirs) {
    try {
      const f = await fs.promises.readdir(d);
      if (f.length > 0) console.log(`   ${d}: ${f.join(', ')}`);
    } catch {}
  }

  await fs.promises.rm(cwd, { recursive: true, force: true });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
