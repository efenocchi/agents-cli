import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  getBackupsDir,
  getCommandsDir,
  getDriveDir,
  getHooksDir,
  getPackagesDir,
  getPluginsDir,
  getRoutinesDir,
  getRunsDir,
  getShimsDir,
  getSkillsDir,
  getTrashDir,
  getTrashVersionsDir,
  getVersionsDir,
} from '../state.js';

describe('state paths', () => {
  it('keeps system resource directories under ~/.agents-system', () => {
    const systemRoot = path.join(os.homedir(), '.agents-system');

    expect(getCommandsDir()).toBe(path.join(systemRoot, 'commands'));
    expect(getHooksDir()).toBe(path.join(systemRoot, 'hooks'));
    expect(getSkillsDir()).toBe(path.join(systemRoot, 'skills'));
  });

  it('stores operational state under ~/.agents', () => {
    const userRoot = path.join(os.homedir(), '.agents');

    expect(getPackagesDir()).toBe(path.join(userRoot, 'packages'));
    expect(getRoutinesDir()).toBe(path.join(userRoot, 'routines'));
    expect(getRunsDir()).toBe(path.join(userRoot, 'routines', 'runs'));
    expect(getVersionsDir()).toBe(path.join(userRoot, 'versions'));
    expect(getShimsDir()).toBe(path.join(userRoot, 'shims'));
    expect(getBackupsDir()).toBe(path.join(userRoot, '.backups'));
    expect(getPluginsDir()).toBe(path.join(userRoot, 'plugins'));
    expect(getDriveDir()).toBe(path.join(userRoot, 'drive'));
    expect(getTrashDir()).toBe(path.join(userRoot, '.trash'));
    expect(getTrashVersionsDir()).toBe(path.join(userRoot, '.trash', 'versions'));
  });
});

describe('readMeta merges agents.yaml from both repos', () => {
  let testDir: string;
  let userDir: string;
  let systemDir: string;
  const modulePath = path.resolve(process.cwd(), 'src/lib/state.ts');

  function runReadMeta(home: string): Record<string, unknown> {
    const result = execFileSync(
      'bun',
      [
        '-e',
        `import { readMeta } from ${JSON.stringify(modulePath)}; console.log(JSON.stringify(readMeta()));`,
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, HOME: home },
        stdio: 'pipe',
        encoding: 'utf8',
      },
    ).trim();
    return JSON.parse(result);
  }

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'state-test-'));
    userDir = path.join(testDir, '.agents');
    systemDir = path.join(testDir, '.agents-system');
    fs.mkdirSync(userDir, { recursive: true });
    fs.mkdirSync(systemDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('merges agents from both system and user repos, user wins on conflict', () => {
    // System repo has claude@1.0.0 and codex@2.0.0
    fs.writeFileSync(
      path.join(systemDir, 'agents.yaml'),
      'agents:\n  claude: "1.0.0"\n  codex: "2.0.0"\n'
    );
    // User repo has claude@3.0.0 (overrides) and gemini@1.0.0 (new)
    fs.writeFileSync(
      path.join(userDir, 'agents.yaml'),
      'agents:\n  claude: "3.0.0"\n  gemini: "1.0.0"\n'
    );

    const meta = runReadMeta(testDir);
    const agents = meta.agents as Record<string, string>;

    // claude should be 3.0.0 (user wins)
    expect(agents.claude).toBe('3.0.0');
    // codex should be 2.0.0 (from system, not in user)
    expect(agents.codex).toBe('2.0.0');
    // gemini should be 1.0.0 (from user, not in system)
    expect(agents.gemini).toBe('1.0.0');
  });

  it('reads from system repo when user repo has no agents.yaml', () => {
    fs.writeFileSync(
      path.join(systemDir, 'agents.yaml'),
      'agents:\n  claude: "1.0.0"\n'
    );

    const meta = runReadMeta(testDir);
    const agents = meta.agents as Record<string, string>;

    expect(agents.claude).toBe('1.0.0');
  });

  it('reads from user repo when system repo has no agents.yaml', () => {
    fs.writeFileSync(
      path.join(userDir, 'agents.yaml'),
      'agents:\n  claude: "2.0.0"\n'
    );

    const meta = runReadMeta(testDir);
    const agents = meta.agents as Record<string, string>;

    expect(agents.claude).toBe('2.0.0');
  });
});
