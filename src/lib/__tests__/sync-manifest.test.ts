import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// The module under test imports from state.ts and other libs that read real
// ~/.agents-system paths. We mock those to stay fully in tmpDir.
vi.mock('../state.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../state.js')>();
  return {
    ...real,
    getProjectAgentsDir: () => null,
    getUserAgentsDir: () => tmpDir,
    getSystemAgentsDir: () => tmpDir,
    getSkillsDir: () => path.join(tmpDir, 'skills'),
    getUserHooksDir: () => path.join(tmpDir, 'hooks'),
    getHooksDir: () => path.join(tmpDir, 'hooks'),
    getUserRulesDir: () => path.join(tmpDir, 'rules'),
    getResolvedRulesDir: () => path.join(tmpDir, 'rules'),
    getUserPermissionsDir: () => path.join(tmpDir),
    getPermissionsDir: () => path.join(tmpDir),
    getVersionsDir: () => path.join(tmpDir, 'versions'),
    getEnabledExtraRepos: () => [],
  };
});

vi.mock('../mcp.js', () => ({
  listMcpServerConfigs: () => [],
}));

vi.mock('../memory-compile.js', () => ({
  isMemoryStale: () => false,
}));

vi.mock('../permissions.js', () => ({
  getActivePermissionSetName: () => null,
}));

// tmpDir is set in beforeEach; mocks above close over the variable name, so
// we need it declared in module scope.
let tmpDir: string;

// Re-import after mocks are set up.
const { loadSyncManifest, saveSyncManifest, buildManifest, isSyncStale } =
  await import('../sync-manifest.js');

function write(rel: string, content: string): string {
  const abs = path.join(tmpDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

const AGENT = 'claude' as const;
const VERSION = 'test-0.0.1';

function emptyAvailable() {
  return {
    commands: [],
    skills: [],
    hooks: [],
    memory: [],
    mcp: [],
    permissions: [],
    subagents: [],
    plugins: [],
    promptcuts: false,
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-manifest-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('loadSyncManifest', () => {
  it('returns null when manifest is missing', () => {
    expect(loadSyncManifest(AGENT, VERSION)).toBeNull();
  });

  it('returns null when manifest version is wrong', () => {
    const p = path.join(tmpDir, 'versions', AGENT, VERSION, 'home', '.sync-manifest.json');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ v: 99 }));
    expect(loadSyncManifest(AGENT, VERSION)).toBeNull();
  });
});

describe('saveSyncManifest + loadSyncManifest round-trip', () => {
  it('writes and reads back identical content', () => {
    const available = emptyAvailable();
    const manifest = buildManifest(AGENT, VERSION, available, tmpDir);
    saveSyncManifest(AGENT, VERSION, manifest);
    const loaded = loadSyncManifest(AGENT, VERSION);
    expect(loaded).not.toBeNull();
    expect(loaded!.v).toBe(1);
    expect(loaded!.commands).toEqual({});
    expect(loaded!.skills).toEqual({});
  });
});

describe('isSyncStale — cold start', () => {
  it('returns true when manifest is null', () => {
    expect(isSyncStale(null as never, emptyAvailable(), AGENT, VERSION, tmpDir)).toBe(true);
  });
});

describe('isSyncStale — clean state', () => {
  it('returns false immediately after buildManifest with no source files', () => {
    const available = emptyAvailable();
    const manifest = buildManifest(AGENT, VERSION, available, tmpDir);
    expect(isSyncStale(manifest, available, AGENT, VERSION, tmpDir)).toBe(false);
  });

  it('returns false for a command whose source is unchanged', () => {
    write('commands/hello.md', '# Hello\nDo stuff');
    const available = { ...emptyAvailable(), commands: ['hello'] };
    const manifest = buildManifest(AGENT, VERSION, available, tmpDir);
    expect(isSyncStale(manifest, available, AGENT, VERSION, tmpDir)).toBe(false);
  });
});

describe('isSyncStale — command changes', () => {
  it('detects a new command added to source', () => {
    write('commands/hello.md', '# Hello');
    const available = { ...emptyAvailable(), commands: ['hello'] };
    const manifest = buildManifest(AGENT, VERSION, available, tmpDir);

    // Add a second command after the manifest was written
    write('commands/world.md', '# World');
    const newAvailable = { ...available, commands: ['hello', 'world'] };
    expect(isSyncStale(manifest, newAvailable, AGENT, VERSION, tmpDir)).toBe(true);
  });

  it('detects a command removed from source', () => {
    write('commands/hello.md', '# Hello');
    write('commands/world.md', '# World');
    const available = { ...emptyAvailable(), commands: ['hello', 'world'] };
    const manifest = buildManifest(AGENT, VERSION, available, tmpDir);

    const newAvailable = { ...available, commands: ['hello'] };
    expect(isSyncStale(manifest, newAvailable, AGENT, VERSION, tmpDir)).toBe(true);
  });

  it('detects content change in an existing command', () => {
    const p = write('commands/hello.md', '# Hello\nOriginal content');
    const available = { ...emptyAvailable(), commands: ['hello'] };
    const manifest = buildManifest(AGENT, VERSION, available, tmpDir);

    // Modify content, bump mtime so tier-1 also fires
    fs.writeFileSync(p, '# Hello\nModified content');
    expect(isSyncStale(manifest, available, AGENT, VERSION, tmpDir)).toBe(true);
  });

  it('returns false when mtime drifted but content is identical (tier-2 path)', () => {
    const p = write('commands/hello.md', '# Hello\nSame content');
    const available = { ...emptyAvailable(), commands: ['hello'] };
    const manifest = buildManifest(AGENT, VERSION, available, tmpDir);

    // Touch the file (new mtime) but keep same content
    const content = fs.readFileSync(p, 'utf-8');
    fs.writeFileSync(p, content);
    expect(isSyncStale(manifest, available, AGENT, VERSION, tmpDir)).toBe(false);
  });
});

describe('isSyncStale — skill directory changes', () => {
  it('detects new file added inside a skill directory', () => {
    write('skills/my-skill/SKILL.md', '# MySkill');
    const available = { ...emptyAvailable(), skills: ['my-skill'] };
    const manifest = buildManifest(AGENT, VERSION, available, tmpDir);

    // Add a second file to the skill
    write('skills/my-skill/extra.md', 'extra');
    expect(isSyncStale(manifest, available, AGENT, VERSION, tmpDir)).toBe(true);
  });

  it('detects content change inside a skill file', () => {
    const p = write('skills/my-skill/SKILL.md', 'original');
    const available = { ...emptyAvailable(), skills: ['my-skill'] };
    const manifest = buildManifest(AGENT, VERSION, available, tmpDir);

    fs.writeFileSync(p, 'modified');
    expect(isSyncStale(manifest, available, AGENT, VERSION, tmpDir)).toBe(true);
  });
});

describe('isSyncStale — hook changes', () => {
  it('detects a new hook added', () => {
    write('hooks/00-existing.sh', '#!/bin/sh');
    const available = { ...emptyAvailable(), hooks: ['00-existing.sh'] };
    const manifest = buildManifest(AGENT, VERSION, available, tmpDir);

    write('hooks/01-new.sh', '#!/bin/sh\necho hi');
    const newAvailable = { ...available, hooks: ['00-existing.sh', '01-new.sh'] };
    expect(isSyncStale(manifest, newAvailable, AGENT, VERSION, tmpDir)).toBe(true);
  });

  it('detects content change in a hook', () => {
    const p = write('hooks/00-check.sh', '#!/bin/sh\necho old');
    const available = { ...emptyAvailable(), hooks: ['00-check.sh'] };
    const manifest = buildManifest(AGENT, VERSION, available, tmpDir);

    fs.writeFileSync(p, '#!/bin/sh\necho new');
    expect(isSyncStale(manifest, available, AGENT, VERSION, tmpDir)).toBe(true);
  });
});
