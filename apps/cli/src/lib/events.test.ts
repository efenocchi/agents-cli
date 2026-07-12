import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  emit, emitStart, emitCommand, query, rotate, stats,
  redactPrompt, redactArgs, truncate,
  _resetForTest,
  type EventRecord,
} from './events.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-events-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ok */ }
  }
  tempDirs.length = 0;
  delete process.env.AGENTS_DISABLE_EVENT_LOG;
  _resetForTest();
});

function setupLogsDir(): string {
  const dir = makeTempDir();
  const logsDir = path.join(dir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  _resetForTest(logsDir);
  return logsDir;
}

describe('events', () => {
  describe('emit', () => {
    it('writes a JSONL record with level and caller fields', () => {
      const logsDir = setupLogsDir();
      emit('info', { module: 'test', input: 'hello' });

      const files = fs.readdirSync(logsDir).filter(f => f.endsWith('.jsonl'));
      expect(files.length).toBe(1);

      const content = fs.readFileSync(path.join(logsDir, files[0]), 'utf-8');
      const record = JSON.parse(content.trim().split('\n').pop()!);
      expect(record.event).toBe('info');
      expect(record.level).toBe('info');
      expect(record.ts).toBeDefined();
      expect(record.hostname).toBeDefined();
      expect(record.pid).toBe(process.pid);
      expect(record.osUser).toBeDefined();
      expect(['local', 'ssh']).toContain(record.transport);
    });

    it('assigns audit level to secrets events', () => {
      setupLogsDir();
      emit('secrets.get', { module: 'secrets', item: 'test-bundle' });

      const records = query({});
      const last = records[0];
      expect(last.level).toBe('audit');
      expect(last.event).toBe('secrets.get');
    });

    it('assigns warn level to warn events', () => {
      setupLogsDir();
      emit('warn', { module: 'test' });

      const records = query({});
      expect(records[0].level).toBe('warn');
    });

    it('assigns debug level to debug events', () => {
      setupLogsDir();
      emit('debug', { module: 'test' });

      const records = query({});
      expect(records[0].level).toBe('debug');
    });

    it('includes caller in the record', () => {
      setupLogsDir();
      emit('info', { module: 'test' });

      const records = query({});
      expect(records[0].caller).toBeDefined();
      expect(records[0].caller).toContain('events.test.ts');
    });

    it('respects AGENTS_DISABLE_EVENT_LOG', () => {
      const logsDir = setupLogsDir();
      process.env.AGENTS_DISABLE_EVENT_LOG = '1';
      emit('info', { module: 'test' });

      const files = fs.readdirSync(logsDir).filter(f => f.endsWith('.jsonl'));
      if (files.length > 0) {
        const content = fs.readFileSync(path.join(logsDir, files[0]), 'utf-8').trim();
        expect(content).toBe('');
      } else {
        expect(files.length).toBe(0);
      }
    });
  });

  describe('redaction', () => {
    it('redactPrompt returns length and truncated sha256', () => {
      const result = redactPrompt('my secret prompt');
      expect(result.prompt_length).toBe(16);
      expect(result.prompt_sha256).toBeDefined();
      expect(result.prompt_sha256!.length).toBe(16);
    });

    it('redactPrompt returns empty for null', () => {
      expect(redactPrompt(null)).toEqual({});
      expect(redactPrompt(undefined)).toEqual({});
    });

    it('redactArgs masks token-like values', () => {
      const result = redactArgs(['--token', 'sk_live_abc123', '--name', 'safe']);
      expect(result).toEqual(['--token', '[REDACTED]', '--name', 'safe']);
    });

    it('redactArgs masks secret paths', () => {
      const result = redactArgs(['/home/user/.env']);
      expect(result).toEqual(['[REDACTED]']);
    });

    it('redactArgs masks GitHub tokens', () => {
      expect(redactArgs(['ghp_xxxxxxxxxxxx'])).toEqual(['[REDACTED]']);
    });
  });

  describe('truncate', () => {
    it('truncates long strings with ellipsis', () => {
      const long = 'a'.repeat(600);
      const result = truncate(long, 100);
      expect(result!.length).toBe(100);
      expect(result!.endsWith('...')).toBe(true);
    });

    it('returns short strings unchanged', () => {
      expect(truncate('short', 100)).toBe('short');
    });

    it('returns undefined for null', () => {
      expect(truncate(null)).toBeUndefined();
    });
  });

  describe('query', () => {
    it('reads and filters events by event type', () => {
      setupLogsDir();
      emit('info', { module: 'test', input: 'a' });
      emit('warn', { module: 'test', input: 'b' });
      emit('info', { module: 'test', input: 'c' });

      const results = query({ eventTypes: ['info'] });
      expect(results.length).toBe(2);
      for (const r of results) expect(r.event).toBe('info');
    });

    it('filters by level', () => {
      setupLogsDir();
      emit('secrets.get', { module: 'secrets' });
      emit('info', { module: 'test' });
      emit('warn', { module: 'test' });

      const audits = query({ level: 'audit' });
      expect(audits.length).toBe(1);
      expect(audits[0].event).toBe('secrets.get');

      const warns = query({ level: 'warn' });
      expect(warns.length).toBe(1);
    });

    it('filters by module', () => {
      setupLogsDir();
      emit('info', { module: 'secrets' });
      emit('info', { module: 'teams' });

      const results = query({ module: 'secrets' });
      expect(results.length).toBe(1);
      expect(results[0].module).toBe('secrets');
    });

    it('filters by command prefix', () => {
      setupLogsDir();
      emit('command.start', { command: 'teams create', module: 'teams' });
      emit('command.start', { command: 'teams add', module: 'teams' });
      emit('command.start', { command: 'secrets get', module: 'secrets' });

      const results = query({ command: 'teams' });
      expect(results.length).toBe(2);
    });

    it('respects limit', () => {
      setupLogsDir();
      for (let i = 0; i < 10; i++) emit('info', { module: 'test', i });

      const results = query({ limit: 3 });
      expect(results.length).toBe(3);
    });

    it('reads gzipped log files', () => {
      const logsDir = setupLogsDir();
      const record = {
        ts: new Date().toISOString(),
        tz: '+00:00', tzName: 'UTC',
        hostname: 'test', platform: 'linux', arch: 'x64',
        pid: 1, ppid: 0,
        event: 'info', level: 'info',
        osUser: 'test', transport: 'local',
        module: 'gztest',
      };
      const today = new Date();
      const yyyy = today.getFullYear();
      const mm = String(today.getMonth() + 1).padStart(2, '0');
      const dd = String(today.getDate()).padStart(2, '0');
      const gzPath = path.join(logsDir, `events-${yyyy}-${mm}-${dd}.jsonl.gz`);
      fs.writeFileSync(gzPath, gzipSync(Buffer.from(JSON.stringify(record) + '\n')));

      const results = query({ module: 'gztest' });
      expect(results.length).toBe(1);
      expect(results[0].module).toBe('gztest');
    });
  });

  describe('rotation', () => {
    it('removes old log files', () => {
      const logsDir = setupLogsDir();
      const old = new Date();
      old.setDate(old.getDate() - 30);
      const yyyy = old.getFullYear();
      const mm = String(old.getMonth() + 1).padStart(2, '0');
      const dd = String(old.getDate()).padStart(2, '0');
      const oldFile = path.join(logsDir, `events-${yyyy}-${mm}-${dd}.jsonl`);
      fs.writeFileSync(oldFile, '{"event":"info"}\n');

      const now = new Date();
      const ny = now.getFullYear();
      const nm = String(now.getMonth() + 1).padStart(2, '0');
      const nd = String(now.getDate()).padStart(2, '0');
      const newFile = path.join(logsDir, `events-${ny}-${nm}-${nd}.jsonl`);
      fs.writeFileSync(newFile, '{"event":"info"}\n');

      const removed = rotate(7);
      expect(removed).toBe(1);
      expect(fs.existsSync(oldFile)).toBe(false);
      expect(fs.existsSync(newFile)).toBe(true);
    });

    it('removes old .gz files too', () => {
      const logsDir = setupLogsDir();
      const old = new Date();
      old.setDate(old.getDate() - 30);
      const yyyy = old.getFullYear();
      const mm = String(old.getMonth() + 1).padStart(2, '0');
      const dd = String(old.getDate()).padStart(2, '0');
      const gzFile = path.join(logsDir, `events-${yyyy}-${mm}-${dd}.jsonl.gz`);
      fs.writeFileSync(gzFile, gzipSync(Buffer.from('{"event":"info"}\n')));

      const removed = rotate(7);
      expect(removed).toBe(1);
      expect(fs.existsSync(gzFile)).toBe(false);
    });
  });

  describe('stats', () => {
    it('returns aggregate statistics', () => {
      setupLogsDir();
      emit('secrets.get', { module: 'secrets' });
      emit('info', { module: 'test' });
      emit('warn', { module: 'test' });

      const s = stats({ days: 1 });
      expect(s.totalEvents).toBe(3);
      expect(s.byLevel.audit).toBe(1);
      expect(s.byLevel.info).toBe(1);
      expect(s.byLevel.warn).toBe(1);
      expect(s.byEvent['secrets.get']).toBe(1);
      expect(s.byModule.secrets).toBe(1);
      expect(s.fileCount).toBe(1);
    });
  });

  describe('performance', () => {
    it('handles 10k records without excessive time', () => {
      setupLogsDir();
      const start = Date.now();
      for (let i = 0; i < 10_000; i++) {
        emit('info', { module: 'perf', i });
      }
      const writeMs = Date.now() - start;

      const qStart = Date.now();
      const results = query({ module: 'perf', limit: 10_000 });
      const readMs = Date.now() - qStart;

      expect(results.length).toBe(10_000);
      expect(writeMs).toBeLessThan(30_000);
      expect(readMs).toBeLessThan(10_000);
    });
  });

  describe('emitStart / emitCommand', () => {
    it('emitStart pairs start/end events with duration', () => {
      setupLogsDir();
      const done = emitStart('agent.run.start', { agent: 'claude' });
      done({ exitCode: 0 });

      const results = query({});
      const startRec = results.find(r => r.event === 'agent.run.start');
      const endRec = results.find(r => r.event === 'agent.run.end');
      expect(startRec).toBeDefined();
      expect(endRec).toBeDefined();
      expect(endRec!.durationMs).toBeGreaterThanOrEqual(0);
      expect(endRec!.exitCode).toBe(0);
    });

    it('emitCommand captures command name and args', () => {
      setupLogsDir();
      const done = emitCommand('run', ['claude', '-p', 'hi']);
      done({ exitCode: 0 });

      const results = query({ eventTypes: ['command.start'] });
      expect(results.length).toBe(1);
      expect(results[0].command).toBe('run');
      expect(results[0].args).toEqual(['claude', '-p', 'hi']);
    });
  });
});
