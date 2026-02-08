import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, readFileSync, lstatSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';
import {
  prepareJobHome,
  cleanJobHome,
  generateClaudeConfig,
  generateCodexConfig,
  generateGeminiConfig,
  symlinkAllowedDirs,
} from '../src/lib/sandbox.js';
import type { JobConfig } from '../src/lib/jobs.js';

const TEST_DIR = join(tmpdir(), 'agents-cli-sandbox-test');

function makeConfig(overrides: Partial<JobConfig> = {}): JobConfig {
  return {
    name: 'test-job',
    schedule: '0 9 * * *',
    agent: 'claude',
    mode: 'plan',
    effort: 'default',
    timeout: '30m',
    enabled: true,
    prompt: 'do something',
    ...overrides,
  };
}

describe('generateClaudeConfig', () => {
  const overlayHome = join(TEST_DIR, 'claude-overlay');

  beforeEach(() => {
    mkdirSync(overlayHome, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('creates .claude/settings.json', () => {
    const config = makeConfig({ allow: { tools: ['web_search'] } });
    generateClaudeConfig(overlayHome, config);

    const settingsPath = join(overlayHome, '.claude', 'settings.json');
    expect(existsSync(settingsPath)).toBe(true);

    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(settings.permissions).toBeDefined();
    expect(settings.permissions.deny).toEqual([]);
  });

  it('maps known tool names to Claude permission format', () => {
    const config = makeConfig({
      allow: { tools: ['web_search', 'web_fetch', 'bash', 'read', 'write', 'edit'] },
    });
    generateClaudeConfig(overlayHome, config);

    const settings = JSON.parse(
      readFileSync(join(overlayHome, '.claude', 'settings.json'), 'utf-8')
    );
    const perms = settings.permissions.allow;

    expect(perms).toContain('WebSearch(*)');
    expect(perms).toContain('WebFetch(*)');
    expect(perms).toContain('Bash(*)');
    expect(perms).toContain('Read(*)');
    expect(perms).toContain('Write(*)');
    expect(perms).toContain('Edit(*)');
  });

  it('passes through unknown tool names as-is', () => {
    const config = makeConfig({ allow: { tools: ['CustomTool(*)'] } });
    generateClaudeConfig(overlayHome, config);

    const settings = JSON.parse(
      readFileSync(join(overlayHome, '.claude', 'settings.json'), 'utf-8')
    );
    expect(settings.permissions.allow).toContain('CustomTool(*)');
  });

  it('adds Read permissions for allowed dirs in plan mode', () => {
    const config = makeConfig({
      mode: 'plan',
      allow: { dirs: ['/tmp/test-dir'] },
    });
    generateClaudeConfig(overlayHome, config);

    const settings = JSON.parse(
      readFileSync(join(overlayHome, '.claude', 'settings.json'), 'utf-8')
    );
    const perms = settings.permissions.allow;
    expect(perms).toContain('Read(/tmp/test-dir/**)');
    expect(perms).not.toContain('Write(/tmp/test-dir/**)');
  });

  it('adds Read+Write+Edit permissions for allowed dirs in edit mode', () => {
    const config = makeConfig({
      mode: 'edit',
      allow: { dirs: ['/tmp/test-dir'] },
    });
    generateClaudeConfig(overlayHome, config);

    const settings = JSON.parse(
      readFileSync(join(overlayHome, '.claude', 'settings.json'), 'utf-8')
    );
    const perms = settings.permissions.allow;
    expect(perms).toContain('Read(/tmp/test-dir/**)');
    expect(perms).toContain('Write(/tmp/test-dir/**)');
    expect(perms).toContain('Edit(/tmp/test-dir/**)');
  });

  it('produces empty allow list with no tools or dirs', () => {
    const config = makeConfig();
    generateClaudeConfig(overlayHome, config);

    const settings = JSON.parse(
      readFileSync(join(overlayHome, '.claude', 'settings.json'), 'utf-8')
    );
    expect(settings.permissions.allow).toEqual([]);
  });
});

describe('generateCodexConfig', () => {
  const overlayHome = join(TEST_DIR, 'codex-overlay');

  beforeEach(() => {
    mkdirSync(overlayHome, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('creates .codex/config.toml', () => {
    const config = makeConfig({ agent: 'codex' });
    generateCodexConfig(overlayHome, config);

    const tomlPath = join(overlayHome, '.codex', 'config.toml');
    expect(existsSync(tomlPath)).toBe(true);
  });

  it('sets suggest mode for plan', () => {
    const config = makeConfig({ agent: 'codex', mode: 'plan' });
    generateCodexConfig(overlayHome, config);

    const content = readFileSync(join(overlayHome, '.codex', 'config.toml'), 'utf-8');
    expect(content).toContain('approval_mode = "suggest"');
  });

  it('sets full-auto mode for edit', () => {
    const config = makeConfig({ agent: 'codex', mode: 'edit' });
    generateCodexConfig(overlayHome, config);

    const content = readFileSync(join(overlayHome, '.codex', 'config.toml'), 'utf-8');
    expect(content).toContain('approval_mode = "full-auto"');
  });

  it('includes model when specified in config', () => {
    const config = makeConfig({
      agent: 'codex',
      config: { model: 'gpt-5.2-codex' },
    });
    generateCodexConfig(overlayHome, config);

    const content = readFileSync(join(overlayHome, '.codex', 'config.toml'), 'utf-8');
    expect(content).toContain('model = "gpt-5.2-codex"');
  });

  it('includes extra config keys', () => {
    const config = makeConfig({
      agent: 'codex',
      config: { model: 'gpt-5.2-codex', sandbox: true, max_tokens: 4096 },
    });
    generateCodexConfig(overlayHome, config);

    const content = readFileSync(join(overlayHome, '.codex', 'config.toml'), 'utf-8');
    expect(content).toContain('sandbox = true');
    expect(content).toContain('max_tokens = 4096');
    expect(content.match(/model/g)?.length).toBe(1);
  });
});

describe('generateGeminiConfig', () => {
  const overlayHome = join(TEST_DIR, 'gemini-overlay');

  beforeEach(() => {
    mkdirSync(overlayHome, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('creates .gemini/settings.json', () => {
    const config = makeConfig({ agent: 'gemini' });
    generateGeminiConfig(overlayHome, config);

    const settingsPath = join(overlayHome, '.gemini', 'settings.json');
    expect(existsSync(settingsPath)).toBe(true);
  });

  it('includes model in settings', () => {
    const config = makeConfig({
      agent: 'gemini',
      config: { model: 'gemini-2.5-pro' },
    });
    generateGeminiConfig(overlayHome, config);

    const settings = JSON.parse(
      readFileSync(join(overlayHome, '.gemini', 'settings.json'), 'utf-8')
    );
    expect(settings.model).toBe('gemini-2.5-pro');
  });

  it('writes empty object when no config', () => {
    const config = makeConfig({ agent: 'gemini' });
    generateGeminiConfig(overlayHome, config);

    const settings = JSON.parse(
      readFileSync(join(overlayHome, '.gemini', 'settings.json'), 'utf-8')
    );
    expect(settings).toEqual({});
  });
});

describe('symlinkAllowedDirs', () => {
  const overlayHome = join(TEST_DIR, 'symlink-overlay');
  const realDir = join(homedir(), '.agents-cli-test-symlink-target');

  beforeEach(() => {
    mkdirSync(overlayHome, { recursive: true });
    mkdirSync(realDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    rmSync(realDir, { recursive: true, force: true });
  });

  it('creates symlink for HOME-relative dirs', () => {
    symlinkAllowedDirs(overlayHome, [realDir]);

    const expectedLink = join(overlayHome, '.agents-cli-test-symlink-target');
    expect(existsSync(expectedLink)).toBe(true);
    expect(lstatSync(expectedLink).isSymbolicLink()).toBe(true);
  });

  it('skips dirs outside HOME', () => {
    symlinkAllowedDirs(overlayHome, ['/var/log/something']);

    const entries = require('fs').readdirSync(overlayHome);
    expect(entries.length).toBe(0);
  });

  it('creates parent dirs for nested paths', () => {
    const nestedDir = join(homedir(), '.agents-cli-test-symlink-target', 'nested');
    mkdirSync(nestedDir, { recursive: true });

    symlinkAllowedDirs(overlayHome, [nestedDir]);

    const expectedLink = join(overlayHome, '.agents-cli-test-symlink-target', 'nested');
    expect(existsSync(expectedLink)).toBe(true);
  });
});

describe('cleanJobHome', () => {
  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('does nothing if overlay does not exist', () => {
    expect(() => cleanJobHome('nonexistent-job-xyz')).not.toThrow();
  });
});
