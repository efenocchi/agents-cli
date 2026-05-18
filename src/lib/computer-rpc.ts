// JSON-RPC client for the computer-helper.
//
// Two transports, picked at runtime:
//   - socket: ~/.agents/.cache/helpers/computer.sock (or COMPUTER_HELPER_SOCKET
//     env) when the launchd daemon is installed and listening. Sub-50ms per
//     call. Path is internal scratch — sibling of browser.sock.
//   - stdio: spawn the helper binary as a child process per call. Used in
//     dev (no install-helper) and as a fallback. The legacy probe.py and
//     drive-capcut.py scripts in rush/agents still use this shape.
//
// Both transports share the same line-delimited JSON-RPC wire format:
//   in:  {"id":N,"method":"...","params":{...}}
//   out: {"id":N,"result":{...}} or {"id":N,"error":{"code":"...","message":"..."}}

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { createConnection, type Socket } from 'net';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { getHelpersDir, getLogsDir } from './state.js';

export interface RPCResponse {
  id: number | null;
  result?: Record<string, unknown>;
  error?: { code: string; message: string };
}

export interface ComputerClient {
  call(method: string, params?: Record<string, unknown>): Promise<RPCResponse>;
  close(): Promise<void>;
}

// Resolve the socket path used by the launchd-managed daemon. Internal
// scratch — lives under getHelpersDir() (~/.agents/.cache/helpers/),
// matching browser.sock.
export function resolveSocketPath(): string {
  const envPath = process.env.COMPUTER_HELPER_SOCKET;
  if (envPath && envPath.length > 0) return envPath;
  return path.join(getHelpersDir(), 'computer.sock');
}

// Default log path for the launchd-managed daemon. Lives in the cache/logs/
// bucket (matches the scheduler daemon's logs.jsonl convention).
export function resolveLogPath(): string {
  return path.join(getLogsDir(), 'computer-helper.log');
}

// Resolve the helper executable inside the dist .app bundle. Used by the
// stdio fallback and by install-helper to find the source bundle.
export function resolveHelperExec(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // Local build (running from the agents-cli checkout).
    path.resolve(here, '..', '..', 'packages', 'computer-helper', 'dist', 'ComputerHelper.app', 'Contents', 'MacOS', 'ComputerHelper'),
    // Bundled with the npm package (later: CDN download lands here).
    path.resolve(here, '..', 'computer-helper', 'ComputerHelper.app', 'Contents', 'MacOS', 'ComputerHelper'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

// Resolve the dist .app bundle directory (not the inner exec).
export function resolveHelperApp(): string | null {
  const exec = resolveHelperExec();
  if (!exec) return null;
  // exec = <bundle>/Contents/MacOS/ComputerHelper
  return path.resolve(exec, '..', '..', '..');
}

// Pick the best transport. If the socket exists, use it. Otherwise fall
// back to spawning the helper as a subprocess (legacy path).
export function openComputerClient(): ComputerClient {
  const sockPath = resolveSocketPath();
  if (fs.existsSync(sockPath)) {
    return new SocketClient(sockPath);
  }
  const helperExec = resolveHelperExec();
  if (!helperExec) {
    throw new Error('helper not built. Run: ./packages/computer-helper/scripts/build.sh debug');
  }
  return new StdioClient(helperExec);
}

// Shared waiter map + line parser. Both transports plug their reader into
// `handleChunk` and their writer into `send`.
abstract class BaseClient implements ComputerClient {
  protected buf = '';
  protected waiters = new Map<number, (r: RPCResponse) => void>();
  protected nextId = 1;
  protected closed = false;

  protected handleChunk(chunk: string): void {
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
        // Drop garbage; helper diagnostics go to stderr / log file.
      }
    }
  }

  protected failPending(code: string, message: string): void {
    for (const [id, resolve] of this.waiters) {
      resolve({ id, error: { code, message } });
    }
    this.waiters.clear();
  }

  async call(method: string, params?: Record<string, unknown>): Promise<RPCResponse> {
    if (this.closed) {
      return { id: null, error: { code: 'helper_exited', message: 'helper not running' } };
    }
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params: params ?? {} }) + '\n';
    return new Promise((resolve) => {
      this.waiters.set(id, resolve);
      this.send(payload);
    });
  }

  protected abstract send(payload: string): void;
  abstract close(): Promise<void>;
}

class SocketClient extends BaseClient {
  private sock: Socket;

  constructor(socketPath: string) {
    super();
    this.sock = createConnection({ path: socketPath });
    this.sock.setEncoding('utf8');
    this.sock.on('data', (chunk: string) => this.handleChunk(chunk));
    this.sock.on('error', (err) => {
      this.closed = true;
      this.failPending('socket_error', err.message);
    });
    this.sock.on('close', () => {
      this.closed = true;
      this.failPending('helper_exited', 'socket closed before reply');
    });
  }

  protected send(payload: string): void {
    this.sock.write(payload);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.sock.end();
    await new Promise<void>((resolve) => {
      if (this.closed) return resolve();
      this.sock.on('close', () => resolve());
    });
  }
}

class StdioClient extends BaseClient {
  private proc: ChildProcessWithoutNullStreams;

  constructor(helperPath: string) {
    super();
    this.proc = spawn(helperPath, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk: string) => this.handleChunk(chunk));
    this.proc.on('exit', () => {
      this.closed = true;
      this.failPending('helper_exited', 'helper exited before reply');
    });
  }

  protected send(payload: string): void {
    this.proc.stdin.write(payload);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.proc.stdin.end();
    await new Promise<void>((resolve) => {
      if (this.closed) return resolve();
      this.proc.on('exit', () => resolve());
    });
  }
}

// Describe which transport is currently in use. Useful for diagnostics
// like `agents computer status`.
export function describeTransport(): { kind: 'socket' | 'stdio' | 'none'; path: string | null } {
  const sockPath = resolveSocketPath();
  if (fs.existsSync(sockPath)) return { kind: 'socket', path: sockPath };
  const exec = resolveHelperExec();
  if (exec) return { kind: 'stdio', path: exec };
  return { kind: 'none', path: null };
}
