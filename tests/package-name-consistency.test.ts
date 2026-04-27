/**
 * Locks the npm-package-name vs github-repo-url dual identity.
 *
 * The published npm package and the source GitHub repo live under different
 * orgs (npm: @companion; github: phnx-labs). Every reference must use the
 * correct one, or `agents upgrade` installs the wrong package, version-check
 * silently 404s, or the landing page misleads users.
 *
 * Caught in audit EXAMPLE-595 — fix-install over-normalized to companion, leaving
 * three broken `@phnx-labs/agents-cli@latest` references in src/index.ts and
 * an invalid github.com/companion/agents-cli repository URL in package.json.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..');
const NPM_PACKAGE = '@companion/agents-cli';
const GITHUB_REPO = 'github.com/phnx-labs/agents-cli';

function read(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf-8');
}

describe('package-name dual identity (npm vs github)', () => {
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

  it('src/index.ts never references the wrong @phnx-labs npm scope', () => {
    const src = read('src/index.ts');
    // The npm scope is @companion. Any @phnx-labs/agents-cli substring is a bug.
    expect(src).not.toContain('@phnx-labs/agents-cli');
  });

  it('src/index.ts upgrade commands install the canonical package', () => {
    const src = read('src/index.ts');
    // Both the answer-yes branch and the upgrade-command branch must point
    // at the @companion package.
    const matches = src.match(/'install',\s*'-g',\s*'([^']+)'/g) ?? [];
    expect(matches.length).toBeGreaterThan(0);
    for (const m of matches) {
      expect(m).toContain(NPM_PACKAGE);
    }
  });

  it('src/index.ts version-check URLs target the canonical package', () => {
    const src = read('src/index.ts');
    // unpkg.com CHANGELOG fetch + npm registry latest fetch.
    expect(src).toContain(`unpkg.com/${NPM_PACKAGE}`);
    expect(src).toContain(`registry.npmjs.org/${NPM_PACKAGE}/latest`);
    expect(src).not.toContain('unpkg.com/@phnx-labs/agents-cli');
    expect(src).not.toContain('registry.npmjs.org/@phnx-labs/agents-cli');
  });

  it('postinstall script references the canonical package', () => {
    const post = read('scripts/postinstall.js');
    expect(post).toContain(NPM_PACKAGE);
    expect(post).not.toContain('@phnx-labs/agents-cli');
  });

  it('public teams import path comment matches the canonical package', () => {
    const teamsIndex = read('src/lib/teams/index.ts');
    expect(teamsIndex).not.toContain("'@phnx-labs/agents-cli/teams'");
  });
});
