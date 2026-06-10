import { describe, it, expect } from 'vitest';
import { isAlive } from './process.js';

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
