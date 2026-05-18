import { describe, it, expect, vi } from 'vitest';
import * as path from 'path';

vi.mock('../state.js', () => ({
  getHelpersDir: () => path.join('/tmp', 'agents-cli-helpers-test'),
}));

const { getSocketPath } = await import('./ipc.js');

describe('getSocketPath', () => {
  it('places the browser IPC socket in its own helper subdirectory', () => {
    expect(getSocketPath()).toBe(path.join('/tmp', 'agents-cli-helpers-test', 'browser', 'browser.sock'));
  });
});
