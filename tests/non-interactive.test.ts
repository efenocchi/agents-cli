import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE_VERSION = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8'),
) as { version: string };

function makeTempHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-non-interactive-'));
  // System dir: update-check and versions live here.
  // Needs a .git dir so ensureInitialized() doesn't block commands.
  const systemDir = path.join(home, '.agents-system');
  fs.mkdirSync(systemDir, { recursive: true });
  fs.mkdirSync(path.join(systemDir, '.git'), { recursive: true });
  fs.writeFileSync(
    path.join(systemDir, '.update-check'),
    JSON.stringify({ lastCheck: Date.now(), latestVersion: PACKAGE_VERSION.version }),
  );
  // User dir: commands, agents.yaml live here
  const userDir = path.join(home, '.agents');
  fs.mkdirSync(userDir, { recursive: true });
  return home;
}

function writeCentralCommand(home: string, name: string, description = 'Test command'): void {
  const commandsDir = path.join(home, '.agents', 'commands');
  fs.mkdirSync(commandsDir, { recursive: true });
  fs.writeFileSync(
    path.join(commandsDir, `${name}.md`),
    `---\ndescription: ${description}\n---\n\n# ${name}\n`,
  );
}

function writeFakeManagedVersion(
  home: string,
  agent: string,
  version: string,
  cliName: string,
  script: string = '#!/bin/sh\nexit 0\n',
): void {
  const binaryDir = path.join(home, '.agents', '.history', 'versions', agent, version, 'node_modules', '.bin');
  fs.mkdirSync(binaryDir, { recursive: true });
  const binaryPath = path.join(binaryDir, cliName);
  fs.writeFileSync(binaryPath, script);
  fs.chmodSync(binaryPath, 0o755);
}

function writeLoggingManagedVersion(
  home: string,
  agent: string,
  version: string,
  cliName: string,
  logPath: string,
): void {
  writeFakeManagedVersion(
    home,
    agent,
    version,
    cliName,
    `#!/bin/sh\necho \"$HOME|$@\" >> \"${logPath}\"\nexit 0\n`,
  );
}

function writeFakeNpmInstaller(home: string, version: string): string {
  const binDir = path.join(home, 'bin');
  const npmPath = path.join(binDir, 'npm');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    npmPath,
    [
      '#!/bin/sh',
      'if [ "$1" = "install" ]; then',
      '  mkdir -p node_modules/@openai/codex node_modules/.bin',
      `  printf '{"version":"${version}"}' > node_modules/@openai/codex/package.json`,
      '  printf "#!/bin/sh\\nexit 0\\n" > node_modules/.bin/codex',
      '  chmod 755 node_modules/.bin/codex',
      '  exit 0',
      'fi',
      'exit 1',
      '',
    ].join('\n'),
  );
  fs.chmodSync(npmPath, 0o755);
  return binDir;
}

function writeLocalPackageRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-package-repo-'));
  fs.mkdirSync(path.join(repo, 'commands'), { recursive: true });
  fs.writeFileSync(
    path.join(repo, 'commands', 'review.md'),
    '---\ndescription: Review changes\n---\n\n# review\n',
  );
  return repo;
}

function runAgents(home: string, args: string[], extraEnv: Record<string, string> = {}) {
  return spawnSync('node', ['--import', 'tsx', 'src/index.ts', ...args], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HOME: home,
      SHELL: '/bin/zsh',
      ...extraEnv,
    },
    encoding: 'utf-8',
  });
}

function seedNewerUpdateCache(home: string, futureVersion: string): void {
  const cacheDir = path.join(home, '.agents', '.cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(
    path.join(cacheDir, '.update-check'),
    JSON.stringify({ lastCheck: Date.now(), latestVersion: futureVersion }),
  );
}

const tempHomes: string[] = [];
const tempRepos: string[] = [];

afterEach(() => {
  while (tempHomes.length > 0) {
    const home = tempHomes.pop()!;
    fs.rmSync(home, { recursive: true, force: true });
  }
  while (tempRepos.length > 0) {
    const repo = tempRepos.pop()!;
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

describe('non-interactive CLI usage', () => {
  it('shows a plain hint instead of opening a picker', () => {
    const home = makeTempHome();
    tempHomes.push(home);
    writeCentralCommand(home, 'README');

    const result = runAgents(home, ['commands', 'view']);
    const combined = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(1);
    expect(combined).toContain('Selecting a command to view requires an interactive terminal.');
    expect(combined).toContain('agents commands view README');
  });

  it('syncs central commands with --names in a non-interactive shell', () => {
    const home = makeTempHome();
    tempHomes.push(home);
    writeCentralCommand(home, 'README');
    writeFakeManagedVersion(home, 'codex', '0.1.0', 'codex');

    const result = runAgents(home, ['commands', 'add', '--names', 'README', '--agents', 'codex']);
    const targetPath = path.join(
      home,
      '.agents',
      '.history',
      'versions',
      'codex',
      '0.1.0',
      'home',
      '.codex',
      'prompts',
      'README.md',
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Commands installed.');
    expect(fs.existsSync(targetPath)).toBe(true);
  });

  it('syncs only the requested explicit version target', () => {
    const home = makeTempHome();
    tempHomes.push(home);
    writeCentralCommand(home, 'README');
    writeFakeManagedVersion(home, 'codex', '0.1.0', 'codex');
    writeFakeManagedVersion(home, 'codex', '0.2.0', 'codex');

    const result = runAgents(home, ['commands', 'add', '--names', 'README', '--agents', 'codex@0.2.0']);
    const requestedPath = path.join(
      home,
      '.agents',
      '.history',
      'versions',
      'codex',
      '0.2.0',
      'home',
      '.codex',
      'prompts',
      'README.md',
    );
    const untouchedPath = path.join(
      home,
      '.agents',
      '.history',
      'versions',
      'codex',
      '0.1.0',
      'home',
      '.codex',
      'prompts',
      'README.md',
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Commands installed.');
    expect(fs.existsSync(requestedPath)).toBe(true);
    expect(fs.existsSync(untouchedPath)).toBe(false);
  });

  it('uses defaults automatically for version switching in a non-interactive shell', () => {
    const home = makeTempHome();
    tempHomes.push(home);
    writeCentralCommand(home, 'README');
    writeFakeManagedVersion(home, 'codex', '0.1.0', 'codex');

    const result = runAgents(home, ['use', 'codex@0.1.0']);
    const agentsYaml = fs.readFileSync(path.join(home, '.agents', 'agents.yaml'), 'utf-8');
    const codexSymlink = path.join(home, '.codex');

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Set Codex@0.1.0 as global default');
    expect(agentsYaml).toContain('codex: 0.1.0');
    expect(fs.lstatSync(codexSymlink).isSymbolicLink()).toBe(true);
  });

  it('does not switch an existing default during non-interactive add', () => {
    const home = makeTempHome();
    tempHomes.push(home);
    writeFakeManagedVersion(home, 'codex', '0.1.0', 'codex');
    fs.writeFileSync(path.join(home, '.agents', 'agents.yaml'), 'agents:\n  codex: 0.1.0\n');
    const fakeNpmBin = writeFakeNpmInstaller(home, '0.2.0');

    const result = runAgents(home, ['add', 'codex@0.2.0', '-y'], {
      PATH: `${fakeNpmBin}${path.delimiter}${process.env.PATH || ''}`,
    });
    const agentsYaml = fs.readFileSync(path.join(home, '.agents', 'agents.yaml'), 'utf-8');
    const installedBinary = path.join(
      home,
      '.agents',
      '.history',
      'versions',
      'codex',
      '0.2.0',
      'node_modules',
      '.bin',
      'codex',
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(fs.existsSync(installedBinary)).toBe(true);
    expect(agentsYaml).toContain('codex: 0.1.0');
    expect(agentsYaml).not.toContain('codex: 0.2.0');
    expect(result.stdout).toContain("Default remains Codex@0.1.0. Run 'agents use codex@0.2.0' to switch.");
  });

  it('installs package repo contents only to the requested explicit version target', () => {
    const home = makeTempHome();
    const repo = writeLocalPackageRepo();
    tempHomes.push(home);
    tempRepos.push(repo);
    writeFakeManagedVersion(home, 'codex', '0.1.0', 'codex');
    writeFakeManagedVersion(home, 'codex', '0.2.0', 'codex');

    const result = runAgents(home, ['install', repo, '--agents', 'codex@0.2.0']);
    const requestedPath = path.join(
      home,
      '.agents',
      '.history',
      'versions',
      'codex',
      '0.2.0',
      'home',
      '.codex',
      'prompts',
      'review.md',
    );
    const untouchedPath = path.join(
      home,
      '.agents',
      '.history',
      'versions',
      'codex',
      '0.1.0',
      'home',
      '.codex',
      'prompts',
      'review.md',
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Package installed.');
    expect(fs.existsSync(requestedPath)).toBe(true);
    expect(fs.existsSync(untouchedPath)).toBe(false);
  });

  it('registers MCPs only against the requested explicit version target', () => {
    const home = makeTempHome();
    const logPath = path.join(home, 'mcp-register.log');
    tempHomes.push(home);
    writeLoggingManagedVersion(home, 'codex', '0.1.0', 'codex', logPath);
    writeLoggingManagedVersion(home, 'codex', '0.2.0', 'codex', logPath);

    const addResult = runAgents(home, ['mcp', 'add', 'demo', '--agents', 'codex@0.2.0', '--', 'demo-server']);
    const registerResult = runAgents(home, ['mcp', 'register', 'demo']);
    const manifest = fs.readFileSync(path.join(home, '.agents', 'agents.yaml'), 'utf-8');
    const log = fs.readFileSync(logPath, 'utf-8');

    expect(addResult.status).toBe(0);
    expect(registerResult.status).toBe(0);
    expect(manifest).toContain('mcp:');
    expect(manifest).toContain('demo:');
    expect(manifest).toContain('codex:');
    expect(manifest).toContain('- 0.2.0');
    expect(log).toContain(path.join(home, '.agents', '.history', 'versions', 'codex', '0.2.0', 'home'));
    expect(log).toContain('mcp add demo -- demo-server');
    expect(log).not.toContain(path.join(home, '.agents', '.history', 'versions', 'codex', '0.1.0', 'home'));
  });

  it('registers HTTP MCPs from the manifest to Codex with --url', () => {
    const home = makeTempHome();
    const logPath = path.join(home, 'mcp-http-register.log');
    tempHomes.push(home);
    writeLoggingManagedVersion(home, 'codex', '0.2.0', 'codex', logPath);

    const addResult = runAgents(home, [
      'mcp',
      'add',
      'docs',
      'https://developers.openai.com/mcp',
      '--transport',
      'http',
      '--agents',
      'codex@0.2.0',
    ]);
    const registerResult = runAgents(home, ['mcp', 'register', 'docs']);
    const log = fs.readFileSync(logPath, 'utf-8');

    expect(addResult.status).toBe(0);
    expect(registerResult.status, `${registerResult.stdout}\n${registerResult.stderr}`).toBe(0);
    expect(registerResult.stdout).not.toContain('HTTP transport not yet supported');
    expect(log).toContain(path.join(home, '.agents', '.history', 'versions', 'codex', '0.2.0', 'home'));
    expect(log).toContain('mcp add docs --url https://developers.openai.com/mcp');
  });

  it('removes MCPs only from the requested explicit version target', () => {
    const home = makeTempHome();
    const logPath = path.join(home, 'mcp-remove.log');
    tempHomes.push(home);
    writeLoggingManagedVersion(home, 'codex', '0.1.0', 'codex', logPath);
    writeLoggingManagedVersion(home, 'codex', '0.2.0', 'codex', logPath);

    // Pre-register 'demo' in codex 0.2.0's MCP config so mcp remove can find it.
    const versionHome02 = path.join(home, '.agents', '.history', 'versions', 'codex', '0.2.0', 'home');
    const codexConfigDir = path.join(versionHome02, '.codex');
    fs.mkdirSync(codexConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(codexConfigDir, 'config.toml'),
      '[mcp_servers]\n[mcp_servers.demo]\ncommand = "demo-server"\nargs = []\n',
    );

    const result = runAgents(home, ['mcp', 'remove', 'demo', '--agents', 'codex@0.2.0']);
    const log = fs.readFileSync(logPath, 'utf-8');

    expect(result.status).toBe(0);
    expect(log).toContain(path.join(home, '.agents', '.history', 'versions', 'codex', '0.2.0', 'home'));
    expect(log).toContain('mcp remove demo');
    expect(log).not.toContain(path.join(home, '.agents', '.history', 'versions', 'codex', '0.1.0', 'home'));
  });

  it('AGENTS_CLI_DISABLE_AUTO_UPDATE skips the update check when a newer version is cached', () => {
    const home = makeTempHome();
    tempHomes.push(home);
    seedNewerUpdateCache(home, '99.0.0');

    const result = runAgents(home, ['view'], { AGENTS_CLI_DISABLE_AUTO_UPDATE: '1' });
    const combined = `${result.stdout}\n${result.stderr}`;

    expect(combined).not.toContain('Update available');
  });

  it('prints the non-TTY hint (not an interactive picker) when a newer version is cached', () => {
    const home = makeTempHome();
    tempHomes.push(home);
    seedNewerUpdateCache(home, '99.0.0');

    // tsx src/index.ts trips the dev-build auto-detect (.git at repo root)
    // and disables the update prompt by default. This test verifies the
    // update prompt itself, so override the auto-detect with an explicit
    // empty env var (falsy — doesn't trip the disable guard, doesn't
    // satisfy the "undefined" check in src/index.ts that would re-set it).
    const result = runAgents(home, ['view'], { AGENTS_CLI_DISABLE_AUTO_UPDATE: '' });
    const combined = `${result.stdout}\n${result.stderr}`;

    expect(combined).toContain(`Update available: ${PACKAGE_VERSION.version} -> 99.0.0`);
    expect(combined).not.toContain('Upgrade now');
  });
});
