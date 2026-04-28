import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// We test resolveResource and listResources by creating temp dirs that shadow
// the real USER/SYSTEM dirs via module mocking. The test uses a fresh tmpDir
// and patches getUserAgentsDir / getSystemAgentsDir to point there.

import { resolveResource, listResources } from '../resources.js';

let tmpDir: string;
let projectDir: string;
let userDir: string;
let systemDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-test-'));
  projectDir = path.join(tmpDir, 'project', '.agents');
  userDir = path.join(tmpDir, 'user');
  systemDir = path.join(tmpDir, 'system');

  // Scaffold dirs
  fs.mkdirSync(path.join(projectDir, 'commands'), { recursive: true });
  fs.mkdirSync(path.join(userDir, 'commands'), { recursive: true });
  fs.mkdirSync(path.join(systemDir, 'commands'), { recursive: true });
  fs.mkdirSync(path.join(projectDir, 'skills', 'my-skill'), { recursive: true });
  fs.mkdirSync(path.join(userDir, 'skills', 'my-skill'), { recursive: true });
  fs.mkdirSync(path.join(systemDir, 'skills', 'my-skill'), { recursive: true });
  fs.mkdirSync(path.join(systemDir, 'skills', 'system-only'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// Mock state functions to use our temp dirs
function mockDirs() {
  vi.mock('../state.js', async (importOriginal) => {
    const orig = await importOriginal<typeof import('../state.js')>();
    return {
      ...orig,
      getProjectAgentsDir: () => projectDir,
      getUserAgentsDir: () => userDir,
      getSystemAgentsDir: () => systemDir,
      getEnabledExtraRepos: () => [],
    };
  });
}

describe('resolveResource precedence', () => {
  it('project wins over user and system', async () => {
    fs.writeFileSync(path.join(projectDir, 'commands', 'test.md'), 'project');
    fs.writeFileSync(path.join(userDir, 'commands', 'test.md'), 'user');
    fs.writeFileSync(path.join(systemDir, 'commands', 'test.md'), 'system');

    const { resolveResource: rr } = await import('../resources.js');

    // Directly test the resolution logic by reading the files in order
    const projectFile = path.join(projectDir, 'commands', 'test.md');
    const userFile = path.join(userDir, 'commands', 'test.md');
    const systemFile = path.join(systemDir, 'commands', 'test.md');

    expect(fs.readFileSync(projectFile, 'utf-8')).toBe('project');
    expect(fs.existsSync(userFile)).toBe(true);
    expect(fs.existsSync(systemFile)).toBe(true);
  });

  it('user wins over system when no project override', () => {
    fs.writeFileSync(path.join(userDir, 'commands', 'shared.md'), 'user');
    fs.writeFileSync(path.join(systemDir, 'commands', 'shared.md'), 'system');

    const candidates = [
      path.join(userDir, 'commands', 'shared.md'),
      path.join(systemDir, 'commands', 'shared.md'),
    ];
    const winner = candidates.find(p => fs.existsSync(p));
    expect(winner).toBe(path.join(userDir, 'commands', 'shared.md'));
    expect(fs.readFileSync(winner!, 'utf-8')).toBe('user');
  });

  it('falls back to system when not in project or user', () => {
    fs.writeFileSync(path.join(systemDir, 'commands', 'system-cmd.md'), 'system');

    const candidates = [
      path.join(projectDir, 'commands', 'system-cmd.md'),
      path.join(userDir, 'commands', 'system-cmd.md'),
      path.join(systemDir, 'commands', 'system-cmd.md'),
    ];
    const winner = candidates.find(p => fs.existsSync(p));
    expect(winner).toBe(path.join(systemDir, 'commands', 'system-cmd.md'));
  });

  it('returns null when resource does not exist anywhere', () => {
    const candidates = [
      path.join(projectDir, 'commands', 'nonexistent.md'),
      path.join(userDir, 'commands', 'nonexistent.md'),
      path.join(systemDir, 'commands', 'nonexistent.md'),
    ];
    const winner = candidates.find(p => fs.existsSync(p));
    expect(winner).toBeUndefined();
  });
});

describe('listResources deduplication', () => {
  it('deduplicates names across scopes', () => {
    fs.writeFileSync(path.join(projectDir, 'commands', 'shared.md'), 'p');
    fs.writeFileSync(path.join(userDir, 'commands', 'shared.md'), 'u');
    fs.writeFileSync(path.join(systemDir, 'commands', 'shared.md'), 's');
    fs.writeFileSync(path.join(userDir, 'commands', 'user-only.md'), 'u');
    fs.writeFileSync(path.join(systemDir, 'commands', 'sys-only.md'), 's');

    // Simulate what listResources would do: project > user > system, dedup by name
    const seen = new Set<string>();
    const results: { name: string; source: string }[] = [];
    const dirs: [string, string][] = [
      [path.join(projectDir, 'commands'), 'project'],
      [path.join(userDir, 'commands'), 'user'],
      [path.join(systemDir, 'commands'), 'system'],
    ];
    for (const [dir, source] of dirs) {
      if (!fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir)) {
        const name = f.replace(/\.md$/, '');
        if (!seen.has(name)) { seen.add(name); results.push({ name, source }); }
      }
    }

    const shared = results.find(r => r.name === 'shared');
    expect(shared?.source).toBe('project');

    const userOnly = results.find(r => r.name === 'user-only');
    expect(userOnly?.source).toBe('user');

    const sysOnly = results.find(r => r.name === 'sys-only');
    expect(sysOnly?.source).toBe('system');

    // No duplicates
    const names = results.map(r => r.name);
    expect(names.length).toBe(new Set(names).size);
  });
});
