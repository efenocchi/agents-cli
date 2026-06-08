import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { spawnSync } from 'child_process';

const repoRoot = process.cwd();
const cliEntry = path.join(repoRoot, 'src', 'index.ts');
const tsxBin = path.join(repoRoot, 'node_modules', '.bin', 'tsx');

function mkdir(p: string): void {
  fs.mkdirSync(p, { recursive: true });
}

function writeFile(p: string, content: string): void {
  mkdir(path.dirname(p));
  fs.writeFileSync(p, content, 'utf-8');
}

/**
 * Build a tmp HOME with a single Claude version installed at 9.9.9, a default
 * pin in agents.yaml, and a few user-scoped resources visible to inspect.
 */
function makeFixture(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'inspect-test-' + crypto.randomBytes(4).toString('hex') + '-'));

  // ensureInitialized() looks for ~/.agents/.system/.git as the setup marker.
  mkdir(path.join(home, '.agents', '.system', '.git'));
  writeFile(path.join(home, '.agents', '.system', 'hooks.yaml'), '{}\n');

  // Suppress the update-check network call.
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf-8')) as { version: string };
  mkdir(path.join(home, '.agents', '.cache'));
  writeFile(
    path.join(home, '.agents', '.cache', '.update-check'),
    JSON.stringify({ lastCheck: Date.now(), latestVersion: pkg.version })
  );

  // Versioned Claude install: ~/.agents/.history/versions/claude/9.9.9/home/.claude/
  const versionHome = path.join(home, '.agents', '.history', 'versions', 'claude', '9.9.9', 'home');
  const claudeCfg = path.join(versionHome, '.claude');
  mkdir(claudeCfg);

  // Default pin
  writeFile(
    path.join(home, '.agents', 'agents.yaml'),
    'agents:\n  claude: 9.9.9\nrun:\n  claude:\n    strategy: balanced\n'
  );

  // User-scoped skill that should appear in inspect's resources & be drillable.
  // listInstalledSkillsWithScope reads from the version home's .claude/skills/<name>/SKILL.md.
  const skillDir = path.join(claudeCfg, 'skills', 'demo-skill');
  writeFile(
    path.join(skillDir, 'SKILL.md'),
    '---\nname: demo-skill\ndescription: A demo skill for inspect tests.\ntriggers: demo, hello\n---\n\nBody.\n'
  );

  // A second skill so the fuzzy/typo path has something to suggest.
  const skill2Dir = path.join(claudeCfg, 'skills', 'release');
  writeFile(
    path.join(skill2Dir, 'SKILL.md'),
    '---\nname: release\ndescription: Publish packages to a registry.\n---\n\nBody.\n'
  );

  // User-scoped command.
  writeFile(
    path.join(claudeCfg, 'commands', 'hello.md'),
    '---\ndescription: Say hello.\n---\n\nGreet the user.\n'
  );

  return home;
}

function run(home: string, args: string[]) {
  return spawnSync(tsxBin, [cliEntry, ...args], {
    cwd: home,
    env: {
      ...process.env,
      HOME: home,
      PATH: `${path.join(home, 'bin')}${path.delimiter}${process.env.PATH || ''}`,
      AGENTS_SKIP_MIGRATION: '1',
      NODE_NO_WARNINGS: '1',
    },
    encoding: 'utf-8',
  });
}

let fixtureHome: string;

beforeEach(() => {
  fixtureHome = makeFixture();
});

afterEach(() => {
  try { fs.rmSync(fixtureHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('agents inspect', () => {
  it('exits non-zero on unknown agent', () => {
    const r = run(fixtureHome, ['inspect', 'bogus']);
    expect(r.status).toBe(1);
    expect(r.stderr + r.stdout).toMatch(/Unknown agent/);
  });

  it('summary --json carries paths, capabilities, and resource counts', () => {
    const r = run(fixtureHome, ['inspect', 'claude', '--json']);
    expect(r.status).toBe(0);
    const data = JSON.parse(r.stdout);
    expect(data.agent).toBe('claude');
    expect(data.version).toBe('9.9.9');
    expect(data.default).toBe(true);
    expect(data.home).toContain(path.join('versions', 'claude', '9.9.9', 'home'));
    expect(data.shim).toContain('shims/claude');
    expect(data.alias).toContain('claude@9.9.9');
    expect(data.strategy).toBe('balanced');
    expect(data.capabilities.skills.ok).toBe(true);
    // Counts include at least our two seeded skills and one command.
    expect(data.resources.skills.total).toBeGreaterThanOrEqual(2);
    expect(data.resources.commands.total).toBeGreaterThanOrEqual(1);
  });

  it('--brief skips resources + sessions in JSON output', () => {
    const r = run(fixtureHome, ['inspect', 'claude', '--brief', '--json']);
    expect(r.status).toBe(0);
    const data = JSON.parse(r.stdout);
    expect(data.capabilities).toBeDefined();
    expect(data.resources).toBeNull();
    expect(data.sessions).toBeNull();
  });

  it('--skills lists installed skills with name + source + path', () => {
    const r = run(fixtureHome, ['inspect', 'claude', '--skills', '--json']);
    expect(r.status).toBe(0);
    const data = JSON.parse(r.stdout);
    expect(data.kind).toBe('skills');
    const names = (data.items as Array<{ name: string }>).map(i => i.name);
    expect(names).toContain('demo-skill');
    expect(names).toContain('release');
    const demo = (data.items as Array<{ name: string; path: string }>).find(i => i.name === 'demo-skill');
    // For bundled skills, path is the skill directory.
    expect(demo?.path).toMatch(/skills\/demo-skill$/);
  });

  it('--skills <typo> resolves via fuzzy match; bogus query exits 1 with suggestions', () => {
    // Substring match still wins for "rele" → "release".
    const ok = run(fixtureHome, ['inspect', 'claude', '--skills', 'rele', '--json']);
    expect(ok.status).toBe(0);
    const okData = JSON.parse(ok.stdout);
    expect(okData.match.name).toBe('release');

    // Damerau-Levenshtein typo: "demoo-skill" → "demo-skill".
    const fuzzy = run(fixtureHome, ['inspect', 'claude', '--skills', 'demoo-skill', '--json']);
    expect(fuzzy.status).toBe(0);
    const fuzzyData = JSON.parse(fuzzy.stdout);
    expect(fuzzyData.match.name).toBe('demo-skill');
    expect(fuzzyData.match.matchKind).toBe('fuzzy');

    // No match → exit 1 + suggestions.
    const miss = run(fixtureHome, ['inspect', 'claude', '--skills', 'absolutelynothing', '--json']);
    expect(miss.status).toBe(1);
    const missData = JSON.parse(miss.stdout);
    expect(missData.match).toBeNull();
    expect(Array.isArray(missData.suggestions)).toBe(true);
  });

  it('rejects multiple drill-down flags at once', () => {
    const r = run(fixtureHome, ['inspect', 'claude', '--skills', '--commands']);
    expect(r.status).toBe(1);
    expect(r.stderr + r.stdout).toMatch(/at most one drill-down flag/i);
  });
});
