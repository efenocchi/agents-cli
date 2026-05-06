import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import { getAgentsDir } from '../state.js';
import { BrowserService } from './service.js';
import { startDaemon } from '../daemon.js';
import type { IPCRequest, IPCResponse } from './types.js';

const SOCKET_NAME = 'browser.sock';

export function getSocketPath(): string {
  return path.join(getAgentsDir(), SOCKET_NAME);
}

export class BrowserIPCServer {
  private server: net.Server | null = null;
  private service: BrowserService;

  constructor(service: BrowserService) {
    this.service = service;
  }

  async start(): Promise<void> {
    const socketPath = getSocketPath();

    if (fs.existsSync(socketPath)) {
      fs.unlinkSync(socketPath);
    }

    this.server = net.createServer((socket) => {
      let buffer = '';

      socket.on('data', async (data) => {
        buffer += data.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;

          try {
            const request = JSON.parse(line) as IPCRequest;
            const response = await this.handleRequest(request);
            socket.write(JSON.stringify(response) + '\n');
          } catch (err) {
            const error = err instanceof Error ? err.message : 'Unknown error';
            socket.write(JSON.stringify({ ok: false, error }) + '\n');
          }
        }
      });

      socket.on('error', () => {
        // Client disconnected
      });
    });

    return new Promise((resolve, reject) => {
      this.server!.listen(socketPath, () => {
        fs.chmodSync(socketPath, 0o600);
        resolve();
      });
      this.server!.on('error', reject);
    });
  }

  async stop(): Promise<void> {
    if (this.server) {
      this.server.close();
      this.server = null;
    }

    const socketPath = getSocketPath();
    if (fs.existsSync(socketPath)) {
      fs.unlinkSync(socketPath);
    }

    await this.service.shutdown();
  }

  private async handleRequest(request: IPCRequest): Promise<IPCResponse> {
    switch (request.action) {
      case 'start': {
        if (!request.profile) {
          return { ok: false, error: 'Profile required' };
        }
        const result = await this.service.start(request.profile, request.task);
        return { ok: true, task: result.task, windowTargetId: result.windowTargetId };
      }

      case 'stop': {
        if (request.task) {
          const result = await this.service.stop(request.task);
          return { ok: result.ok, error: result.ok ? undefined : 'Task not found' };
        }
        if (request.profile) {
          await this.service.stopProfile(request.profile);
          return { ok: true };
        }
        return { ok: false, error: 'Task or profile required' };
      }

      case 'status': {
        const profiles = await this.service.status(request.profile);
        return { ok: true, profiles };
      }

      case 'navigate': {
        if (!request.task || !request.url) {
          return { ok: false, error: 'Task and URL required' };
        }
        const result = await this.service.navigate(
          request.task,
          request.url,
          request.profile
        );
        return { ok: true, tabId: result.tabId };
      }

      case 'tabs': {
        const tabs = await this.service.tabs(request.task, request.profile);
        return { ok: true, tabs };
      }

      case 'close': {
        if (!request.task) {
          return { ok: false, error: 'Task required' };
        }
        await this.service.close(request.task, request.tabId);
        return { ok: true };
      }

      case 'evaluate': {
        if (!request.task || request.tabId === undefined || !request.expr) {
          return { ok: false, error: 'Task, tabId, and expression required' };
        }
        const result = await this.service.evaluate(
          request.task,
          request.tabId,
          request.expr
        );
        return { ok: true, result };
      }

      case 'screenshot': {
        if (!request.task) {
          return { ok: false, error: 'Task required' };
        }
        const resultPath = await this.service.screenshot(
          request.task,
          request.tabId,
          request.path
        );
        return { ok: true, path: resultPath };
      }

      case 'refs': {
        if (!request.task) {
          return { ok: false, error: 'Task required' };
        }
        const { refs } = await this.service.refs(request.task, request.tabId, {
          interactive: request.interactive ?? true,
          limit: request.limit ?? 500,
        });
        return { ok: true, refs };
      }

      case 'click': {
        if (!request.task || !request.tabId || request.ref === undefined) {
          return { ok: false, error: 'Task, tabId, and ref required' };
        }
        await this.service.click(request.task, request.tabId, request.ref);
        return { ok: true };
      }

      case 'type': {
        if (!request.task || !request.tabId || request.ref === undefined || !request.text) {
          return { ok: false, error: 'Task, tabId, ref, and text required' };
        }
        await this.service.type(request.task, request.tabId, request.ref, request.text);
        return { ok: true };
      }

      case 'press': {
        if (!request.task || !request.tabId || !request.key) {
          return { ok: false, error: 'Task, tabId, and key required' };
        }
        await this.service.press(request.task, request.tabId, request.key);
        return { ok: true };
      }

      case 'hover': {
        if (!request.task || !request.tabId || request.ref === undefined) {
          return { ok: false, error: 'Task, tabId, and ref required' };
        }
        await this.service.hover(request.task, request.tabId, request.ref);
        return { ok: true };
      }

      default:
        return { ok: false, error: `Unknown action: ${request.action}` };
    }
  }
}

export async function sendIPCRequest(request: IPCRequest): Promise<IPCResponse> {
  const socketPath = getSocketPath();

  if (!fs.existsSync(socketPath)) {
    await fs.promises.mkdir(path.dirname(socketPath), { recursive: true });
    startDaemon();
    if (!fs.existsSync(socketPath)) {
      await new Promise<void>((resolve, reject) => {
        const socketDir = path.dirname(socketPath);
        const socketName = path.basename(socketPath);
        const watcher = fs.watch(socketDir, (_event, file) => {
          if (file === socketName) {
            clearTimeout(timeout);
            watcher.close();
            resolve();
          }
        });
        watcher.on('error', (error) => {
          clearTimeout(timeout);
          watcher.close();
          reject(error);
        });
        const timeout = setTimeout(() => {
          watcher.close();
          reject(new Error('Timeout waiting for browser daemon socket'));
        }, 6000);

        if (fs.existsSync(socketPath)) {
          clearTimeout(timeout);
          watcher.close();
          resolve();
        }
      });
    }
    if (!fs.existsSync(socketPath)) {
      throw new Error('Failed to start browser daemon');
    }
  }

  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = '';

    socket.on('connect', () => {
      socket.write(JSON.stringify(request) + '\n');
    });

    socket.on('data', (data) => {
      buffer += data.toString();
      const idx = buffer.indexOf('\n');
      if (idx !== -1) {
        const response = JSON.parse(buffer.slice(0, idx)) as IPCResponse;
        socket.end();
        resolve(response);
      }
    });

    socket.on('error', (err) => {
      reject(new Error(`IPC error: ${err.message}`));
    });

    socket.on('close', () => {
      if (!buffer.includes('\n')) {
        reject(new Error('Connection closed before response'));
      }
    });
  });
}
