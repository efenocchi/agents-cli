import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { blocksLocalScripts, npmGlobalBinFromEntry } from './winpath.js';

describe('blocksLocalScripts', () => {
  // Restricted/AllSigned block the unsigned .ps1 launchers npm and agents-cli
  // generate, so the bare commands fail in PowerShell even when on PATH.
  it('flags policies that block unsigned local scripts', () => {
    for (const p of ['Restricted', 'AllSigned', 'restricted', 'allsigned', '  Restricted  ']) {
      expect(blocksLocalScripts(p)).toBe(true);
    }
  });

  it('allows policies that permit local scripts', () => {
    for (const p of ['RemoteSigned', 'Bypass', 'Unrestricted', 'Undefined']) {
      expect(blocksLocalScripts(p)).toBe(false);
    }
  });

  it('treats unknown / null policy as non-blocking (no false alarm)', () => {
    expect(blocksLocalScripts(null)).toBe(false);
    expect(blocksLocalScripts('')).toBe(false);
  });
});

describe('npmGlobalBinFromEntry', () => {
  // entry = <prefix>/node_modules/@phnx-labs/agents-cli/dist/index.js -> <prefix>
  // (on Windows the npm bin launchers live in the prefix root, where agents.cmd
  // is — exactly the dir that must be on PATH for `agents` to resolve).
  it('resolves the prefix four levels up from dist/index.js', () => {
    const prefix = path.join('opt', 'tools', 'npmglobal');
    const entry = path.join(prefix, 'node_modules', '@phnx-labs', 'agents-cli', 'dist', 'index.js');
    expect(npmGlobalBinFromEntry(entry)).toBe(path.resolve(prefix));
  });
});
