import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  deriveGlobalPrefix,
  installPackageIntoPrefix,
  readInstalledVersion,
  verifyInstalledVersion,
} from './self-update.js';

const tempDirs: string[] = [];

function makeTempDir(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `agents-self-update-${label}-`));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('deriveGlobalPrefix', () => {
  it('resolves the POSIX npm global layout (<prefix>/lib/node_modules/<scoped pkg>)', () => {
    const root = path.join('/Users/x/.nvm/versions/node/v24.15.0', 'lib', 'node_modules', '@phnx-labs', 'agents-cli');
    expect(deriveGlobalPrefix(root)).toBe('/Users/x/.nvm/versions/node/v24.15.0');
  });

  it('resolves the Windows npm global layout (<prefix>/node_modules/<scoped pkg>)', () => {
    const root = path.join('/x/npm-prefix', 'node_modules', '@phnx-labs', 'agents-cli');
    expect(deriveGlobalPrefix(root)).toBe('/x/npm-prefix');
  });

  it('resolves the dev-install prefix used by scripts/install.sh', () => {
    const root = path.join('/Users/x/.local/agents-cli-dev', 'lib', 'node_modules', '@phnx-labs', 'agents-cli');
    expect(deriveGlobalPrefix(root)).toBe('/Users/x/.local/agents-cli-dev');
  });

  it('throws for a source checkout that is not under node_modules', () => {
    expect(() => deriveGlobalPrefix('/Users/x/src/github.com/muqsitnawaz/agents-cli')).toThrow(
      /not an npm-managed install/,
    );
  });
});

describe('verifyInstalledVersion', () => {
  function writePackage(dir: string, version: string): string {
    const root = path.join(dir, 'lib', 'node_modules', '@phnx-labs', 'agents-cli');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@phnx-labs/agents-cli', version }));
    return root;
  }

  it('passes when the package root carries the expected version', () => {
    const root = writePackage(makeTempDir('verify-ok'), '1.20.7');
    expect(() => verifyInstalledVersion(root, '1.20.7')).not.toThrow();
  });

  it('throws with both versions when the running root was not updated', () => {
    // The original incident: npm exits 0 after installing into a different
    // prefix, while the running copy's root still carries the old version.
    const root = writePackage(makeTempDir('verify-stale'), '1.20.4');
    expect(() => verifyInstalledVersion(root, '1.20.7')).toThrow(/still 1\.20\.4 \(expected 1\.20\.7\)/);
  });
});

describe('installPackageIntoPrefix', () => {
  function packDummyPackage(version: string): string {
    const src = makeTempDir('dummy-src');
    fs.writeFileSync(
      path.join(src, 'package.json'),
      JSON.stringify({ name: '@agents-cli-test/dummy', version, license: 'MIT' }),
    );
    const tarball = execFileSync('npm', ['pack', '--silent'], { cwd: src, encoding: 'utf-8' }).trim();
    return path.join(src, tarball);
  }

  it('installs into the given prefix and the result verifies in place', { timeout: 120_000 }, async () => {
    const prefix = makeTempDir('prefix');
    const tarball = packDummyPackage('2.0.0');

    await installPackageIntoPrefix(tarball, prefix);

    const installedRoot = path.join(prefix, 'lib', 'node_modules', '@agents-cli-test', 'dummy');
    expect(readInstalledVersion(installedRoot)).toBe('2.0.0');
    expect(() => verifyInstalledVersion(installedRoot, '2.0.0')).not.toThrow();
    // The exact upgrade-flow composition: the prefix derived from the
    // installed root must round-trip back to the prefix we installed into.
    expect(deriveGlobalPrefix(installedRoot)).toBe(prefix);
  });

  it('verification catches an install that landed in a different prefix', { timeout: 120_000 }, async () => {
    // Reproduces the divergent-prefix incident end-to-end: the "running"
    // copy lives in prefix A at 1.0.0, the install writes 2.0.0 into prefix
    // B, and verification against A's root must fail rather than report a
    // successful upgrade.
    const prefixA = makeTempDir('prefix-a');
    const prefixB = makeTempDir('prefix-b');
    const runningRoot = path.join(prefixA, 'lib', 'node_modules', '@agents-cli-test', 'dummy');
    fs.mkdirSync(runningRoot, { recursive: true });
    fs.writeFileSync(
      path.join(runningRoot, 'package.json'),
      JSON.stringify({ name: '@agents-cli-test/dummy', version: '1.0.0' }),
    );

    await installPackageIntoPrefix(packDummyPackage('2.0.0'), prefixB);

    expect(() => verifyInstalledVersion(runningRoot, '2.0.0')).toThrow(/still 1\.0\.0 \(expected 2\.0\.0\)/);
  });
});
