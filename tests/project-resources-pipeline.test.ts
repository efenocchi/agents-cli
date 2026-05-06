/**
 * Project-resource pipeline integration tests.
 *
 * Drives compileRulesForProject + resolveResource + listMcpServerConfigs
 * against the checked-in fixture at tests/fixtures/project-resources/.
 * No agent CLI invocations, no LLM calls — pure filesystem assertions.
 *
 * Mock strategy: redirect getUserAgentsDir/getSystemAgentsDir/etc. to empty
 * temp dirs so the project layer is the only one with content. The real
 * getProjectAgentsDir walk-up is preserved (project discovery is what we're
 * actually testing).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let TEMP_ROOT = '';
let USER_DIR = '';
let SYSTEM_DIR = '';

vi.mock('../src/lib/state.js', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/state.js')>('../src/lib/state.js');
  return {
    ...actual,
    getUserAgentsDir: () => USER_DIR,
    getSystemAgentsDir: () => SYSTEM_DIR,
    getAgentsDir: () => SYSTEM_DIR,
    getUserRulesDir: () => path.join(USER_DIR, 'rules'),
    getResolvedRulesDir: () => path.join(SYSTEM_DIR, 'rules'),
    getEnabledExtraRepos: () => [],
    getMcpDir: () => path.join(SYSTEM_DIR, 'mcp'),
    getUserMcpDir: () => path.join(USER_DIR, 'mcp'),
  };
});

const FIXTURE_SRC = path.resolve(__dirname, 'fixtures', 'project-resources');

interface FixtureLayout {
  repoRoot: string;
  siblingRoot: string;
  nestedCwd: string;
}

function setupFixture(): FixtureLayout {
  TEMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-res-'));
  // Use cp -R so symlinks/empty dirs survive. Source includes hidden .agents/.
  const cp = spawnSync('cp', ['-R', `${FIXTURE_SRC}/.`, TEMP_ROOT]);
  if (cp.status !== 0) {
    throw new Error(`fixture copy failed: ${cp.stderr.toString()}`);
  }
  USER_DIR = path.join(TEMP_ROOT, '_user_empty');
  SYSTEM_DIR = path.join(TEMP_ROOT, '_system_empty');
  fs.mkdirSync(USER_DIR, { recursive: true });
  fs.mkdirSync(SYSTEM_DIR, { recursive: true });
  return {
    repoRoot: path.join(TEMP_ROOT, 'repo'),
    siblingRoot: path.join(TEMP_ROOT, 'sibling'),
    nestedCwd: path.join(TEMP_ROOT, 'repo', 'sub', 'deep'),
  };
}

afterEach(() => {
  if (TEMP_ROOT && fs.existsSync(TEMP_ROOT)) {
    fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
  }
  TEMP_ROOT = '';
  USER_DIR = '';
  SYSTEM_DIR = '';
});

describe('project-resources: walk-up discovery', () => {
  it('finds <repo>/.agents from a nested cwd', async () => {
    const { repoRoot, nestedCwd } = setupFixture();
    const { getProjectAgentsDir } = await import('../src/lib/state.js');
    expect(getProjectAgentsDir(nestedCwd)).toBe(path.join(repoRoot, '.agents'));
  });

  it('returns null from a sibling dir without .agents', async () => {
    const { siblingRoot } = setupFixture();
    const { getProjectAgentsDir } = await import('../src/lib/state.js');
    expect(getProjectAgentsDir(siblingRoot)).toBeNull();
  });

  it('finds project from the repo root itself', async () => {
    const { repoRoot } = setupFixture();
    const { getProjectAgentsDir } = await import('../src/lib/state.js');
    expect(getProjectAgentsDir(repoRoot)).toBe(path.join(repoRoot, '.agents'));
  });
});

describe('project-resources: compileRulesForProject', () => {
  it('writes <repo>/AGENTS.md containing both project subrule tokens', async () => {
    const { repoRoot } = setupFixture();
    const { compileRulesForProject } = await import('../src/lib/rules/compile.js');

    const result = compileRulesForProject(repoRoot);

    expect(result.compiled).toBe(true);
    expect(result.skippedClobber).toEqual([]);
    expect(result.sources).toBeGreaterThanOrEqual(2);

    const compiled = fs.readFileSync(path.join(repoRoot, 'AGENTS.md'), 'utf-8');
    expect(compiled).toContain('RULE_TOKEN_PROJECT_LEVEL_RULE_LOADED');
    expect(compiled).toContain('SECRET_TOKEN_FRAGMENT_INLINED');
    // Compiled header marks ownership for idempotency / clobber-guard.
    expect(compiled.startsWith('<!-- Auto-compiled by agents-cli')).toBe(true);
  });

  it('creates per-agent symlinks (CLAUDE.md, GEMINI.md) → AGENTS.md', async () => {
    const { repoRoot } = setupFixture();
    const { compileRulesForProject } = await import('../src/lib/rules/compile.js');

    compileRulesForProject(repoRoot);

    for (const fname of ['CLAUDE.md', 'GEMINI.md']) {
      const p = path.join(repoRoot, fname);
      expect(fs.existsSync(p)).toBe(true);
      const st = fs.lstatSync(p);
      expect(st.isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(p)).toBe('AGENTS.md');
    }
  });

  it('is idempotent — second run does not rewrite when content is unchanged', async () => {
    const { repoRoot } = setupFixture();
    const { compileRulesForProject } = await import('../src/lib/rules/compile.js');

    const r1 = compileRulesForProject(repoRoot);
    expect(r1.compiled).toBe(true);

    const r2 = compileRulesForProject(repoRoot);
    expect(r2.compiled).toBe(false);
    expect(r2.skippedClobber).toEqual([]);
  });

  it('refuses to clobber a user-authored AGENTS.md (no compiled header)', async () => {
    const { repoRoot } = setupFixture();
    const userOwned = '# my hand-written project rules\nDO_NOT_TOUCH_USER_FILE\n';
    fs.writeFileSync(path.join(repoRoot, 'AGENTS.md'), userOwned);

    const { compileRulesForProject } = await import('../src/lib/rules/compile.js');
    const result = compileRulesForProject(repoRoot);

    expect(result.skippedClobber).toContain('AGENTS.md');
    const after = fs.readFileSync(path.join(repoRoot, 'AGENTS.md'), 'utf-8');
    expect(after).toBe(userOwned);
    expect(after).not.toContain('RULE_TOKEN_PROJECT_LEVEL_RULE_LOADED');
  });

  it('is a no-op when <cwd>/.agents/rules/ does not exist', async () => {
    const { siblingRoot } = setupFixture();
    const { compileRulesForProject } = await import('../src/lib/rules/compile.js');

    const result = compileRulesForProject(siblingRoot);

    expect(result.compiled).toBe(false);
    expect(result.sources).toBe(0);
    expect(fs.existsSync(path.join(siblingRoot, 'AGENTS.md'))).toBe(false);
  });
});

describe('project-resources: resolveResource project precedence', () => {
  it('resolves the project command from a nested cwd', async () => {
    const { repoRoot, nestedCwd } = setupFixture();
    const { resolveResource } = await import('../src/lib/resources.js');

    const r = resolveResource('commands', 'myproj', nestedCwd);

    expect(r).not.toBeNull();
    expect(r!.source).toBe('project');
    expect(r!.path).toBe(path.join(repoRoot, '.agents', 'commands', 'myproj.md'));
    expect(fs.readFileSync(r!.path, 'utf-8')).toContain('CMD_TOKEN_PROJECT_COMMAND_AVAILABLE');
  });

  it('project command beats user/system on name collision', async () => {
    const { repoRoot, nestedCwd } = setupFixture();
    // Plant a same-named command in the (mocked) user dir — project should still win.
    const userCmdDir = path.join(USER_DIR, 'commands');
    fs.mkdirSync(userCmdDir, { recursive: true });
    fs.writeFileSync(path.join(userCmdDir, 'myproj.md'), '# user command — should NOT win\nUSER_TOKEN\n');

    const { resolveResource } = await import('../src/lib/resources.js');
    const r = resolveResource('commands', 'myproj', nestedCwd);

    expect(r!.source).toBe('project');
    expect(r!.path).toBe(path.join(repoRoot, '.agents', 'commands', 'myproj.md'));
  });

  it('resolves the project skill', async () => {
    const { repoRoot, nestedCwd } = setupFixture();
    const { resolveResource } = await import('../src/lib/resources.js');

    const r = resolveResource('skills', 'myskill', nestedCwd);

    expect(r).not.toBeNull();
    expect(r!.source).toBe('project');
    expect(r!.path).toBe(path.join(repoRoot, '.agents', 'skills', 'myskill'));
    const body = fs.readFileSync(path.join(r!.path, 'SKILL.md'), 'utf-8');
    expect(body).toContain('SKILL_TOKEN_PROJECT_SKILL_AVAILABLE');
  });

  it('returns null for an unknown command', async () => {
    const { nestedCwd } = setupFixture();
    const { resolveResource } = await import('../src/lib/resources.js');
    expect(resolveResource('commands', 'does-not-exist', nestedCwd)).toBeNull();
  });

  it('returns null from a sibling cwd (no project, empty user/system)', async () => {
    const { siblingRoot } = setupFixture();
    const { resolveResource } = await import('../src/lib/resources.js');
    expect(resolveResource('commands', 'myproj', siblingRoot)).toBeNull();
  });
});

describe('project-resources: listMcpServerConfigs', () => {
  it('discovers project mcp yaml from a nested cwd and tags it scope=project', async () => {
    const { repoRoot, nestedCwd } = setupFixture();
    const { listMcpServerConfigs } = await import('../src/lib/mcp.js');

    const configs = listMcpServerConfigs(nestedCwd);
    const proj = configs.find((c) => c.name === 'proj-mcp-fixture');

    expect(proj).toBeDefined();
    expect(proj!.scope).toBe('project');
    expect(proj!.path).toBe(path.join(repoRoot, '.agents', 'mcp', 'proj-mcp.yaml'));
    expect(proj!.config.transport).toBe('stdio');
    expect(proj!.config.command).toBe('/usr/bin/true');
    expect(proj!.config.args).toContain('MCP_TOKEN_PROJECT_MCP_AVAILABLE');
  });

  it('returns no project mcp from a sibling cwd', async () => {
    const { siblingRoot } = setupFixture();
    const { listMcpServerConfigs } = await import('../src/lib/mcp.js');

    const configs = listMcpServerConfigs(siblingRoot);

    expect(configs.find((c) => c.name === 'proj-mcp-fixture')).toBeUndefined();
  });
});
