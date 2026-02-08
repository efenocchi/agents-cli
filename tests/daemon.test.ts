import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import {
  readDaemonPid,
  writeDaemonPid,
  removeDaemonPid,
  readDaemonLog,
  log,
  getDaemonStatus,
  generateLaunchdPlist,
  generateSystemdUnit,
} from '../src/lib/daemon.js';
import { getAgentsDir } from '../src/lib/state.js';

function cleanupDaemonFiles() {
  const agentsDir = getAgentsDir();
  for (const file of ['daemon.pid', 'daemon.log']) {
    const p = join(agentsDir, file);
    try {
      if (existsSync(p)) unlinkSync(p);
    } catch {}
  }
}

beforeEach(() => {
  cleanupDaemonFiles();
});

afterEach(() => {
  cleanupDaemonFiles();
});

describe('PID management', () => {
  it('returns null when no PID file exists', () => {
    expect(readDaemonPid()).toBeNull();
  });

  it('writes and reads PID', () => {
    writeDaemonPid(12345);
    expect(readDaemonPid()).toBe(12345);
  });

  it('removes PID file', () => {
    writeDaemonPid(12345);
    removeDaemonPid();
    expect(readDaemonPid()).toBeNull();
  });

  it('removeDaemonPid does not throw if no file exists', () => {
    expect(() => removeDaemonPid()).not.toThrow();
  });

  it('returns null for invalid PID content', () => {
    const pidPath = join(getAgentsDir(), 'daemon.pid');
    writeFileSync(pidPath, 'not-a-number', 'utf-8');
    expect(readDaemonPid()).toBeNull();
  });
});

describe('logging', () => {
  it('appends log lines to daemon.log', () => {
    log('INFO', 'test message one');
    log('ERROR', 'test message two');

    const content = readDaemonLog();
    expect(content).toContain('[INFO] test message one');
    expect(content).toContain('[ERROR] test message two');
  });

  it('readDaemonLog with line limit returns last N lines', () => {
    for (let i = 0; i < 10; i++) {
      log('INFO', `line ${i}`);
    }

    const last3 = readDaemonLog(3);
    const lines = last3.split('\n').filter((l) => l.trim());
    expect(lines.length).toBeLessThanOrEqual(3);
    expect(last3).toContain('line 9');
  });

  it('readDaemonLog returns fallback when no log exists', () => {
    expect(readDaemonLog()).toBe('(no log file)');
  });
});

describe('getDaemonStatus', () => {
  it('reports not running when no PID file', () => {
    const status = getDaemonStatus();
    expect(status.running).toBe(false);
    expect(status.pid).toBeNull();
    expect(typeof status.jobCount).toBe('number');
    expect(typeof status.logPath).toBe('string');
  });

  it('reports not running for stale PID', () => {
    writeDaemonPid(999999999);
    const status = getDaemonStatus();
    expect(status.running).toBe(false);
  });
});

describe('generateLaunchdPlist', () => {
  it('generates valid plist XML', () => {
    const plist = generateLaunchdPlist();
    expect(plist).toContain('<?xml version="1.0"');
    expect(plist).toContain('co.swarmify.agents-daemon');
    expect(plist).toContain('daemon');
    expect(plist).toContain('_run');
    expect(plist).toContain('<key>KeepAlive</key>');
    expect(plist).toContain('<true/>');
  });
});

describe('generateSystemdUnit', () => {
  it('generates valid systemd unit', () => {
    const unit = generateSystemdUnit();
    expect(unit).toContain('[Unit]');
    expect(unit).toContain('[Service]');
    expect(unit).toContain('[Install]');
    expect(unit).toContain('daemon _run');
    expect(unit).toContain('Restart=always');
  });
});
