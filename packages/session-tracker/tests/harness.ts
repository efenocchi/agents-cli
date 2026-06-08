import { spawn, ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { awaitNewSession, snapshotSessions } from '../src/adapters/claude.js';
import { clearSession } from '../src/writer.js';
import type { AgentId, DetectionResult } from '../src/types.js';

export interface SpawnOpts {
  agent: AgentId;
  cwd?: string;
  truthTimeoutMs?: number;
  trackerTimeoutMs?: number;
  env?: Record<string, string>;
  args?: string[];
  reuseCwd?: boolean;
  /**
   * Headless prompt; defaults to "say ok". Avoids needing a PTY.
   * Pass `args: ['--interactive']` (with reuseCwd + a PTY harness) to test
   * interactive behavior end-to-end.
   */
  prompt?: string;
  mode?: 'plan' | 'edit' | 'auto' | 'skip';
}

export interface SpawnRun {
  agent: AgentId;
  cwd: string;
  launchId: string;
  proc: ChildProcess;
  truth: { sessionId: string; latencyMs: number; file: string } | null;
  detected: DetectionResult;
  matched: boolean;
}

async function makeFreshCwd(): Promise<string> {
  const dir = path.join(os.tmpdir(), `session-tracker-test-${randomUUID()}`);
  await fs.promises.mkdir(dir, { recursive: true });
  // macOS: /tmp -> /private/tmp. Resolve so Claude's workspace folder name
  // matches the realpath we'll be snapshotting against.
  return fs.promises.realpath(dir);
}

export async function spawnAndDetect(opts: SpawnOpts): Promise<SpawnRun> {
  const cwd = opts.cwd ?? (opts.reuseCwd ? process.cwd() : await makeFreshCwd());
  const launchId = randomUUID();

  const beforeFiles =
    opts.agent === 'claude' ? await snapshotSessions(cwd) : new Set<string>();

  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    AGENT_LAUNCH_ID: launchId,
    ...opts.env,
  };

  const headlessPrompt = opts.prompt ?? 'say ok';
  const mode = opts.mode ?? 'plan';
  const argv =
    opts.args && opts.args.length > 0
      ? ['run', opts.agent, ...opts.args]
      : ['run', opts.agent, headlessPrompt, '--mode', mode];

  const proc = spawn('agents', argv, {
    cwd,
    env: childEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: false,
  });
  if (!proc.pid) {
    throw new Error(`spawn agents ${opts.agent} failed: no pid`);
  }

  const trackerTimeoutMs = opts.trackerTimeoutMs ?? 8000;
  const truthTimeoutMs = opts.truthTimeoutMs ?? 8000;

  const [truth, detected] = await Promise.all([
    opts.agent === 'claude'
      ? awaitNewSession(cwd, beforeFiles, truthTimeoutMs)
      : Promise.resolve(null),
    trackByShellTree(proc.pid, trackerTimeoutMs),
  ]);

  const matched =
    truth !== null && detected.sessionId !== null && detected.sessionId === truth.sessionId;

  return { agent: opts.agent, cwd, launchId, proc, truth, detected, matched };
}

async function trackByShellTree(
  shellPid: number,
  timeoutMs: number,
): Promise<DetectionResult> {
  const { findStateInTree } = await import('../src/reader.js');
  const start = Date.now();
  const pollMs = 50;
  while (Date.now() - start < timeoutMs) {
    const state = await findStateInTree(shellPid);
    if (state) {
      return {
        sessionId: state.session_id,
        method: state.method,
        latencyMs: Date.now() - start,
        confidence: 'high',
      };
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return { sessionId: null, method: null, latencyMs: Date.now() - start, confidence: 'low' };
}

export async function killAndCleanup(run: SpawnRun): Promise<void> {
  const { proc } = run;
  try {
    if (proc.pid && !proc.killed) {
      proc.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          try { proc.kill('SIGKILL'); } catch {}
          resolve();
        }, 2000);
        proc.once('exit', () => { clearTimeout(t); resolve(); });
      });
    }
  } catch {}

  try {
    const { descendantPids } = await import('../src/reader.js');
    if (run.proc.pid) {
      const pids = [run.proc.pid, ...(await descendantPids(run.proc.pid))];
      for (const p of pids) {
        await clearSession(p).catch(() => undefined);
      }
    }
  } catch {}

  if (run.cwd.includes('session-tracker-test-')) {
    try { await fs.promises.rm(run.cwd, { recursive: true, force: true }); } catch {}
  }
}

export function suppressIo(proc: ChildProcess): void {
  proc.stdout?.resume();
  proc.stderr?.resume();
  proc.stdout?.on('data', () => {});
  proc.stderr?.on('data', () => {});
}
