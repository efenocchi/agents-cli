import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let testHome: string;
let systemDir: string;
let userDir: string;

beforeEach(() => {
  testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-test-'));
  systemDir = path.join(testHome, '.agents-system');
  userDir = path.join(testHome, '.agents');
  fs.mkdirSync(systemDir, { recursive: true });
  fs.mkdirSync(userDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(testHome, { recursive: true, force: true });
});

function runRealMigration(): void {
  const modulePath = path.resolve(process.cwd(), 'src/lib/migrate.ts');
  execFileSync(
    'bun',
    ['-e', `import { runMigration } from ${JSON.stringify(modulePath)}; runMigration();`],
    {
      cwd: process.cwd(),
      env: { ...process.env, HOME: testHome },
      stdio: 'pipe',
    },
  );
}

describe('runMigration', () => {
  it('moves legacy files into the user repo and deletes dead files', () => {
    fs.writeFileSync(path.join(systemDir, 'agents.yaml'), 'agents:\n  claude: "1.0.0"\n');
    fs.writeFileSync(path.join(systemDir, 'prompts.json'), '{}');
    fs.writeFileSync(path.join(systemDir, 'config.json'), '{"version":1}');
    fs.writeFileSync(path.join(systemDir, 'promptcuts.yaml'), 'system: true\n');
    fs.writeFileSync(path.join(userDir, 'promptcuts.yaml'), 'user: true\n');

    runRealMigration();

    expect(fs.readFileSync(path.join(userDir, 'agents.yaml'), 'utf-8')).toContain('claude');
    expect(fs.existsSync(path.join(systemDir, 'agents.yaml'))).toBe(false);
    expect(fs.existsSync(path.join(systemDir, 'prompts.json'))).toBe(false);
    expect(fs.readFileSync(path.join(userDir, 'teams', 'config.json'), 'utf-8')).toBe('{"version":1}');
    expect(fs.existsSync(path.join(systemDir, 'config.json'))).toBe(false);
    expect(fs.readFileSync(path.join(systemDir, 'hooks', 'promptcuts.yaml'), 'utf-8')).toBe('system: true\n');
    expect(fs.readFileSync(path.join(userDir, 'hooks', 'promptcuts.yaml'), 'utf-8')).toBe('user: true\n');
    expect(fs.existsSync(path.join(systemDir, 'promptcuts.yaml'))).toBe(false);
    expect(fs.existsSync(path.join(userDir, 'promptcuts.yaml'))).toBe(false);
  });

  it('is idempotent and preserves existing destination files', () => {
    fs.writeFileSync(path.join(systemDir, 'agents.yaml'), 'system agents');
    fs.writeFileSync(path.join(systemDir, 'config.json'), '{"new":true}');
    fs.mkdirSync(path.join(userDir, 'teams'), { recursive: true });
    fs.writeFileSync(path.join(userDir, 'agents.yaml'), 'user agents');
    fs.writeFileSync(path.join(userDir, 'teams', 'config.json'), '{"existing":true}');

    runRealMigration();
    runRealMigration();

    expect(fs.readFileSync(path.join(userDir, 'agents.yaml'), 'utf-8')).toBe('user agents');
    expect(fs.readFileSync(path.join(userDir, 'teams', 'config.json'), 'utf-8')).toBe('{"existing":true}');
    expect(fs.readFileSync(path.join(systemDir, 'agents.yaml'), 'utf-8')).toBe('system agents');
    expect(fs.readFileSync(path.join(systemDir, 'config.json'), 'utf-8')).toBe('{"new":true}');
  });

  it('moves ~/.agents-system/versions/<agent>/<ver>/ into ~/.agents/versions/ and merges overlap', () => {
    // System-side version with no user-side equivalent: must move outright.
    const orphanSys = path.join(systemDir, 'versions', 'claude', '2.0.99', 'home', '.claude');
    fs.mkdirSync(orphanSys, { recursive: true });
    fs.writeFileSync(path.join(orphanSys, '.credentials.json'), '{"oauth":{"email":"test@example.com"}}');

    // Overlap version: both paths have a home dir. Sync-managed file (skills) lives in user;
    // operational state (history.jsonl) lives only in system. Merge step must preserve user file
    // and copy missing system files into user.
    const userOverlap = path.join(userDir, 'versions', 'claude', '2.0.50', 'home', '.claude');
    fs.mkdirSync(path.join(userOverlap, 'skills', 'mq'), { recursive: true });
    fs.writeFileSync(path.join(userOverlap, 'skills', 'mq', 'SKILL.md'), 'fresh-from-sync');
    const sysOverlap = path.join(systemDir, 'versions', 'claude', '2.0.50', 'home', '.claude');
    fs.mkdirSync(sysOverlap, { recursive: true });
    fs.writeFileSync(path.join(sysOverlap, 'history.jsonl'), 'legacy-history');
    fs.writeFileSync(path.join(sysOverlap, 'skills', 'mq', 'SKILL.md').replace('skills/mq/SKILL.md', 'skills-stale.md'), 'stale');

    // Pre-create the symlink that the migrator should re-point. Use the legacy system target.
    fs.writeFileSync(path.join(userDir, 'agents.yaml'), 'agents:\n  claude: 2.0.50\n');
    const symlinkPath = path.join(testHome, '.claude');
    fs.symlinkSync(sysOverlap, symlinkPath);

    runRealMigration();

    // Orphan system-side version moved to user.
    expect(fs.existsSync(path.join(userDir, 'versions', 'claude', '2.0.99', 'home', '.claude', '.credentials.json'))).toBe(true);
    expect(fs.existsSync(path.join(systemDir, 'versions', 'claude', '2.0.99'))).toBe(false);

    // Overlap merged into user: fresh skill preserved, history copied in.
    expect(fs.readFileSync(path.join(userOverlap, 'skills', 'mq', 'SKILL.md'), 'utf-8')).toBe('fresh-from-sync');
    expect(fs.readFileSync(path.join(userOverlap, 'history.jsonl'), 'utf-8')).toBe('legacy-history');

    // Legacy system overlap moved into trash.
    const trashRoot = path.join(userDir, '.trash', 'versions', 'claude', '2.0.50');
    expect(fs.existsSync(trashRoot)).toBe(true);

    // Symlink re-pointed to user-side target.
    const newTarget = fs.readlinkSync(symlinkPath);
    expect(path.resolve(path.dirname(symlinkPath), newTarget)).toBe(path.resolve(userOverlap));
  });

  describe('migratePermissionSetsToPresets', () => {
    it('renames permissions/sets/ to permissions/presets/ in user dir', () => {
      const setsDir = path.join(userDir, 'permissions', 'sets');
      fs.mkdirSync(setsDir, { recursive: true });
      fs.writeFileSync(path.join(setsDir, 'sandbox.yaml'), 'name: sandbox\nincludes: [base]');

      runRealMigration();

      const presetsDir = path.join(userDir, 'permissions', 'presets');
      expect(fs.existsSync(presetsDir)).toBe(true);
      expect(fs.existsSync(setsDir)).toBe(false);
      expect(fs.readFileSync(path.join(presetsDir, 'sandbox.yaml'), 'utf-8')).toBe('name: sandbox\nincludes: [base]');
    });

    it('renames permissions/sets/ to permissions/presets/ in system dir', () => {
      const setsDir = path.join(systemDir, 'permissions', 'sets');
      fs.mkdirSync(setsDir, { recursive: true });
      fs.writeFileSync(path.join(setsDir, 'minimal.yaml'), 'name: minimal\nincludes: []');

      runRealMigration();

      const presetsDir = path.join(systemDir, 'permissions', 'presets');
      expect(fs.existsSync(presetsDir)).toBe(true);
      expect(fs.existsSync(setsDir)).toBe(false);
      expect(fs.readFileSync(path.join(presetsDir, 'minimal.yaml'), 'utf-8')).toBe('name: minimal\nincludes: []');
    });

    it('skips if presets/ already exists (idempotent)', () => {
      const setsDir = path.join(userDir, 'permissions', 'sets');
      const presetsDir = path.join(userDir, 'permissions', 'presets');
      fs.mkdirSync(setsDir, { recursive: true });
      fs.mkdirSync(presetsDir, { recursive: true });
      fs.writeFileSync(path.join(setsDir, 'old.yaml'), 'old');
      fs.writeFileSync(path.join(presetsDir, 'new.yaml'), 'new');

      runRealMigration();
      runRealMigration();

      expect(fs.existsSync(setsDir)).toBe(true);
      expect(fs.readFileSync(path.join(setsDir, 'old.yaml'), 'utf-8')).toBe('old');
      expect(fs.readFileSync(path.join(presetsDir, 'new.yaml'), 'utf-8')).toBe('new');
    });

    it('handles both user and system dirs together', () => {
      const userSets = path.join(userDir, 'permissions', 'sets');
      const sysSets = path.join(systemDir, 'permissions', 'sets');
      fs.mkdirSync(userSets, { recursive: true });
      fs.mkdirSync(sysSets, { recursive: true });
      fs.writeFileSync(path.join(userSets, 'user.yaml'), 'user preset');
      fs.writeFileSync(path.join(sysSets, 'system.yaml'), 'system preset');

      runRealMigration();

      expect(fs.existsSync(path.join(userDir, 'permissions', 'presets', 'user.yaml'))).toBe(true);
      expect(fs.existsSync(path.join(systemDir, 'permissions', 'presets', 'system.yaml'))).toBe(true);
      expect(fs.existsSync(userSets)).toBe(false);
      expect(fs.existsSync(sysSets)).toBe(false);
    });

    it('no-op when sets/ does not exist', () => {
      runRealMigration();

      expect(fs.existsSync(path.join(userDir, 'permissions', 'presets'))).toBe(false);
      expect(fs.existsSync(path.join(systemDir, 'permissions', 'presets'))).toBe(false);
    });
  });
});
