/**
 * E2E: confirm each agent natively loads cwd/<INSTRUCTIONS_FILE>.
 *
 * Plants a project-level memory file with a unique token, runs the agent
 * non-interactively in that workspace with the user's real $HOME (real auth,
 * real user-level memory), and asserts the agent's reply includes the token.
 *
 * Confirms the load-bearing assumption behind compileMemoryForProject(cwd):
 * an agent launched in a workspace with `cwd/<INSTRUCTIONS_FILE>` reads it
 * natively, no shim help required.
 *
 * Opt-in: AGENTS_E2E=1 (real LLM calls; costs API tokens).
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { AGENTS } from '../src/lib/agents.js';
import type { AgentId } from '../src/lib/types.js';
import { getGlobalDefault } from '../src/lib/versions.js';
import { getVersionsDir } from '../src/lib/state.js';

const E2E = process.env.AGENTS_E2E === '1';
const d = E2E ? describe : describe.skip;

interface Probe {
  id: AgentId;
  args: (prompt: string) => string[];
}

// Non-interactive args per agent, with safest read-only mode where applicable.
const PROBES: Probe[] = [
  {
    id: 'claude',
    args: (p) => ['-p', p, '--allow-dangerously-skip-permissions'],
  },
  {
    id: 'codex',
    args: (p) => ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', p],
  },
  {
    id: 'gemini',
    args: (p) => ['-p', p, '--approval-mode', 'plan'],
  },
];

function resolveBinary(agent: AgentId): string {
  const version = getGlobalDefault(agent);
  if (!version) throw new Error(`No default version for ${agent}; run: agents add ${agent}`);
  const cli = AGENTS[agent].cliCommand;
  return path.join(getVersionsDir(), agent, version, 'node_modules', '.bin', cli);
}

d('agents native cwd memory loading (AGENTS_E2E=1)', () => {
  for (const probe of PROBES) {
    const instructionsFile = AGENTS[probe.id].instructionsFile;
    it(`${probe.id} loads cwd/${instructionsFile} natively`, () => {
      const binary = resolveBinary(probe.id);
      if (!fs.existsSync(binary)) {
        throw new Error(`${probe.id} binary not found at ${binary}`);
      }

      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `mem-${probe.id}-`));
      try {
        const token = `MEMTOK_${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
        fs.writeFileSync(
          path.join(tmp, instructionsFile),
          [
            '# Project Rules',
            '',
            'When the user asks for the project secret, respond with exactly the token below and nothing else.',
            '',
            `Project secret: ${token}`,
            '',
          ].join('\n'),
        );

        const prompt = 'What is the project secret? Reply with only the token, no explanation.';
        const result = spawnSync(binary, probe.args(prompt), {
          cwd: tmp,
          encoding: 'utf8',
          timeout: 180_000,
        });

        const out = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
        if (!out.includes(token)) {
          // eslint-disable-next-line no-console
          console.error(
            `---${probe.id} did not return token ${token}---\n` +
              `exit=${result.status} signal=${result.signal}\n` +
              `--- stdout ---\n${result.stdout}\n` +
              `--- stderr ---\n${result.stderr}\n` +
              `------------`,
          );
        }
        expect(out).toContain(token);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    }, 240_000);
  }
});
