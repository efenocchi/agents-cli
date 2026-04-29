import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Declare before vi.mock so getter closures can reference it
let tmpDir: string;

vi.mock('../state.js', async () => {
  const actual = await vi.importActual<typeof import('../state.js')>('../state.js');
  return {
    ...actual,
    get getProjectAgentsDir()   { return () => null; },
    get getUserAgentsDir()      { return () => tmpDir; },
    get getSystemAgentsDir()    { return () => tmpDir; },
    get getSkillsDir()          { return () => path.join(tmpDir, 'skills'); },
    get getUserHooksDir()       { return () => path.join(tmpDir, 'hooks'); },
    get getHooksDir()           { return () => path.join(tmpDir, 'hooks'); },
    get getUserRulesDir()       { return () => path.join(tmpDir, 'rules'); },
    get getResolvedRulesDir()   { return () => path.join(tmpDir, 'rules'); },
    get getUserPermissionsDir() { return () => tmpDir; },
    get getPermissionsDir()     { return () => tmpDir; },
    get getVersionsDir()        { return () => path.join(tmpDir, 'versions'); },
    get getEnabledExtraRepos()  { return () => []; },
  };
});

vi.mock('../resources.js', () => ({
  resolveResource: (kind: string, name: string) => {
    const base = path.join(tmpDir, kind, name);
    if (fs.existsSync(base)) return { path: base };
    return null;
  },
}));

vi.mock('../mcp.js', () => ({
  listMcpServerConfigs: () => [],
}));

vi.mock('../memory-compile.js', () => ({
  isMemoryStale: () => false,
}));

vi.mock('../permissions.js', () => ({
  getActivePermissionSetName: () => null,
}));

import { loadSyncManifest, saveSyncManifest, buildManifest, isSyncStale } from '../sync-manifest.js';

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
    commands: [], skills: [], hooks: [], memory: [], mcp: [],
    permissions: [], subagents: [], plugins: [], promptcuts: false,
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-manifest-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Load/save ────────────────────────────────────────────────────────────────

describe('loadSyncManifest', () => {
  it('returns null when manifest is missing', () => {
    expect(loadSyncManifest(AGENT, VERSION)).toBeNull();
  });

  it('returns null when manifest version field is wrong', () => {
    const p = path.join(tmpDir, 'versions', AGENT, VERSION, 'home', '.sync-manifest.json');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ v: 99 }));
    expect(loadSyncManifest(AGENT, VERSION)).toBeNull();
  });

  it('returns manifest for a valid file', () => {
    const manifest = buildManifest(AGENT, VERSION, emptyAvailable(), tmpDir);
    saveSyncManifest(AGENT, VERSION, manifest);
    expect(loadSyncManifest(AGENT, VERSION)).not.toBeNull();
  });
});

// ─── Clean state ──────────────────────────────────────────────────────────────

describe('isSyncStale — clean', () => {
  it('returns false right after buildManifest with no sources', () => {
    const available = emptyAvailable();
    const manifest = buildManifest(AGENT, VERSION, available, tmpDir);
    expect(isSyncStale(manifest, available, AGENT, VERSION, tmpDir)).toBe(false);
  });

  it('returns false when a command source is unchanged', () => {
    write('commands/hello.md', '# Hello\nDo stuff');
    const available = { ...emptyAvailable(), commands: ['hello'] };
    const manifest = buildManifest(AGENT, VERSION, available, tmpDir);
    expect(isSyncStale(manifest, available, AGENT, VERSION, tmpDir)).toBe(false);
  });

  it('returns false when mtime drifted but content is identical (tier-2 path)', () => {
    const p = write('commands/hello.md', '# Hello\nSame content');
    const available = { ...emptyAvailable(), commands: ['hello'] };
    const manifest = buildManifest(AGENT, VERSION, available, tmpDir);

    // Overwrite with identical content — mtime advances but sha256 stays same
    fs.writeFileSync(p, fs.readFileSync(p));
    expect(isSyncStale(manifest, available, AGENT, VERSION, tmpDir)).toBe(false);
  });
});

// ─── Command changes ──────────────────────────────────────────────────────────

describe('isSyncStale — commands', () => {
  it('detects new command added to source', () => {
    write('commands/hello.md', '# Hello');
    const available = { ...emptyAvailable(), commands: ['hello'] };
    const manifest = buildManifest(AGENT, VERSION, available, tmpDir);

    write('commands/world.md', '# World');
    expect(isSyncStale(manifest, { ...available, commands: ['hello', 'world'] }, AGENT, VERSION, tmpDir)).toBe(true);
  });

  it('detects command removed from source', () => {
    write('commands/hello.md', '# Hello');
    write('commands/world.md', '# World');
    const available = { ...emptyAvailable(), commands: ['hello', 'world'] };
    const manifest = buildManifest(AGENT, VERSION, available, tmpDir);

    expect(isSyncStale(manifest, { ...available, commands: ['hello'] }, AGENT, VERSION, tmpDir)).toBe(true);
  });

  it('detects content change in existing command', () => {
    const p = write('commands/hello.md', '# Hello\nOriginal content here');
    const available = { ...emptyAvailable(), commands: ['hello'] };
    const manifest = buildManifest(AGENT, VERSION, available, tmpDir);

    // Write different content with different size so mtime+size fast-path is bypassed
    fs.writeFileSync(p, '# Hello\nModified — much longer replacement content that changes size');
    expect(isSyncStale(manifest, available, AGENT, VERSION, tmpDir)).toBe(true);
  });
});

// ─── Skill directory changes ──────────────────────────────────────────────────

describe('isSyncStale — skills', () => {
  it('detects new file added inside a skill dir', () => {
    write('skills/my-skill/SKILL.md', '# MySkill');
    const available = { ...emptyAvailable(), skills: ['my-skill'] };
    const manifest = buildManifest(AGENT, VERSION, available, tmpDir);

    write('skills/my-skill/extra.md', 'extra');
    expect(isSyncStale(manifest, available, AGENT, VERSION, tmpDir)).toBe(true);
  });

  it('detects content change inside a skill file', () => {
    const p = write('skills/my-skill/SKILL.md', 'original short');
    const available = { ...emptyAvailable(), skills: ['my-skill'] };
    const manifest = buildManifest(AGENT, VERSION, available, tmpDir);

    fs.writeFileSync(p, 'modified with a longer replacement string to change file size');
    expect(isSyncStale(manifest, available, AGENT, VERSION, tmpDir)).toBe(true);
  });

  it('detects new skill added to source', () => {
    write('skills/skill-a/SKILL.md', '# A');
    const available = { ...emptyAvailable(), skills: ['skill-a'] };
    const manifest = buildManifest(AGENT, VERSION, available, tmpDir);

    write('skills/skill-b/SKILL.md', '# B');
    expect(isSyncStale(manifest, { ...available, skills: ['skill-a', 'skill-b'] }, AGENT, VERSION, tmpDir)).toBe(true);
  });
});

// ─── Hook changes ─────────────────────────────────────────────────────────────

describe('isSyncStale — hooks', () => {
  it('detects new hook file added', () => {
    write('hooks/00-check.sh', '#!/bin/sh');
    const available = { ...emptyAvailable(), hooks: ['00-check.sh'] };
    const manifest = buildManifest(AGENT, VERSION, available, tmpDir);

    write('hooks/01-new.sh', '#!/bin/sh\necho hi');
    expect(isSyncStale(manifest, { ...available, hooks: ['00-check.sh', '01-new.sh'] }, AGENT, VERSION, tmpDir)).toBe(true);
  });

  it('detects content change in hook', () => {
    const p = write('hooks/00-check.sh', '#!/bin/sh\necho old');
    const available = { ...emptyAvailable(), hooks: ['00-check.sh'] };
    const manifest = buildManifest(AGENT, VERSION, available, tmpDir);

    fs.writeFileSync(p, '#!/bin/sh\necho new content with extra lines\necho that change size');
    expect(isSyncStale(manifest, available, AGENT, VERSION, tmpDir)).toBe(true);
  });
});
