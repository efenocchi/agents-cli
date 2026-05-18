import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { getSocketPath } from './ipc.js';
import { getHelpersDir } from '../state.js';

describe('getSocketPath', () => {
  it('places the browser IPC socket in its own helper subdirectory', () => {
    expect(getSocketPath()).toBe(path.join(getHelpersDir(), 'browser', 'browser.sock'));
  });
});
