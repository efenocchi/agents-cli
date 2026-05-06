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

  it('moves ~/.agents/versions/<agent>/<ver>/ into ~/.agents-system/versions/', () => {
    // Pre-split layout: legacy versions live under the user repo.
    const legacy = path.join(userDir, 'versions', 'claude', '2.0.99', 'home', '.claude');
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, '.credentials.json'), '{"oauth":{"email":"test@example.com"}}');

    // Also a version where the system already has a same-named install — must NOT clobber it.
    const conflicting = path.join(userDir, 'versions', 'claude', '2.0.50', 'home');
    fs.mkdirSync(conflicting, { recursive: true });
    fs.writeFileSync(path.join(conflicting, 'marker-legacy'), '');
    const sysExisting = path.join(systemDir, 'versions', 'claude', '2.0.50', 'home');
    fs.mkdirSync(sysExisting, { recursive: true });
    fs.writeFileSync(path.join(sysExisting, 'marker-system'), '');

    runRealMigration();

    // Migrated.
    expect(
      fs.existsSync(path.join(systemDir, 'versions', 'claude', '2.0.99', 'home', '.claude', '.credentials.json'))
    ).toBe(true);
    expect(fs.existsSync(path.join(userDir, 'versions', 'claude', '2.0.99'))).toBe(false);

    // Conflict: legacy left in place, system copy untouched.
    expect(fs.existsSync(path.join(userDir, 'versions', 'claude', '2.0.50', 'home', 'marker-legacy'))).toBe(true);
    expect(fs.existsSync(path.join(systemDir, 'versions', 'claude', '2.0.50', 'home', 'marker-system'))).toBe(true);
    expect(fs.existsSync(path.join(systemDir, 'versions', 'claude', '2.0.50', 'home', 'marker-legacy'))).toBe(false);
  });
});
