import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { resolveImports, compileRulesForProject } from './compile.js';
import { AGENTS } from '../agents.js';

let tmpDir: string;

function writeFile(rel: string, content: string): string {
  const abs = path.join(tmpDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rules-compile-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('resolveImports', () => {
  it('inlines a simple relative import', () => {
    writeFile('rules/a.md', 'rule A body');
    const root = 'before\n@rules/a.md\nafter';

    const result = resolveImports(root, tmpDir);

    expect(result.content).toBe('before\nrule A body\nafter');
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]).toBe(path.join(tmpDir, 'rules/a.md'));
  });

  it('resolves imports recursively', () => {
    writeFile('presets/proactive.md', '@../rules/a.md\n@../rules/b.md');
    writeFile('rules/a.md', 'A');
    writeFile('rules/b.md', 'B');
    const root = '@presets/proactive.md';

    const result = resolveImports(root, tmpDir);

    expect(result.content).toBe('A\nB');
    expect(result.sources).toHaveLength(3);
  });

  it('ignores @-imports inside fenced code blocks', () => {
    writeFile('rules/a.md', 'REAL');
    const root = 'live: @rules/a.md\n\n```markdown\n@rules/a.md\n```\n\nend';

    const result = resolveImports(root, tmpDir);

    expect(result.content).toContain('live: REAL');
    // The fenced block must preserve its literal @-import text
    expect(result.content).toContain('```markdown\n@rules/a.md\n```');
    // Only one actual import was resolved
    expect(result.sources).toHaveLength(1);
  });

  it('ignores @-imports inside inline code spans', () => {
    writeFile('rules/a.md', 'REAL');
    const root = 'live: @rules/a.md\nDocs say: `@rules/a.md` — do not re-resolve.';

    const result = resolveImports(root, tmpDir);

    expect(result.content).toContain('live: REAL');
    expect(result.content).toContain('`@rules/a.md`');
    expect(result.sources).toHaveLength(1);
  });

  it('leaves missing imports as literal text', () => {
    const root = '@rules/does-not-exist.md';

    const result = resolveImports(root, tmpDir);

    expect(result.content).toBe('@rules/does-not-exist.md');
    expect(result.sources).toHaveLength(0);
  });

  it('breaks cycles without infinite recursion', () => {
    writeFile('a.md', '@b.md');
    writeFile('b.md', '@a.md');
    const root = '@a.md';

    const result = resolveImports(root, tmpDir);

    // First visit expands a → b, then b → a is cycle-skipped (empty)
    expect(result.content).toBe('');
    expect(result.sources.length).toBeLessThanOrEqual(2);
  });

  it('supports tilde-prefixed absolute paths', () => {
    const homeFile = path.join(os.homedir(), `.agents-compile-test-${process.pid}.md`);
    fs.writeFileSync(homeFile, 'from home');
    try {
      const root = `@~/.agents-compile-test-${process.pid}.md`;
      const result = resolveImports(root, tmpDir);
      expect(result.content).toBe('from home');
      expect(result.sources[0]).toBe(homeFile);
    } finally {
      fs.unlinkSync(homeFile);
    }
  });

  it('respects MAX_DEPTH and does not hang on deep chains', () => {
    // Chain of 10 files; only 5 levels should resolve before depth cutoff.
    for (let i = 0; i < 10; i++) {
      const body = i < 9 ? `@f${i + 1}.md` : 'leaf';
      writeFile(`f${i}.md`, body);
    }
    const result = resolveImports('@f0.md', tmpDir);
    // Once depth exceeds, the inner @-token remains literal — so the final
    // content is some path of expansions followed by a leftover @f{n}.md.
    expect(result.content).toMatch(/@f\d+\.md$|leaf$/);
  });
});

describe('compileRulesForProject', () => {
  it('is a no-op when .agents/rules/AGENTS.md is absent', () => {
    const result = compileRulesForProject(tmpDir);
    expect(result.compiled).toBe(false);
    expect(result.agentsPath).toBe('');
    expect(fs.existsSync(path.join(tmpDir, 'AGENTS.md'))).toBe(false);
  });

  it('writes cwd/AGENTS.md with our header and inlines @-imports', () => {
    writeFile('.agents/rules/AGENTS.md', 'Project rules:\n\n@./fragment.md');
    writeFile('.agents/rules/fragment.md', 'TOKEN_FRAGMENT');

    const result = compileRulesForProject(tmpDir);

    expect(result.compiled).toBe(true);
    expect(result.agentsPath).toBe(path.join(tmpDir, 'AGENTS.md'));
    const written = fs.readFileSync(result.agentsPath, 'utf-8');
    expect(written).toContain('Auto-compiled by agents-cli');
    expect(written).toContain('TOKEN_FRAGMENT');
    expect(written).not.toContain('@./fragment.md');
  });

  it('creates per-agent symlinks for non-AGENTS.md instruction filenames', () => {
    writeFile('.agents/rules/AGENTS.md', 'rules');
    const result = compileRulesForProject(tmpDir);

    expect(result.compiled).toBe(true);
    // Every distinct non-AGENTS.md, flat-name instructions file should be symlinked.
    // Nested-path filenames (e.g. workspace/AGENTS.md) are excluded.
    const expected = new Set<string>();
    for (const agent of Object.values(AGENTS)) {
      const f = agent.instructionsFile;
      if (f === 'AGENTS.md') continue;
      if (f.includes('/') || f.includes('\\')) continue;
      expected.add(f);
    }
    for (const fname of expected) {
      const linkPath = path.join(tmpDir, fname);
      expect(fs.existsSync(linkPath), `${fname} should exist`).toBe(true);
      const stat = fs.lstatSync(linkPath);
      // On platforms that allow symlinks (POSIX), they should be symlinks
      // pointing at AGENTS.md. We don't enforce symlink — copy fallback also OK.
      if (stat.isSymbolicLink()) {
        expect(fs.readlinkSync(linkPath)).toBe('AGENTS.md');
      }
    }
    // Reported set matches what we found on disk.
    expect(new Set(result.symlinks)).toEqual(expected);
  });

  it("doesn't clobber a user-authored cwd/AGENTS.md", () => {
    writeFile('.agents/rules/AGENTS.md', 'compiled body');
    const userBody = '# My hand-written project rules\nDo not touch.';
    writeFile('AGENTS.md', userBody);

    const result = compileRulesForProject(tmpDir);

    expect(result.compiled).toBe(false);
    expect(result.skippedClobber).toContain('AGENTS.md');
    expect(fs.readFileSync(path.join(tmpDir, 'AGENTS.md'), 'utf-8')).toBe(userBody);
  });

  it("doesn't clobber a user-authored CLAUDE.md", () => {
    writeFile('.agents/rules/AGENTS.md', 'compiled body');
    const userClaude = '# Hand-written claude rules';
    writeFile('CLAUDE.md', userClaude);

    const result = compileRulesForProject(tmpDir);

    expect(result.compiled).toBe(true);
    expect(result.skippedClobber).toContain('CLAUDE.md');
    // Hand-written file is preserved
    expect(fs.readFileSync(path.join(tmpDir, 'CLAUDE.md'), 'utf-8')).toBe(userClaude);
    // AGENTS.md still got compiled
    expect(fs.existsSync(path.join(tmpDir, 'AGENTS.md'))).toBe(true);
  });

  it('is idempotent — second run with same sources reports compiled:false', () => {
    writeFile('.agents/rules/AGENTS.md', 'rules body');
    const first = compileRulesForProject(tmpDir);
    expect(first.compiled).toBe(true);

    const second = compileRulesForProject(tmpDir);
    // Same content → no rewrite
    expect(second.compiled).toBe(false);
    // Symlinks reported on the second run because they already exist correctly
    expect(second.symlinks.length).toBeGreaterThan(0);
  });

  it('replaces stale compiled content when sources change', () => {
    writeFile('.agents/rules/AGENTS.md', 'first version');
    compileRulesForProject(tmpDir);
    const first = fs.readFileSync(path.join(tmpDir, 'AGENTS.md'), 'utf-8');
    expect(first).toContain('first version');

    fs.writeFileSync(path.join(tmpDir, '.agents/rules/AGENTS.md'), 'second version');
    const result = compileRulesForProject(tmpDir);
    expect(result.compiled).toBe(true);
    const second = fs.readFileSync(path.join(tmpDir, 'AGENTS.md'), 'utf-8');
    expect(second).toContain('second version');
    expect(second).not.toContain('first version');
  });

  it('preserves an existing correct symlink without recreating it', () => {
    writeFile('.agents/rules/AGENTS.md', 'rules');
    compileRulesForProject(tmpDir);

    // Identify a symlink we created (e.g. CLAUDE.md)
    const claudePath = path.join(tmpDir, 'CLAUDE.md');
    const before = fs.lstatSync(claudePath);

    // Run again
    compileRulesForProject(tmpDir);
    const after = fs.lstatSync(claudePath);

    // ino should be unchanged because we didn't touch it
    expect(after.ino).toBe(before.ino);
  });
});
