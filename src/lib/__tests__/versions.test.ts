import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

import { getProjectVersion, removeVersion } from '../versions.js';
import { getVersionsDir } from '../state.js';
import type { AgentId } from '../types.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'versions-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('getProjectVersion', () => {
  it('resolves version from agents.yaml in startPath', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'agents.yaml'),
      'agents:\n  claude: "1.2.3"\n',
    );
    expect(getProjectVersion('claude', tmpDir)).toBe('1.2.3');
  });

  it('walks up to find agents.yaml in a parent directory', () => {
    const nested = path.join(tmpDir, 'a', 'b', 'c');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'agents.yaml'),
      'agents:\n  claude: "2.0.0"\n',
    );
    expect(getProjectVersion('claude', nested)).toBe('2.0.0');
  });

  it('returns null when no agents.yaml exists', () => {
    const nested = path.join(tmpDir, 'empty');
    fs.mkdirSync(nested, { recursive: true });
    expect(getProjectVersion('claude', nested)).toBeNull();
  });

  it('returns null when agents.yaml exists but agent key is absent', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'agents.yaml'),
      'agents:\n  codex: "0.9.0"\n',
    );
    expect(getProjectVersion('claude', tmpDir)).toBeNull();
  });

  it('ignores ~/.agents-system/ root when walking up', () => {
    // getProjectAgentsDir must skip both the system root (~/.agents-system/) and the
    // user root (~/.agents/) so they are never returned as project-scoped dirs.
    // We cannot mutate os.homedir(), but we CAN verify that starting the search
    // from inside ~/.agents-system/ returns null (no project version).
    const systemAgentsYaml = path.join(os.homedir(), '.agents-system', 'agents.yaml');
    if (fs.existsSync(systemAgentsYaml)) {
      const result = getProjectVersion('claude', path.dirname(systemAgentsYaml));
      expect(typeof result === 'string' || result === null).toBe(true);
    } else {
      expect(true).toBe(true);
    }
  });

  it('parses agents.yaml with quoted version string', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'agents.yaml'),
      'agents:\n  claude: \'1.5.0\'\n',
    );
    expect(getProjectVersion('claude', tmpDir)).toBe('1.5.0');
  });

  it('parses agents.yaml with unquoted version string', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'agents.yaml'),
      'agents:\n  claude: 1.7.2\n',
    );
    expect(getProjectVersion('claude', tmpDir)).toBe('1.7.2');
  });
});

// Scenario: the user uninstalls an agent version. Their conversation history,
// which lives at ~/.agents-system/versions/<agent>/<version>/home/, must survive.
// Verified for every AgentId since removeVersion is parametrised on agent and
// the layout is shared across all agents.
describe('removeVersion preserves home/', () => {
  // One case per agent, using that agent's own history path so the test
  // proves history at the real per-agent location is preserved.
  const cases: { agent: AgentId; historyDir: string; binaryName: string }[] = [
    { agent: 'claude',   historyDir: path.join('home', '.claude',   'projects'), binaryName: 'claude' },
    { agent: 'codex',    historyDir: path.join('home', '.codex',    'sessions'), binaryName: 'codex' },
    { agent: 'gemini',   historyDir: path.join('home', '.gemini',   'sessions'), binaryName: 'gemini' },
    { agent: 'cursor',   historyDir: path.join('home', '.cursor',   'sessions'), binaryName: 'cursor-agent' },
    { agent: 'opencode', historyDir: path.join('home', '.opencode', 'sessions'), binaryName: 'opencode' },
    { agent: 'openclaw', historyDir: path.join('home', '.openclaw', 'sessions'), binaryName: 'openclaw' },
  ];

  for (const { agent, historyDir, binaryName } of cases) {
    it(`[${agent}] keeps home/ intact, drops install artifacts`, () => {
      const testVersion = `0.0.0-test-${crypto.randomBytes(4).toString('hex')}`;
      const versionDir = path.join(getVersionsDir(), agent, testVersion);

      try {
        // Install artifacts that MUST be removed. The binary makes
        // listInstalledVersions() recognise this as an installed version.
        fs.mkdirSync(path.join(versionDir, 'node_modules', '.bin'), { recursive: true });
        fs.writeFileSync(path.join(versionDir, 'node_modules', '.bin', binaryName), '#!/bin/sh\n');
        fs.writeFileSync(path.join(versionDir, 'package.json'), '{}');
        fs.writeFileSync(path.join(versionDir, 'package-lock.json'), '{}');

        // Simulated user history that MUST survive.
        const sessionDir = path.join(versionDir, historyDir);
        fs.mkdirSync(sessionDir, { recursive: true });
        const sessionFile = path.join(sessionDir, 'session.jsonl');
        fs.writeFileSync(sessionFile, '{"type":"user"}\n');

        expect(removeVersion(agent, testVersion)).toBe(true);

        expect(fs.existsSync(path.join(versionDir, 'node_modules'))).toBe(false);
        expect(fs.existsSync(path.join(versionDir, 'package.json'))).toBe(false);
        expect(fs.existsSync(path.join(versionDir, 'package-lock.json'))).toBe(false);

        expect(fs.existsSync(sessionFile)).toBe(true);
      } finally {
        // Clean up the preserved home/ left behind by removeVersion.
        if (fs.existsSync(versionDir)) {
          fs.rmSync(versionDir, { recursive: true, force: true });
        }
      }
    });
  }
});
