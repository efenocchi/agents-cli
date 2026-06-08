import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

let TMP_HOME: string;
let USER_DIR: string;
let SYSTEM_DIR: string;
let PROJECT_DIR: string;
let VERSION_HOME: string;

// state.ts derives paths from $HOME captured at module load. Mock the
// path-providing getters per-test to point at TMP_HOME; getVersionsDir feeds
// versions.ts:getVersionHomePath transitively, so no separate versions mock
// is needed. Real fs writes/reads under the temp dir — no business logic mocked.
vi.mock('./state.js', () => ({
  get getPluginsDir() { return () => path.join(USER_DIR, 'plugins'); },
  get getSystemPluginsDir() { return () => path.join(SYSTEM_DIR, 'plugins'); },
  get getExtraPluginsDir() { return (_alias: string) => path.join(TMP_HOME, '.agents-extras', _alias, 'plugins'); },
  get getProjectPluginsDir() { return (cwd: string = process.cwd()) => {
    const p = path.join(cwd, '.agents', 'plugins');
    return fs.existsSync(path.join(cwd, '.agents')) ? p : null;
  }; },
  get getProjectAgentsDir() { return (cwd: string = process.cwd()) => {
    const p = path.join(cwd, '.agents');
    return fs.existsSync(p) ? p : null;
  }; },
  get getEnabledExtraRepos() { return () => []; },
  get getVersionsDir() { return () => path.join(USER_DIR, '.history', 'versions'); },
}));

import { runLaunchSync } from './project-launch.js';
import {
  MARKETPLACE_NAME,
  PROJECT_MARKETPLACE_NAME,
  SYSTEM_MARKETPLACE_NAME,
  marketplaceManifestPath,
  marketplaceRoot,
} from './plugin-marketplace.js';

function writeFile(abs: string, content: string): void {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function writePluginManifest(pluginDir: string, name: string, version = '0.0.1'): void {
  writeFile(path.join(pluginDir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name, version, description: `Test ${name}` }));
}

function readJson(p: string): unknown {
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

beforeEach(() => {
  TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'launch-sync-test-'));
  USER_DIR = path.join(TMP_HOME, '.agents');
  SYSTEM_DIR = path.join(USER_DIR, '.system');
  PROJECT_DIR = path.join(TMP_HOME, 'project');
  VERSION_HOME = path.join(USER_DIR, '.history', 'versions', 'claude', '1.0.0', 'home');
  fs.mkdirSync(path.join(VERSION_HOME, '.claude'), { recursive: true });
  fs.mkdirSync(PROJECT_DIR, { recursive: true });
});

afterEach(() => {
  try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('runLaunchSync — workspace resource mirror', () => {
  it('symlinks .agents/subagents/*.md → cwd/.claude/agents/*.md', () => {
    writeFile(path.join(PROJECT_DIR, '.agents', 'subagents', 'reviewer.md'), '# Reviewer subagent');

    const result = runLaunchSync({ agent: 'claude', version: '1.0.0', cwd: PROJECT_DIR });

    expect(result.workspaceLinks).toBeGreaterThanOrEqual(1);
    const linked = path.join(PROJECT_DIR, '.claude', 'agents', 'reviewer.md');
    expect(fs.lstatSync(linked).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(linked, 'utf-8')).toBe('# Reviewer subagent');
  });

  it('mirrors commands, skills, and mcp.json with correct destinations', () => {
    writeFile(path.join(PROJECT_DIR, '.agents', 'commands', 'deploy.md'), '# deploy command');
    writeFile(path.join(PROJECT_DIR, '.agents', 'skills', 'auditor', 'SKILL.md'), '# auditor skill');
    writeFile(path.join(PROJECT_DIR, '.agents', 'mcp.json'), '{"servers":{}}');

    const result = runLaunchSync({ agent: 'claude', version: '1.0.0', cwd: PROJECT_DIR });

    expect(result.workspaceLinks).toBeGreaterThanOrEqual(3);
    expect(fs.lstatSync(path.join(PROJECT_DIR, '.claude', 'commands', 'deploy.md')).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(path.join(PROJECT_DIR, '.claude', 'skills', 'auditor')).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(path.join(PROJECT_DIR, '.mcp.json')).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(PROJECT_DIR, '.mcp.json'), 'utf-8')).toBe('{"servers":{}}');
  });

  it('does not clobber a hand-authored .claude/agents/foo.md', () => {
    writeFile(path.join(PROJECT_DIR, '.agents', 'subagents', 'foo.md'), '# from project rules');
    writeFile(path.join(PROJECT_DIR, '.claude', 'agents', 'foo.md'), '# hand-authored — keep me');

    const result = runLaunchSync({ agent: 'claude', version: '1.0.0', cwd: PROJECT_DIR });

    expect(result.workspaceSkipped).toContain(path.join('.claude', 'agents', 'foo.md'));
    const dest = path.join(PROJECT_DIR, '.claude', 'agents', 'foo.md');
    expect(fs.lstatSync(dest).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(dest, 'utf-8')).toBe('# hand-authored — keep me');
  });

  it('is idempotent: running twice does not duplicate links', () => {
    writeFile(path.join(PROJECT_DIR, '.agents', 'subagents', 'r.md'), '# r');

    const first = runLaunchSync({ agent: 'claude', version: '1.0.0', cwd: PROJECT_DIR });
    const second = runLaunchSync({ agent: 'claude', version: '1.0.0', cwd: PROJECT_DIR });

    expect(first.workspaceLinks).toBe(second.workspaceLinks);
    expect(fs.readdirSync(path.join(PROJECT_DIR, '.claude', 'agents'))).toEqual(['r.md']);
  });
});

describe('runLaunchSync — scoped plugin marketplaces', () => {
  it('synthesizes agents-project marketplace from cwd/.agents/plugins/*', () => {
    writePluginManifest(path.join(PROJECT_DIR, '.agents', 'plugins', 'myproj'), 'myproj');

    const result = runLaunchSync({ agent: 'claude', version: '1.0.0', cwd: PROJECT_DIR });

    expect(result.marketplaces[PROJECT_MARKETPLACE_NAME]).toContain('myproj');
    const manifestPath = marketplaceManifestPath('claude', VERSION_HOME, PROJECT_MARKETPLACE_NAME);
    const manifest = readJson(manifestPath) as { name: string; plugins: Array<{ name: string }> };
    expect(manifest.name).toBe(PROJECT_MARKETPLACE_NAME);
    expect(manifest.plugins.map(p => p.name)).toEqual(['myproj']);

    const settings = readJson(path.join(VERSION_HOME, '.claude', 'settings.json')) as { enabledPlugins: Record<string, boolean> };
    expect(settings.enabledPlugins[`myproj@${PROJECT_MARKETPLACE_NAME}`]).toBe(true);
  });

  it('synthesizes agents-system and agents-cli (user) marketplaces separately', () => {
    writePluginManifest(path.join(SYSTEM_DIR, 'plugins', 'sysplug'), 'sysplug');
    writePluginManifest(path.join(USER_DIR, 'plugins', 'userplug'), 'userplug');

    const result = runLaunchSync({ agent: 'claude', version: '1.0.0', cwd: PROJECT_DIR });

    expect(result.marketplaces[SYSTEM_MARKETPLACE_NAME]).toEqual(['sysplug']);
    expect(result.marketplaces[MARKETPLACE_NAME]).toEqual(['userplug']);

    expect(fs.existsSync(path.join(marketplaceRoot('claude', VERSION_HOME, SYSTEM_MARKETPLACE_NAME), 'plugins', 'sysplug'))).toBe(true);
    expect(fs.existsSync(path.join(marketplaceRoot('claude', VERSION_HOME, MARKETPLACE_NAME), 'plugins', 'userplug'))).toBe(true);

    const known = readJson(path.join(VERSION_HOME, '.claude', 'plugins', 'known_marketplaces.json')) as Record<string, unknown>;
    expect(Object.keys(known).sort()).toEqual([MARKETPLACE_NAME, SYSTEM_MARKETPLACE_NAME].sort());
  });

  it('returns an empty marketplaces map when no plugin sources exist', () => {
    const result = runLaunchSync({ agent: 'claude', version: '1.0.0', cwd: PROJECT_DIR });

    expect(result.marketplaces).toEqual({});
  });
});

describe('runLaunchSync — project rules compile', () => {
  it('compiles rules.yaml + subrules into cwd/AGENTS.md', () => {
    writeFile(path.join(PROJECT_DIR, '.agents', 'rules', 'rules.yaml'), 'presets:\n  default:\n    subrules:\n      - hello\n');
    writeFile(path.join(PROJECT_DIR, '.agents', 'rules', 'subrules', 'hello.md'), 'Hello from project rules.\n');

    const result = runLaunchSync({ agent: 'claude', version: '1.0.0', cwd: PROJECT_DIR });

    expect(result.rulesCompiled).toBe(true);
    const agentsMd = fs.readFileSync(path.join(PROJECT_DIR, 'AGENTS.md'), 'utf-8');
    expect(agentsMd).toContain('Hello from project rules.');
  });
});
