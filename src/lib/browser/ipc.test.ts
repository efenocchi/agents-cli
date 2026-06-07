import { afterEach, describe, it, expect, vi } from 'vitest';
import { rmSync } from 'fs';
import * as path from 'path';
import {
  BrowserDaemonNotRunningError,
  formatBrowserDaemonNotRunningError,
  getSocketPath,
  sendIPCRequest,
} from './ipc.js';
import { getHelpersDir } from '../state.js';
import { startDaemon } from '../daemon.js';

const HELPER_DIR = `/tmp/agents-cli-browser-ipc-${process.pid}`;

// vi.mock factories close over local state but vitest 4 hoists them above
// const declarations. Keep everything the factories reference inline so the
// hoist is safe, then retrieve the vi.fn() back through the mocked module
// (`startDaemon`) for assertions.
vi.mock('../state.js', () => ({
  getHelpersDir: vi.fn(() => `/tmp/agents-cli-browser-ipc-${process.pid}`),
}));

vi.mock('../daemon.js', () => ({
  startDaemon: vi.fn(),
}));

afterEach(() => {
  rmSync(HELPER_DIR, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe('getSocketPath', () => {
  it('places the browser IPC socket in its own helper subdirectory', () => {
    expect(getSocketPath()).toBe(path.join(getHelpersDir(), 'browser', 'browser.sock'));
  });
});

describe('sendIPCRequest', () => {
  it('reports daemon-not-running without starting the daemon when autoStartDaemon is false', async () => {
    await expect(
      sendIPCRequest({ action: 'status' }, { autoStartDaemon: false })
    ).rejects.toThrow(BrowserDaemonNotRunningError);
    await expect(
      sendIPCRequest({ action: 'status' }, { autoStartDaemon: false })
    ).rejects.toThrow(formatBrowserDaemonNotRunningError());
    expect(startDaemon).not.toHaveBeenCalled();
  });
});
