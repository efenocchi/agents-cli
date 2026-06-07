import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { spawnSync } from 'child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { AGENTS } from './agents.js';
import type { CapabilityName } from './types.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-agents-'));
  tempDirs.push(dir);
  return dir;
}

function shSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function writeArgLogger(dir: string): { binary: string; logPath: string } {
  const binary = path.join(dir, 'fake-agent');
  const logPath = path.join(dir, 'argv.log');
  fs.writeFileSync(
    binary,
    [
      '#!/bin/sh',
      `LOG_FILE=${shSingleQuote(logPath)}`,
      'printf "HOME:%s\\n" "$HOME" >> "$LOG_FILE"',
      'for arg do',
      '  printf "ARG:%s\\n" "$arg" >> "$LOG_FILE"',
      'done',
      '',
    ].join('\n'),
    'utf-8'
  );
  fs.chmodSync(binary, 0o755);
  return { binary, logPath };
}

function runAgentsModule(expression: string): unknown {
  const moduleUrl = pathToFileURL(path.resolve('dist/lib/agents.js')).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { registerMcp, unregisterMcp } from ${JSON.stringify(moduleUrl)};
    const result = await ${expression};
    console.log(JSON.stringify(result));
  `], {
    env: { ...process.env },
    encoding: 'utf-8',
  });

  expect(child.status, child.stderr).toBe(0);
  return JSON.parse(child.stdout.trim());
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('MCP CLI execution', () => {
  it('registers MCP servers with argv, not a shell command string', async () => {
    const dir = makeTempDir();
    const { binary, logPath } = writeArgLogger(dir);
    const pwnedPath = path.join(dir, 'pwned');

    const result = runAgentsModule(
      `registerMcp('codex', ${JSON.stringify(`demo; touch ${pwnedPath}`)}, ${JSON.stringify(`/bin/echo; touch ${pwnedPath}`)}, 'user', 'stdio', { binary: ${JSON.stringify(binary)}, home: ${JSON.stringify(dir)} })`
    ) as { success: boolean };

    const log = fs.readFileSync(logPath, 'utf-8');
    expect(result.success).toBe(true);
    expect(fs.existsSync(pwnedPath)).toBe(false);
    expect(log).toContain(`HOME:${dir}`);
    expect(log).toContain('ARG:mcp\nARG:add');
    expect(log).toContain(`ARG:demo; touch ${pwnedPath}`);
    expect(log).toContain('ARG:/bin/echo;');
    expect(log).toContain('ARG:touch');
    expect(log).toContain(`ARG:${pwnedPath}`);
  });

  it('removes MCP servers with argv, not a shell command string', async () => {
    const dir = makeTempDir();
    const { binary, logPath } = writeArgLogger(dir);
    const pwnedPath = path.join(dir, 'pwned');

    const result = runAgentsModule(
      `unregisterMcp('codex', ${JSON.stringify(`demo"; touch ${pwnedPath}`)}, { binary: ${JSON.stringify(binary)}, home: ${JSON.stringify(dir)} })`
    ) as { success: boolean };

    const log = fs.readFileSync(logPath, 'utf-8');
    expect(result.success).toBe(true);
    expect(fs.existsSync(pwnedPath)).toBe(false);
    expect(log).toContain('ARG:mcp\nARG:remove');
    expect(log).toContain(`ARG:demo"; touch ${pwnedPath}`);
  });

  it('preserves quoted MCP command arguments without invoking a shell', async () => {
    const dir = makeTempDir();
    const { binary, logPath } = writeArgLogger(dir);

    const result = runAgentsModule(
      `registerMcp('claude', 'demo', 'node -e "console.log(1)"', 'project', 'stdio', { binary: ${JSON.stringify(binary)}, home: ${JSON.stringify(dir)} })`
    ) as { success: boolean };

    const log = fs.readFileSync(logPath, 'utf-8');
    expect(result.success).toBe(true);
    expect(log).toContain('ARG:--transport\nARG:stdio\nARG:--scope\nARG:project');
    expect(log).toContain('ARG:node');
    expect(log).toContain('ARG:-e');
    expect(log).toContain('ARG:console.log(1)');
  });

  it('registers Claude HTTP MCP servers with native transport args and headers', async () => {
    const dir = makeTempDir();
    const { binary, logPath } = writeArgLogger(dir);

    const result = runAgentsModule(
      `registerMcp('claude', 'docs', 'https://developers.openai.com/mcp', 'user', 'http', { binary: ${JSON.stringify(binary)}, home: ${JSON.stringify(dir)}, headers: { Authorization: 'Bearer token' } })`
    ) as { success: boolean };

    const log = fs.readFileSync(logPath, 'utf-8');
    expect(result.success).toBe(true);
    expect(log).toContain('ARG:--transport\nARG:http\nARG:--scope\nARG:user');
    expect(log).toContain('ARG:docs\nARG:https://developers.openai.com/mcp');
    expect(log).toContain('ARG:--header\nARG:Authorization: Bearer token');
    expect(log).not.toContain('ARG:--\n');
  });

  it('registers Codex HTTP MCP servers with --url', async () => {
    const dir = makeTempDir();
    const { binary, logPath } = writeArgLogger(dir);

    const result = runAgentsModule(
      `registerMcp('codex', 'docs', 'https://developers.openai.com/mcp', 'user', 'http', { binary: ${JSON.stringify(binary)}, home: ${JSON.stringify(dir)} })`
    ) as { success: boolean };

    const log = fs.readFileSync(logPath, 'utf-8');
    expect(result.success).toBe(true);
    expect(log).toContain('ARG:mcp\nARG:add\nARG:docs\nARG:--url\nARG:https://developers.openai.com/mcp');
    expect(log).not.toContain('ARG:--\n');
  });

  it('registers Gemini HTTP MCP servers with native transport args', async () => {
    const dir = makeTempDir();
    const { binary, logPath } = writeArgLogger(dir);

    const result = runAgentsModule(
      `registerMcp('gemini', 'docs', 'https://developers.openai.com/mcp', 'project', 'http', { binary: ${JSON.stringify(binary)}, home: ${JSON.stringify(dir)} })`
    ) as { success: boolean };

    const log = fs.readFileSync(logPath, 'utf-8');
    expect(result.success).toBe(true);
    expect(log).toContain('ARG:--transport\nARG:http\nARG:--scope\nARG:project');
    expect(log).toContain('ARG:docs\nARG:https://developers.openai.com/mcp');
    expect(log).not.toContain('ARG:--\n');
  });

  it('skips HTTP MCP registration for agents without native HTTP support', async () => {
    const dir = makeTempDir();
    const { binary } = writeArgLogger(dir);

    const result = runAgentsModule(
      `registerMcp('cursor', 'docs', 'https://developers.openai.com/mcp', 'user', 'http', { binary: ${JSON.stringify(binary)}, home: ${JSON.stringify(dir)} })`
    ) as { success: boolean; error?: string };

    expect(result.success).toBe(false);
    expect(result.error).toBe('skipped: agent does not support HTTP MCP registration');
  });
});

describe('AGENTS capability matrix', () => {
  it('declares every gateable resource capability for every agent', () => {
    const requiredCapabilities: CapabilityName[] = [
      'hooks',
      'mcp',
      'allowlist',
      'skills',
      'commands',
      'plugins',
      'subagents',
      'rules',
      'workflows',
    ];

    for (const [agentId, config] of Object.entries(AGENTS)) {
      for (const capability of requiredCapabilities) {
        expect(config.capabilities, `${agentId} missing ${capability}`).toHaveProperty(capability);
      }
    }
  });
});
