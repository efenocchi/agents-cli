import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { spawnSync } from 'child_process';
import { afterEach, describe, expect, it } from 'vitest';

const tempDirs: string[] = [];

function makeTempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-commands-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function runCommandsExpression(home: string, expression: string): unknown {
  const moduleUrl = pathToFileURL(path.resolve('src/lib/commands.ts')).href;
  const tsxBin = path.resolve('node_modules/.bin/tsx');
  const child = spawnSync(tsxBin, ['-e', `
    import {
      diffVersionCommands,
      installCommandToVersion,
      listCommandsInVersionHome,
      removeCommandFromVersion,
    } from ${JSON.stringify(moduleUrl)};
    const home = ${JSON.stringify(home)};
    const result = ${expression};
    console.log(JSON.stringify(result));
  `], {
    env: { ...process.env, HOME: home },
    encoding: 'utf-8',
  });

  expect(child.status, child.stderr).toBe(0);
  return JSON.parse(child.stdout.trim());
}

describe('version command management', () => {
  it('installs, lists, diffs, and removes generated command skills for Codex 0.117.0+', () => {
    const home = makeTempHome();
    fs.mkdirSync(path.join(home, '.agents-system', 'commands'), { recursive: true });
    fs.writeFileSync(path.join(home, '.agents-system', 'commands', 'recap.md'), 'Summarize this session.', 'utf-8');

    const installed = runCommandsExpression(home, "installCommandToVersion('codex', '0.117.0', 'recap')") as { success: boolean };
    const listed = runCommandsExpression(home, "listCommandsInVersionHome('codex', '0.117.0')") as string[];
    const diff = runCommandsExpression(home, "diffVersionCommands('codex', '0.117.0')") as {
      matched: string[];
      toAdd: string[];
      toUpdate: string[];
      orphans: string[];
    };
    const removed = runCommandsExpression(home, "removeCommandFromVersion('codex', '0.117.0', 'recap')") as { success: boolean };

    const versionHome = path.join(home, '.agents-system', 'versions', 'codex', '0.117.0', 'home', '.codex');
    expect(installed.success).toBe(true);
    expect(listed).toEqual(['recap']);
    expect(diff).toMatchObject({ matched: ['recap'], toAdd: [], toUpdate: [], orphans: [] });
    expect(removed.success).toBe(true);
    expect(fs.existsSync(path.join(versionHome, 'skills', 'recap', 'SKILL.md'))).toBe(false);
    expect(fs.existsSync(path.join(versionHome, 'prompts', 'recap.md'))).toBe(false);
  });
});
