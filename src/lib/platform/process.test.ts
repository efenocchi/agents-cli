import { describe, it, expect } from 'vitest';
import { spawn } from 'child_process';
import { isAlive, killTree } from './process.js';

describe('isAlive', () => {
  it('is true for the current process', () => {
    expect(isAlive(process.pid)).toBe(true);
  });

  it('is false for invalid pids', () => {
    expect(isAlive(0)).toBe(false);
    expect(isAlive(-1)).toBe(false);
  });

  it('is false for a pid that is almost certainly not running', () => {
    // 2^30 is well above any realistic live PID on Linux/macOS/Windows.
    expect(isAlive(1 << 30)).toBe(false);
  });
});

describe('killTree', () => {
  it('terminates a running process', async () => {
    // A child that would otherwise live forever — killTree must actually end it.
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    const pid = child.pid!;
    expect(isAlive(pid)).toBe(true);

    killTree(pid);

    for (let i = 0; i < 100 && isAlive(pid); i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(isAlive(pid)).toBe(false);
  });

  it('is a no-op for invalid pids (never throws)', () => {
    expect(() => killTree(0)).not.toThrow();
    expect(() => killTree(-1)).not.toThrow();
  });
});
