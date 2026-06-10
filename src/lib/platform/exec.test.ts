import { describe, it, expect } from 'vitest';
import { whichCommand, findExecutable } from './exec.js';

describe('whichCommand', () => {
  it('is `where` on win32, `which` elsewhere', () => {
    expect(whichCommand('win32')).toBe('where');
    expect(whichCommand('darwin')).toBe('which');
    expect(whichCommand('linux')).toBe('which');
  });
});

describe('findExecutable', () => {
  it('resolves a real executable to an absolute path on the current platform', () => {
    // `node` is guaranteed present in CI and dev.
    const p = findExecutable('node');
    expect(p).toBeTruthy();
    expect(p!.length).toBeGreaterThan(0);
    expect(p).toMatch(/node/i);
  });

  it('returns null for a name that does not exist', () => {
    expect(findExecutable('definitely-not-a-real-binary-xyz123')).toBeNull();
  });
});
