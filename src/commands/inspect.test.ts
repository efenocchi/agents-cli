import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveRepoTarget, collectRepoKind } from './inspect.js';
import { getUserAgentsDir, getSystemAgentsDir } from '../lib/state.js';

const tempDirs: string[] = [];

/** A fake project repo: <root>/.agents/ with commands + a skill bundle. */
function makeProjectRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-inspect-'));
  tempDirs.push(root);
  const agentsDir = path.join(root, '.agents');
  fs.mkdirSync(path.join(agentsDir, 'commands'), { recursive: true });
  fs.writeFileSync(
    path.join(agentsDir, 'commands', 'ship.md'),
    '---\ndescription: Ship the thing\n---\n\nShip it.\n',
  );
  fs.writeFileSync(path.join(agentsDir, 'commands', 'plain.md'), '# Plain command\n\nbody\n');
  const skillDir = path.join(agentsDir, 'skills', 'deploy');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    '---\nname: deploy\ndescription: Deploy services\n---\n\nSteps.\n',
  );
  return root;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('resolveRepoTarget', () => {
  it('maps the built-in layer names to their roots', () => {
    expect(resolveRepoTarget('user')).toEqual({ label: 'user', root: getUserAgentsDir() });
    expect(resolveRepoTarget('system')).toEqual({ label: 'system', root: getSystemAgentsDir() });
  });

  it('accepts a repo path and descends into its .agents/ dir', () => {
    const root = makeProjectRepo();
    const resolved = resolveRepoTarget(root);
    expect(resolved).toEqual({ label: path.basename(root), root: path.join(root, '.agents') });
  });

  it('accepts a DotAgents root directly and labels it by parent dir', () => {
    const root = makeProjectRepo();
    const resolved = resolveRepoTarget(path.join(root, '.agents'));
    expect(resolved).toEqual({ label: path.basename(root), root: path.join(root, '.agents') });
  });

  it('resolves relative paths against the provided cwd', () => {
    const root = makeProjectRepo();
    const resolved = resolveRepoTarget('.agents', root);
    expect(resolved?.root).toBe(path.join(root, '.agents'));
  });

  it('rejects directories with no DotAgents markers', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-inspect-empty-'));
    tempDirs.push(dir);
    expect(resolveRepoTarget(dir)).toBeNull();
  });

  it('rejects targets that are not directories', () => {
    expect(resolveRepoTarget('definitely-not-a-repo-or-agent')).toBeNull();
  });
});

describe('collectRepoKind', () => {
  it('lists files with extension stripped and frontmatter descriptions', () => {
    const root = makeProjectRepo();
    const repo = resolveRepoTarget(root)!;

    const commands = collectRepoKind(repo, 'commands');
    expect(commands.map(c => c.name)).toEqual(['plain', 'ship']);
    const ship = commands.find(c => c.name === 'ship')!;
    expect(ship.description).toBe('Ship the thing');
    expect(ship.source).toBe(repo.label);
    const plain = commands.find(c => c.name === 'plain')!;
    expect(plain.description).toBe('Plain command');
  });

  it('lists skill bundles and links to their SKILL.md', () => {
    const root = makeProjectRepo();
    const repo = resolveRepoTarget(root)!;

    const skills = collectRepoKind(repo, 'skills');
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe('deploy');
    expect(skills[0].description).toBe('Deploy services');
    expect(skills[0].linkTarget).toBe(path.join(root, '.agents', 'skills', 'deploy', 'SKILL.md'));
  });

  it('returns empty for kinds with no directory', () => {
    const root = makeProjectRepo();
    const repo = resolveRepoTarget(root)!;
    expect(collectRepoKind(repo, 'workflows')).toEqual([]);
  });
});
