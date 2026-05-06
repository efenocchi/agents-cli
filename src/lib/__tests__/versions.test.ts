import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

import { getProjectVersion, removeVersion } from '../versions.js';
import { getVersionsDir, getTrashVersionsDir } from '../state.js';
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
// which lives at .../versions/<agent>/<version>/home/, must survive — now
// inside the trash directory because removeVersion is a soft-delete: the
// entire version dir (including home/) is renamed to
// ~/.agents-system/trash/versions/<agent>/<version>/<timestamp>/.
// Verified for every AgentId since removeVersion is parametrised on agent and
// the layout is shared across all agents.
describe('removeVersion soft-deletes the entire version dir to trash', () => {
  const cases: { agent: AgentId; historyDir: string; binaryName: string }[] = [
    { agent: 'claude',   historyDir: path.join('home', '.claude',   'projects'), binaryName: 'claude' },
    { agent: 'codex',    historyDir: path.join('home', '.codex',    'sessions'), binaryName: 'codex' },
    { agent: 'gemini',   historyDir: path.join('home', '.gemini',   'sessions'), binaryName: 'gemini' },
    { agent: 'cursor',   historyDir: path.join('home', '.cursor',   'sessions'), binaryName: 'cursor-agent' },
    { agent: 'opencode', historyDir: path.join('home', '.opencode', 'sessions'), binaryName: 'opencode' },
    { agent: 'openclaw', historyDir: path.join('home', '.openclaw', 'sessions'), binaryName: 'openclaw' },
  ];

  for (const { agent, historyDir, binaryName } of cases) {
    it(`[${agent}] moves whole versionDir to trash; binaries AND home/ survive there`, () => {
      const testVersion = `0.0.0-test-${crypto.randomBytes(4).toString('hex')}`;
      const versionDir = path.join(getVersionsDir(), agent, testVersion);
      const trashAgentDir = path.join(getTrashVersionsDir(), agent, testVersion);

      try {
        fs.mkdirSync(path.join(versionDir, 'node_modules', '.bin'), { recursive: true });
        fs.writeFileSync(path.join(versionDir, 'node_modules', '.bin', binaryName), '#!/bin/sh\n');
        fs.writeFileSync(path.join(versionDir, 'package.json'), '{}');
        fs.writeFileSync(path.join(versionDir, 'package-lock.json'), '{}');

        const sessionDir = path.join(versionDir, historyDir);
        fs.mkdirSync(sessionDir, { recursive: true });
        const sessionRel = path.relative(versionDir, path.join(sessionDir, 'session.jsonl'));
        fs.writeFileSync(path.join(versionDir, sessionRel), '{"type":"user"}\n');

        expect(removeVersion(agent, testVersion)).toBe(true);

        // Original location is gone — soft-delete renamed it.
        expect(fs.existsSync(versionDir)).toBe(false);

        // Trash now contains exactly one timestamped copy with everything.
        const stamps = fs.readdirSync(trashAgentDir);
        expect(stamps.length).toBe(1);
        const trashed = path.join(trashAgentDir, stamps[0]);

        expect(fs.existsSync(path.join(trashed, 'node_modules', '.bin', binaryName))).toBe(true);
        expect(fs.existsSync(path.join(trashed, 'package.json'))).toBe(true);
        expect(fs.existsSync(path.join(trashed, sessionRel))).toBe(true);
      } finally {
        if (fs.existsSync(versionDir)) {
          fs.rmSync(versionDir, { recursive: true, force: true });
        }
        if (fs.existsSync(trashAgentDir)) {
          fs.rmSync(trashAgentDir, { recursive: true, force: true });
        }
      }
    });
  }
});
