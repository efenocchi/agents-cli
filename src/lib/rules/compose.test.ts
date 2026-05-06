import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { composeRules, type RulesLayer } from './compose.js';

let tmpDir: string;

function writeFile(rel: string, content: string): string {
  const abs = path.join(tmpDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

function makeLayer(name: string, scope: RulesLayer['scope']): RulesLayer {
  const rulesDir = path.join(tmpDir, name);
  fs.mkdirSync(rulesDir, { recursive: true });
  return { scope, rulesDir };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compose-rules-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('composeRules — basic', () => {
  it('composes a single-layer default preset in declared order', () => {
    const sys = makeLayer('system', 'system');
    writeFile('system/subrules/a.md', 'A body');
    writeFile('system/subrules/b.md', 'B body');
    writeFile('system/rules.yaml', 'presets:\n  default:\n    subrules: [a, b]\n');

    const result = composeRules({ layers: [sys] });

    expect(result.preset).toBe('default');
    expect(result.presetLayer).toBe('system');
    expect(result.subrules.map((s) => s.name)).toEqual(['a', 'b']);
    expect(result.content).toBe('A body\n\nB body\n');
  });

  it('returns empty content when preset has no subrules', () => {
    const sys = makeLayer('system', 'system');
    writeFile('system/rules.yaml', 'presets:\n  default:\n    subrules: []\n');

    const result = composeRules({ layers: [sys] });
    expect(result.content).toBe('');
    expect(result.subrules).toHaveLength(0);
  });

  it('skips subrules that no layer provides instead of throwing', () => {
    const sys = makeLayer('system', 'system');
    writeFile('system/subrules/a.md', 'A');
    writeFile('system/rules.yaml', 'presets:\n  default:\n    subrules: [a, ghost]\n');

    const result = composeRules({ layers: [sys] });
    expect(result.subrules.map((s) => s.name)).toEqual(['a']);
    expect(result.content).toBe('A\n');
  });

  it('throws when the preset is missing from every layer', () => {
    const sys = makeLayer('system', 'system');
    writeFile('system/rules.yaml', 'presets:\n  default:\n    subrules: []\n');

    expect(() => composeRules({ preset: 'nope', layers: [sys] })).toThrow(/not found/);
  });

  it('throws when no layer has a rules.yaml at all', () => {
    const sys = makeLayer('system', 'system');
    writeFile('system/subrules/a.md', 'A');

    expect(() => composeRules({ layers: [sys] })).toThrow(/not found/);
  });
});

describe('composeRules — per-name shadowing', () => {
  it('takes a subrule from the highest-precedence layer that provides it', () => {
    const sys = makeLayer('system', 'system');
    const user = makeLayer('user', 'user');
    writeFile('system/subrules/shared.md', 'system version');
    writeFile('user/subrules/shared.md', 'user version');
    writeFile('system/rules.yaml', 'presets:\n  default:\n    subrules: [shared]\n');

    const result = composeRules({ layers: [user, sys] });
    expect(result.content).toContain('user version');
    expect(result.content).not.toContain('system version');
    expect(result.subrules[0].layerScope).toBe('user');
  });

  it('uses the highest-priority layer’s preset definition entirely (no per-name preset merging)', () => {
    const sys = makeLayer('system', 'system');
    const user = makeLayer('user', 'user');
    writeFile('system/subrules/a.md', 'A');
    writeFile('system/subrules/b.md', 'B');
    writeFile('system/rules.yaml', 'presets:\n  default:\n    subrules: [a, b]\n');
    writeFile('user/subrules/a.md', 'A user');
    writeFile('user/rules.yaml', 'presets:\n  default:\n    subrules: [a]\n');

    const result = composeRules({ layers: [user, sys] });

    // User's preset wins as a whole — only 'a' is included.
    expect(result.subrules.map((s) => s.name)).toEqual(['a']);
    expect(result.content).toBe('A user\n');
    expect(result.presetLayer).toBe('user');
  });
});

describe('composeRules — auto-append', () => {
  it('auto-appends user subrules not named by the preset', () => {
    const sys = makeLayer('system', 'system');
    const user = makeLayer('user', 'user');
    writeFile('system/subrules/core.md', 'CORE');
    writeFile('system/rules.yaml', 'presets:\n  default:\n    subrules: [core]\n');
    writeFile('user/subrules/extra.md', 'EXTRA');

    const result = composeRules({ layers: [user, sys] });

    expect(result.subrules.map((s) => s.name)).toEqual(['core', 'extra']);
    expect(result.content).toBe('CORE\n\nEXTRA\n');
  });

  it('does NOT auto-append subrules from the system layer', () => {
    const sys = makeLayer('system', 'system');
    writeFile('system/subrules/core.md', 'CORE');
    writeFile('system/subrules/orphan.md', 'ORPHAN');
    writeFile('system/rules.yaml', 'presets:\n  default:\n    subrules: [core]\n');

    const result = composeRules({ layers: [sys] });

    expect(result.subrules.map((s) => s.name)).toEqual(['core']);
    expect(result.content).not.toContain('ORPHAN');
  });

  it('auto-appends in precedence order — project before user', () => {
    const sys = makeLayer('system', 'system');
    const user = makeLayer('user', 'user');
    const project = makeLayer('project', 'project');
    writeFile('system/rules.yaml', 'presets:\n  default:\n    subrules: []\n');
    writeFile('user/subrules/u-only.md', 'U');
    writeFile('project/subrules/p-only.md', 'P');

    const result = composeRules({ layers: [project, user, sys] });

    expect(result.subrules.map((s) => s.name)).toEqual(['p-only', 'u-only']);
  });

  it('does not double-append when a subrule is both in preset and exists in user layer', () => {
    const sys = makeLayer('system', 'system');
    const user = makeLayer('user', 'user');
    writeFile('system/subrules/shared.md', 'SYS');
    writeFile('user/subrules/shared.md', 'USR');
    writeFile('system/rules.yaml', 'presets:\n  default:\n    subrules: [shared]\n');

    const result = composeRules({ layers: [user, sys] });
    expect(result.subrules).toHaveLength(1);
    expect(result.content).toBe('USR\n');
  });
});

describe('composeRules — alternate presets', () => {
  it('selects the named preset from the highest layer that defines it', () => {
    const sys = makeLayer('system', 'system');
    const user = makeLayer('user', 'user');
    writeFile('system/subrules/a.md', 'A');
    writeFile('system/subrules/b.md', 'B');
    writeFile('system/rules.yaml', `
presets:
  default:
    subrules: [a]
  full:
    subrules: [a, b]
`);
    writeFile('user/rules.yaml', `
presets:
  full:
    subrules: [b]
`);

    const result = composeRules({ preset: 'full', layers: [user, sys] });
    expect(result.presetLayer).toBe('user');
    expect(result.subrules.map((s) => s.name)).toEqual(['b']);
  });

  it('falls back through layers when an upper layer lacks the preset', () => {
    const sys = makeLayer('system', 'system');
    const user = makeLayer('user', 'user');
    writeFile('system/subrules/a.md', 'A');
    writeFile('system/rules.yaml', 'presets:\n  default:\n    subrules: [a]\n  cautious:\n    subrules: [a]\n');
    writeFile('user/rules.yaml', 'presets:\n  default:\n    subrules: []\n');

    const result = composeRules({ preset: 'cautious', layers: [user, sys] });
    expect(result.presetLayer).toBe('system');
    expect(result.subrules.map((s) => s.name)).toEqual(['a']);
  });
});

describe('composeRules — output sanity', () => {
  it('produces zero `@-import` syntax in the output', () => {
    const sys = makeLayer('system', 'system');
    writeFile('system/subrules/a.md', 'reference @other/path.md inside');
    writeFile('system/rules.yaml', 'presets:\n  default:\n    subrules: [a]\n');

    const result = composeRules({ layers: [sys] });
    // The fragment text itself is preserved verbatim; we don't try to expand it.
    expect(result.content).toContain('@other/path.md');
    // What matters: no leading `@./...` lines from a manifest.
    expect(result.content.split('\n').every((line) => !/^@\.\//.test(line))).toBe(true);
  });

  it('skips a subrule README in a layer when auto-appending', () => {
    const sys = makeLayer('system', 'system');
    const user = makeLayer('user', 'user');
    writeFile('system/rules.yaml', 'presets:\n  default:\n    subrules: []\n');
    writeFile('user/subrules/README.md', '# Docs');
    writeFile('user/subrules/real.md', 'real body');

    const result = composeRules({ layers: [user, sys] });
    expect(result.subrules.map((s) => s.name)).toEqual(['real']);
  });
});
