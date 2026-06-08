import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Set HOME before db.js loads so its module-level base dir picks up the
// override. Plain top-level statements run before the dynamic `await import`
// below, so vi.hoisted is not needed (and is also not supported by Bun's
// native test runner).
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-db-test-'));
process.env.HOME = TEST_HOME;

const { getDB, getDBPath, querySessions, closeDB } = await import('../db.js');

// JSONL files live under TEST_HOME so they're isolated and torn down with it.
// querySessions filters out rows whose file_path no longer exists on disk
// (defense against phantom rows after a config-symlink swap, see #136), so
// every seeded row needs a real backing file.
const SEED_FILES_DIR = path.join(TEST_HOME, 'seed-files');
fs.mkdirSync(SEED_FILES_DIR, { recursive: true });

function seed(id: string, version: string | null, timestamp: string): void {
  const filePath = path.join(SEED_FILES_DIR, `${id}.jsonl`);
  fs.writeFileSync(filePath, '');
  const db = getDB();
  db.prepare(`
    INSERT INTO sessions (
      id, short_id, agent, version, timestamp, project, cwd,
      file_path, file_mtime_ms, file_size, scanned_at, is_team_origin
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
  `).run(
    id,
    id.slice(0, 8),
    'claude',
    version,
    timestamp,
    'agents-cli',
    SEED_FILES_DIR,
    filePath,
    0,
    0,
    0,
  );
}

describe('querySessions version filter', () => {
  beforeAll(() => {
    seed('s1-older', '2.1.111', '2026-04-19T10:00:00.000Z');
    seed('s2-newer', '2.1.112', '2026-04-19T11:00:00.000Z');
    seed('s3-same',  '2.1.112', '2026-04-19T12:00:00.000Z');
    seed('s4-null',  null,      '2026-04-19T13:00:00.000Z');
  });

  afterAll(() => {
    closeDB();
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
  });

  it('returns only sessions matching the requested version', () => {
    const rows = querySessions({ version: '2.1.112' });
    expect(rows.map(r => r.id).sort()).toEqual(['s2-newer', 's3-same']);
  });

  it('stores the sessions database under ~/.agents/.history/sessions', () => {
    expect(getDBPath()).toBe(path.join(TEST_HOME, '.agents', '.history', 'sessions', 'sessions.db'));
  });

  it('returns no sessions for an unknown version', () => {
    const rows = querySessions({ version: '99.99.99' });
    expect(rows).toEqual([]);
  });

  it('returns all sessions when version is omitted', () => {
    const rows = querySessions({});
    expect(rows.map(r => r.id).sort()).toEqual(['s1-older', 's2-newer', 's3-same', 's4-null']);
  });

  it('filters by version even when agent is also set', () => {
    const rows = querySessions({ agent: 'claude', version: '2.1.111' });
    expect(rows.map(r => r.id)).toEqual(['s1-older']);
  });
});
