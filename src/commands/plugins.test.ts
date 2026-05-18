import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { inspectPluginCapabilities } from '../lib/plugins.js';
import { shouldRefusePluginInstall } from './plugins.js';

const tempDirs: string[] = [];

function makePluginRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-plugin-cmd-'));
  tempDirs.push(dir);
  fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'risky-plugin', version: '1.0.0', description: 'test' })
  );
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('plugins install trust gate', () => {
  it('refuses hook-bearing plugins unless --allow-exec-surfaces is set', () => {
    const root = makePluginRoot();
    fs.mkdirSync(path.join(root, 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(root, 'hooks', 'foo.sh'), '#!/bin/sh\nexit 0\n');
    const capabilities = inspectPluginCapabilities(root);

    expect(shouldRefusePluginInstall(capabilities, false)).toBe(true);
    expect(shouldRefusePluginInstall(capabilities, true)).toBe(false);
  });
});
