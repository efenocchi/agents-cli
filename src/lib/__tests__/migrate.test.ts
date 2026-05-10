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

    // Post-bucket-refactor paths.
    const historyDir = path.join(userDir, '.history');
    const newUserOverlap = path.join(historyDir, 'versions', 'claude', '2.0.50', 'home', '.claude');

    // Orphan system-side version moved into the history bucket.
    expect(fs.existsSync(path.join(historyDir, 'versions', 'claude', '2.0.99', 'home', '.claude', '.credentials.json'))).toBe(true);
    expect(fs.existsSync(path.join(systemDir, 'versions', 'claude', '2.0.99'))).toBe(false);

    // Overlap merged into user (then moved into .history/): fresh skill preserved, history copied in.
    expect(fs.readFileSync(path.join(newUserOverlap, 'skills', 'mq', 'SKILL.md'), 'utf-8')).toBe('fresh-from-sync');
    expect(fs.readFileSync(path.join(newUserOverlap, 'history.jsonl'), 'utf-8')).toBe('legacy-history');

    // Legacy system overlap moved into trash, which now lives under .history/.
    const trashRoot = path.join(historyDir, 'trash', 'versions', 'claude', '2.0.50');
    expect(fs.existsSync(trashRoot)).toBe(true);

    // Symlink re-pointed to the post-bucket-refactor target.
    const newTarget = fs.readlinkSync(symlinkPath);
    expect(path.resolve(path.dirname(symlinkPath), newTarget)).toBe(path.resolve(newUserOverlap));
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

  describe('cleanup of orphan user-level files', () => {
    it('deletes ~/.agents/linear.json', () => {
      fs.writeFileSync(path.join(userDir, 'linear.json'), '{"apiKey":"lin_legacy"}');
      runRealMigration();
      expect(fs.existsSync(path.join(userDir, 'linear.json'))).toBe(false);
    });

    it('deletes ~/.agents/prompts.json', () => {
      fs.writeFileSync(path.join(userDir, 'prompts.json'), '[]');
      runRealMigration();
      expect(fs.existsSync(path.join(userDir, 'prompts.json'))).toBe(false);
    });

    it('removes empty ~/.agents/runs/ leftover dir', () => {
      fs.mkdirSync(path.join(userDir, 'runs'));
      runRealMigration();
      expect(fs.existsSync(path.join(userDir, 'runs'))).toBe(false);
    });

    it('preserves ~/.agents/runs/ if it has contents (legacy not yet migrated)', () => {
      const runsDir = path.join(userDir, 'runs');
      fs.mkdirSync(path.join(runsDir, 'old-job'), { recursive: true });
      fs.writeFileSync(path.join(runsDir, 'old-job', 'meta.json'), '{}');
      runRealMigration();
      // migrateRunsIntoRoutines moves runs/ into routines/runs/, then
      // migrateRuntimeToHistory hoists routines/runs/ into the .history/ bucket.
      expect(fs.existsSync(path.join(userDir, '.history', 'runs', 'old-job', 'meta.json'))).toBe(true);
      expect(fs.existsSync(runsDir)).toBe(false);
    });

    it('migrates ~/.agents/config.json to teams/config.json when canonical absent', () => {
      fs.writeFileSync(path.join(userDir, 'config.json'), '{"agents":{"claude":{"enabled":true}}}');
      runRealMigration();
      expect(fs.existsSync(path.join(userDir, 'config.json'))).toBe(false);
      expect(fs.readFileSync(path.join(userDir, 'teams', 'config.json'), 'utf-8'))
        .toBe('{"agents":{"claude":{"enabled":true}}}');
    });

    it('deletes ~/.agents/config.json when canonical teams/config.json exists', () => {
      fs.writeFileSync(path.join(userDir, 'config.json'), '{"legacy":true}');
      fs.mkdirSync(path.join(userDir, 'teams'), { recursive: true });
      fs.writeFileSync(path.join(userDir, 'teams', 'config.json'), '{"canonical":true}');
      runRealMigration();
      expect(fs.existsSync(path.join(userDir, 'config.json'))).toBe(false);
      expect(fs.readFileSync(path.join(userDir, 'teams', 'config.json'), 'utf-8'))
        .toBe('{"canonical":true}');
    });
  });

  describe('foldUserHooksYamlIntoAgentsYaml', () => {
    it('folds user hooks.yaml into agents.yaml hooks: section and deletes the standalone file', () => {
      fs.writeFileSync(
        path.join(userDir, 'agents.yaml'),
        'agents:\n  claude: 2.1.0\n',
      );
      fs.writeFileSync(
        path.join(userDir, 'hooks.yaml'),
        'capture-session:\n  script: capture.sh\n  events: [SessionStart]\n  timeout: 5\n',
      );

      runRealMigration();

      expect(fs.existsSync(path.join(userDir, 'hooks.yaml'))).toBe(false);
      const meta = fs.readFileSync(path.join(userDir, 'agents.yaml'), 'utf-8');
      expect(meta).toContain('hooks:');
      expect(meta).toContain('capture-session');
      expect(meta).toContain('script: capture.sh');
      expect(meta).toMatch(/agents:\s*\n\s+claude:/);
    });

    it('creates agents.yaml when only hooks.yaml exists', () => {
      fs.writeFileSync(
        path.join(userDir, 'hooks.yaml'),
        'lonely:\n  script: a.sh\n  events: [Stop]\n',
      );

      runRealMigration();

      expect(fs.existsSync(path.join(userDir, 'hooks.yaml'))).toBe(false);
      const meta = fs.readFileSync(path.join(userDir, 'agents.yaml'), 'utf-8');
      expect(meta).toContain('hooks:');
      expect(meta).toContain('lonely:');
    });

    it('preserves existing agents.yaml hooks: entries on collision (existing wins)', () => {
      fs.writeFileSync(
        path.join(userDir, 'agents.yaml'),
        'hooks:\n  shared:\n    script: existing.sh\n    events: [Stop]\n',
      );
      fs.writeFileSync(
        path.join(userDir, 'hooks.yaml'),
        'shared:\n  script: incoming.sh\n  events: [SessionStart]\n',
      );

      runRealMigration();

      const meta = fs.readFileSync(path.join(userDir, 'agents.yaml'), 'utf-8');
      expect(meta).toContain('script: existing.sh');
      expect(meta).not.toContain('incoming.sh');
    });

    it('is idempotent (no hooks.yaml = no-op)', () => {
      fs.writeFileSync(
        path.join(userDir, 'agents.yaml'),
        'agents:\n  claude: 2.1.0\n',
      );

      runRealMigration();
      runRealMigration();

      const meta = fs.readFileSync(path.join(userDir, 'agents.yaml'), 'utf-8');
      expect(meta).toContain('claude: 2.1.0');
    });
  });
});
