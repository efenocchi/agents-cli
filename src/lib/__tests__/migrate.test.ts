import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Test the runMigration logic directly using temp dirs.
// We replicate the migration logic rather than importing it to avoid touching
// real home dirs.

let tmpDir: string;
let systemDir: string;
let userDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-test-'));
  systemDir = path.join(tmpDir, '.agents-system');
  userDir = path.join(tmpDir, '.agents');
  fs.mkdirSync(systemDir, { recursive: true });
  fs.mkdirSync(userDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function runMigrations(systemDir: string, userDir: string): void {
  // 1. Move agents.yaml from system to user repo
  const src = path.join(systemDir, 'agents.yaml');
  const dest = path.join(userDir, 'agents.yaml');
  if (fs.existsSync(src) && !fs.existsSync(dest)) {
    try { fs.renameSync(src, dest); } catch { /* best-effort */ }
  }

  // 2. Delete dead prompts.json
  const promptsJson = path.join(systemDir, 'prompts.json');
  if (fs.existsSync(promptsJson)) {
    try { fs.unlinkSync(promptsJson); } catch { /* best-effort */ }
  }

  // 3. Move legacy config.json to teams/config.json in user dir
  const configSrc = path.join(systemDir, 'config.json');
  const configDest = path.join(userDir, 'teams', 'config.json');
  if (fs.existsSync(configSrc) && !fs.existsSync(configDest)) {
    try {
      fs.mkdirSync(path.dirname(configDest), { recursive: true });
      fs.copyFileSync(configSrc, configDest);
      fs.unlinkSync(configSrc);
    } catch { /* best-effort */ }
  }
}

describe('migration: agents.yaml', () => {
  it('moves agents.yaml from system to user repo', () => {
    fs.writeFileSync(path.join(systemDir, 'agents.yaml'), 'agents:\n  claude: "1.0.0"\n');
    runMigrations(systemDir, userDir);
    expect(fs.existsSync(path.join(userDir, 'agents.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(systemDir, 'agents.yaml'))).toBe(false);
    expect(fs.readFileSync(path.join(userDir, 'agents.yaml'), 'utf-8')).toContain('claude');
  });

  it('is idempotent when user file already exists', () => {
    fs.writeFileSync(path.join(systemDir, 'agents.yaml'), 'system content');
    fs.writeFileSync(path.join(userDir, 'agents.yaml'), 'user content');
    runMigrations(systemDir, userDir);
    // User file should be unchanged; system file stays (no rename since user file exists)
    expect(fs.readFileSync(path.join(userDir, 'agents.yaml'), 'utf-8')).toBe('user content');
  });

  it('no-ops when system file absent', () => {
    runMigrations(systemDir, userDir);
    expect(fs.existsSync(path.join(userDir, 'agents.yaml'))).toBe(false);
  });
});

describe('migration: prompts.json', () => {
  it('deletes prompts.json from system dir', () => {
    fs.writeFileSync(path.join(systemDir, 'prompts.json'), '{}');
    runMigrations(systemDir, userDir);
    expect(fs.existsSync(path.join(systemDir, 'prompts.json'))).toBe(false);
  });

  it('no-ops when prompts.json absent', () => {
    expect(() => runMigrations(systemDir, userDir)).not.toThrow();
  });
});

describe('migration: config.json', () => {
  it('moves config.json to user/teams/config.json', () => {
    fs.writeFileSync(path.join(systemDir, 'config.json'), '{"version":1}');
    runMigrations(systemDir, userDir);
    expect(fs.existsSync(path.join(userDir, 'teams', 'config.json'))).toBe(true);
    expect(fs.existsSync(path.join(systemDir, 'config.json'))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(userDir, 'teams', 'config.json'), 'utf-8'))).toEqual({ version: 1 });
  });

  it('does not overwrite existing teams/config.json', () => {
    fs.writeFileSync(path.join(systemDir, 'config.json'), '{"new":true}');
    fs.mkdirSync(path.join(userDir, 'teams'), { recursive: true });
    fs.writeFileSync(path.join(userDir, 'teams', 'config.json'), '{"existing":true}');
    runMigrations(systemDir, userDir);
    const content = JSON.parse(fs.readFileSync(path.join(userDir, 'teams', 'config.json'), 'utf-8'));
    expect(content).toEqual({ existing: true });
  });

  it('is idempotent when run twice', () => {
    fs.writeFileSync(path.join(systemDir, 'config.json'), '{"v":1}');
    runMigrations(systemDir, userDir);
    // Second run: config.json already moved, system file gone
    runMigrations(systemDir, userDir);
    expect(fs.existsSync(path.join(userDir, 'teams', 'config.json'))).toBe(true);
  });
});
