/**
 * Locks the package name and repo URL consistency.
 *
 * The canonical npm package is @phnx-labs/agents-cli, published from
 * github.com/phnx-labs/agents-cli. The old @companion scope is a
 * deprecated mirror. Every reference must use @phnx-labs.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..');
const NPM_PACKAGE = '@phnx-labs/agents-cli';
const GITHUB_REPO = 'github.com/phnx-labs/agents-cli';

function read(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf-8');
}

describe('package-name consistency (@phnx-labs canonical)', () => {
  it('package.json declares the canonical npm name', () => {
    const pkg = JSON.parse(read('package.json'));
    expect(pkg.name).toBe(NPM_PACKAGE);
  });

  it('package.json repository.url points to the real github repo', () => {
    const pkg = JSON.parse(read('package.json'));
    expect(pkg.repository?.url ?? '').toContain(GITHUB_REPO);
    expect(pkg.repository?.url ?? '').not.toContain('github.com/companion');
  });

  it('package.json bugs.url points to the real github repo', () => {
    const pkg = JSON.parse(read('package.json'));
    expect(pkg.bugs?.url ?? '').toContain(GITHUB_REPO);
    expect(pkg.bugs?.url ?? '').not.toContain('github.com/companion');
  });

  it('src/index.ts never references the old @companion npm scope', () => {
    const src = read('src/index.ts');
    expect(src).not.toContain('@companion/agents-cli');
  });

  it('src/index.ts upgrade commands install the canonical package', () => {
    const src = read('src/index.ts');
    const matches = src.match(/'install',\s*'-g',\s*'([^']+)'/g) ?? [];
    expect(matches.length).toBeGreaterThan(0);
    for (const m of matches) {
      expect(m).toContain(NPM_PACKAGE);
    }
  });

  it('src/index.ts version-check URLs target the canonical package', () => {
    const src = read('src/index.ts');
    expect(src).toContain(`unpkg.com/${NPM_PACKAGE}`);
    expect(src).toContain(`registry.npmjs.org/${NPM_PACKAGE}/latest`);
    expect(src).not.toContain('unpkg.com/@companion/agents-cli');
    expect(src).not.toContain('registry.npmjs.org/@companion/agents-cli');
  });

  it('postinstall script references the canonical package', () => {
    const post = read('scripts/postinstall.js');
    expect(post).toContain(NPM_PACKAGE);
    expect(post).not.toContain('@companion/agents-cli');
  });

  it('public teams import path comment matches the canonical package', () => {
    const teamsIndex = read('src/lib/teams/index.ts');
    expect(teamsIndex).toContain("'@phnx-labs/agents-cli/teams'");
    expect(teamsIndex).not.toContain('@companion');
  });
});
