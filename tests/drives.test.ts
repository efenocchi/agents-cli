import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  createDrive,
  readDrive,
  readDriveFiles,
  listDrives,
  deleteDrive,
  driveExists,
  updateDriveFrontmatter,
  getDriveContent,
  getDriveForProject,
  addNote,
  isDriveLarge,
  discoverDrivesFromRepo,
  installDriveFromSource,
  driveContentMatches,
} from '../src/lib/drives.js';
import { getDrivesDir } from '../src/lib/state.js';

const PREFIX = '_test_drives_';

function cleanupTestDrives() {
  const drivesDir = getDrivesDir();
  try {
    const fs = require('fs');
    const entries = fs.readdirSync(drivesDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(PREFIX)) {
        const fullPath = join(drivesDir, entry.name);
        if (entry.isDirectory()) {
          fs.rmSync(fullPath, { recursive: true, force: true });
        } else {
          fs.unlinkSync(fullPath);
        }
      }
    }
  } catch {}
}

afterEach(() => {
  cleanupTestDrives();
});

describe('createDrive', () => {
  it('creates a markdown file with frontmatter', () => {
    const filePath = createDrive(`${PREFIX}basic`);
    expect(existsSync(filePath)).toBe(true);

    const content = readFileSync(filePath, 'utf-8');
    expect(content).toContain('---');
    expect(content).toContain(`name: ${PREFIX}basic`);
    expect(content).toContain(`# ${PREFIX}basic`);
  });

  it('includes description in frontmatter', () => {
    const filePath = createDrive(`${PREFIX}desc`, 'A test drive');
    const content = readFileSync(filePath, 'utf-8');
    expect(content).toContain('description: A test drive');
  });

  it('throws if drive already exists', () => {
    createDrive(`${PREFIX}dup`);
    expect(() => createDrive(`${PREFIX}dup`)).toThrow('already exists');
  });
});

describe('readDrive', () => {
  it('reads a drive file', () => {
    createDrive(`${PREFIX}read`);
    const drive = readDrive(`${PREFIX}read`);
    expect(drive).not.toBeNull();
    expect(drive!.name).toBe(`${PREFIX}read`);
    expect(drive!.frontmatter.name).toBe(`${PREFIX}read`);
  });

  it('returns null for nonexistent drive', () => {
    expect(readDrive(`${PREFIX}nonexistent`)).toBeNull();
  });

  it('reads a drive directory with overview.md', () => {
    const drivesDir = getDrivesDir();
    const dirPath = join(drivesDir, `${PREFIX}dir-drive`);
    mkdirSync(dirPath, { recursive: true });
    writeFileSync(
      join(dirPath, 'overview.md'),
      '---\nname: dir-drive\ndescription: A directory drive\n---\n\n# Overview\n'
    );

    const drive = readDrive(`${PREFIX}dir-drive`);
    expect(drive).not.toBeNull();
    expect(drive!.frontmatter.description).toBe('A directory drive');
  });

  it('reads first md file if no overview.md', () => {
    const drivesDir = getDrivesDir();
    const dirPath = join(drivesDir, `${PREFIX}dir-nooverview`);
    mkdirSync(dirPath, { recursive: true });
    writeFileSync(join(dirPath, 'architecture.md'), '---\nname: arch\n---\n\n# Arch\n');
    writeFileSync(join(dirPath, 'backend.md'), '---\nname: be\n---\n\n# Backend\n');

    const drive = readDrive(`${PREFIX}dir-nooverview`);
    expect(drive).not.toBeNull();
    expect(drive!.name).toBe('architecture');
  });
});

describe('readDriveFiles', () => {
  it('returns single file for file-based drive', () => {
    createDrive(`${PREFIX}files-single`);
    const files = readDriveFiles(`${PREFIX}files-single`);
    expect(files.length).toBe(1);
  });

  it('returns all files for directory drive', () => {
    const drivesDir = getDrivesDir();
    const dirPath = join(drivesDir, `${PREFIX}files-multi`);
    mkdirSync(dirPath, { recursive: true });
    writeFileSync(join(dirPath, 'a.md'), '---\nname: a\n---\n\n# A\n');
    writeFileSync(join(dirPath, 'b.md'), '---\nname: b\n---\n\n# B\n');

    const files = readDriveFiles(`${PREFIX}files-multi`);
    expect(files.length).toBe(2);
  });

  it('returns empty for nonexistent drive', () => {
    expect(readDriveFiles(`${PREFIX}nofiles`)).toEqual([]);
  });
});

describe('listDrives', () => {
  it('lists created drives', () => {
    createDrive(`${PREFIX}list-a`);
    createDrive(`${PREFIX}list-b`);
    const drives = listDrives();
    const testDrives = drives.filter((d) => d.name.startsWith(PREFIX + 'list-'));
    expect(testDrives.length).toBe(2);
    const names = testDrives.map((d) => d.name).sort();
    expect(names).toEqual([`${PREFIX}list-a`, `${PREFIX}list-b`]);
  });

  it('includes directory drives', () => {
    const drivesDir = getDrivesDir();
    const dirPath = join(drivesDir, `${PREFIX}list-dir`);
    mkdirSync(dirPath, { recursive: true });
    writeFileSync(
      join(dirPath, 'overview.md'),
      '---\nname: list-dir\ndescription: dir drive\n---\n\n# Dir\n'
    );

    const drives = listDrives();
    const found = drives.find((d) => d.name === `${PREFIX}list-dir`);
    expect(found).toBeDefined();
  });
});

describe('deleteDrive', () => {
  it('deletes a file drive', () => {
    createDrive(`${PREFIX}del-file`);
    expect(deleteDrive(`${PREFIX}del-file`)).toBe(true);
    expect(driveExists(`${PREFIX}del-file`)).toBe(false);
  });

  it('deletes a directory drive', () => {
    const drivesDir = getDrivesDir();
    const dirPath = join(drivesDir, `${PREFIX}del-dir`);
    mkdirSync(dirPath, { recursive: true });
    writeFileSync(join(dirPath, 'overview.md'), '# test\n');

    expect(deleteDrive(`${PREFIX}del-dir`)).toBe(true);
    expect(driveExists(`${PREFIX}del-dir`)).toBe(false);
  });

  it('returns false for nonexistent drive', () => {
    expect(deleteDrive(`${PREFIX}nope`)).toBe(false);
  });
});

describe('driveExists', () => {
  it('returns true for existing file drive', () => {
    createDrive(`${PREFIX}exists-file`);
    expect(driveExists(`${PREFIX}exists-file`)).toBe(true);
  });

  it('returns true for existing directory drive', () => {
    const drivesDir = getDrivesDir();
    mkdirSync(join(drivesDir, `${PREFIX}exists-dir`), { recursive: true });
    expect(driveExists(`${PREFIX}exists-dir`)).toBe(true);
  });

  it('returns false for nonexistent drive', () => {
    expect(driveExists(`${PREFIX}nope-exists`)).toBe(false);
  });
});

describe('updateDriveFrontmatter', () => {
  it('updates description', () => {
    createDrive(`${PREFIX}update-fm`);
    updateDriveFrontmatter(`${PREFIX}update-fm`, { description: 'updated desc' });
    const drive = readDrive(`${PREFIX}update-fm`);
    expect(drive!.frontmatter.description).toBe('updated desc');
  });

  it('updates project path', () => {
    createDrive(`${PREFIX}update-proj`);
    updateDriveFrontmatter(`${PREFIX}update-proj`, { project: '/tmp/my-project' });
    const drive = readDrive(`${PREFIX}update-proj`);
    expect(drive!.frontmatter.project).toBe('/tmp/my-project');
  });

  it('preserves existing content', () => {
    createDrive(`${PREFIX}update-content`);
    updateDriveFrontmatter(`${PREFIX}update-content`, { description: 'new' });
    const drive = readDrive(`${PREFIX}update-content`);
    expect(drive!.content).toContain(`# ${PREFIX}update-content`);
  });

  it('throws for nonexistent drive', () => {
    expect(() => updateDriveFrontmatter(`${PREFIX}nope`, { description: 'x' })).toThrow('not found');
  });
});

describe('getDriveContent', () => {
  it('returns content for file drive', () => {
    createDrive(`${PREFIX}content`);
    const content = getDriveContent(`${PREFIX}content`);
    expect(content).not.toBeNull();
    expect(content).toContain(`# ${PREFIX}content`);
  });

  it('returns null for nonexistent drive', () => {
    expect(getDriveContent(`${PREFIX}nope-content`)).toBeNull();
  });

  it('concatenates content for directory drive', () => {
    const drivesDir = getDrivesDir();
    const dirPath = join(drivesDir, `${PREFIX}content-multi`);
    mkdirSync(dirPath, { recursive: true });
    writeFileSync(join(dirPath, 'a.md'), '---\nname: a\n---\n\nAlpha content\n');
    writeFileSync(join(dirPath, 'b.md'), '---\nname: b\n---\n\nBeta content\n');

    const content = getDriveContent(`${PREFIX}content-multi`);
    expect(content).toContain('Alpha content');
    expect(content).toContain('Beta content');
  });
});

describe('getDriveForProject', () => {
  it('finds drive by project path', () => {
    createDrive(`${PREFIX}project-match`);
    updateDriveFrontmatter(`${PREFIX}project-match`, { project: '/tmp/test-project-match' });

    const found = getDriveForProject('/tmp/test-project-match');
    expect(found).not.toBeNull();
    expect(found!.name).toBe(`${PREFIX}project-match`);
  });

  it('returns null when no drive matches', () => {
    expect(getDriveForProject('/tmp/no-match-anywhere')).toBeNull();
  });

  it('resolves tilde paths', () => {
    createDrive(`${PREFIX}project-tilde`);
    const home = process.env.HOME || '';
    updateDriveFrontmatter(`${PREFIX}project-tilde`, { project: '~/test-tilde-project' });

    const found = getDriveForProject(join(home, 'test-tilde-project'));
    expect(found).not.toBeNull();
    expect(found!.name).toBe(`${PREFIX}project-tilde`);
  });
});

describe('addNote', () => {
  it('creates a note file in the notes directory', () => {
    const drivesDir = getDrivesDir();
    const dirPath = join(drivesDir, `${PREFIX}notes-drive`);
    mkdirSync(dirPath, { recursive: true });
    writeFileSync(join(dirPath, 'overview.md'), '---\nname: notes-drive\n---\n\n# Drive\n');

    const notePath = addNote(`${PREFIX}notes-drive`, 'Test Note', 'Some content here');
    expect(existsSync(notePath)).toBe(true);

    const content = readFileSync(notePath, 'utf-8');
    expect(content).toContain('title: Test Note');
    expect(content).toContain('Some content here');
  });

  it('converts file drive to directory drive when adding note', () => {
    createDrive(`${PREFIX}notes-file`);
    const drivesDir = getDrivesDir();

    expect(existsSync(join(drivesDir, `${PREFIX}notes-file.md`))).toBe(true);

    const notePath = addNote(`${PREFIX}notes-file`, 'My Note', 'note content');
    expect(existsSync(notePath)).toBe(true);

    expect(existsSync(join(drivesDir, `${PREFIX}notes-file.md`))).toBe(false);
    expect(existsSync(join(drivesDir, `${PREFIX}notes-file`, 'overview.md'))).toBe(true);
    expect(existsSync(join(drivesDir, `${PREFIX}notes-file`, 'notes'))).toBe(true);

    const drive = readDrive(`${PREFIX}notes-file`);
    expect(drive).not.toBeNull();
    expect(drive!.content).toContain(`# ${PREFIX}notes-file`);
  });

  it('throws for nonexistent drive', () => {
    expect(() => addNote(`${PREFIX}nope-notes`, 'title', 'content')).toThrow('not found');
  });

  it('slugifies the title in filename', () => {
    const drivesDir = getDrivesDir();
    const dirPath = join(drivesDir, `${PREFIX}notes-slug`);
    mkdirSync(dirPath, { recursive: true });
    writeFileSync(join(dirPath, 'overview.md'), '# Drive\n');

    const notePath = addNote(`${PREFIX}notes-slug`, 'My Cool Note!', 'content');
    expect(notePath).toContain('my-cool-note');
  });
});

describe('isDriveLarge', () => {
  it('returns false for small file drive', () => {
    createDrive(`${PREFIX}small`);
    expect(isDriveLarge(`${PREFIX}small`)).toBe(false);
  });

  it('returns false for nonexistent drive', () => {
    expect(isDriveLarge(`${PREFIX}nope-large`)).toBe(false);
  });
});

describe('discoverDrivesFromRepo', () => {
  const repoDir = join(tmpdir(), 'agents-cli-discover-drives-test');

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  it('discovers markdown files in drives/ directory', () => {
    const drivesDir = join(repoDir, 'drives');
    mkdirSync(drivesDir, { recursive: true });
    writeFileSync(join(drivesDir, 'my-project.md'), '# Project\n');
    writeFileSync(join(drivesDir, 'other.md'), '# Other\n');

    const discovered = discoverDrivesFromRepo(repoDir);
    const names = discovered.map((d) => d.name).sort();
    expect(names).toEqual(['my-project', 'other']);
  });

  it('discovers directory drives', () => {
    const drivesDir = join(repoDir, 'drives');
    const subDir = join(drivesDir, 'big-project');
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(subDir, 'overview.md'), '# Big Project\n');

    const discovered = discoverDrivesFromRepo(repoDir);
    expect(discovered.length).toBe(1);
    expect(discovered[0].name).toBe('big-project');
  });

  it('returns empty array for repo without drives/', () => {
    mkdirSync(repoDir, { recursive: true });
    expect(discoverDrivesFromRepo(repoDir)).toEqual([]);
  });
});

describe('installDriveFromSource', () => {
  const sourceDir = join(tmpdir(), 'agents-cli-drive-source-test');

  afterEach(() => {
    rmSync(sourceDir, { recursive: true, force: true });
  });

  it('copies a file drive', () => {
    mkdirSync(sourceDir, { recursive: true });
    const srcFile = join(sourceDir, 'test.md');
    writeFileSync(srcFile, '---\nname: test\n---\n\n# Test\n');

    const result = installDriveFromSource(srcFile, `${PREFIX}install-file`);
    expect(result.success).toBe(true);
    expect(driveExists(`${PREFIX}install-file`)).toBe(true);
  });

  it('copies a directory drive', () => {
    const srcDir = join(sourceDir, 'multi');
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(srcDir, 'a.md'), '# A\n');
    writeFileSync(join(srcDir, 'b.md'), '# B\n');

    const result = installDriveFromSource(srcDir, `${PREFIX}install-dir`);
    expect(result.success).toBe(true);
    expect(driveExists(`${PREFIX}install-dir`)).toBe(true);
  });
});

describe('driveContentMatches', () => {
  const sourceDir = join(tmpdir(), 'agents-cli-drive-match-test');

  afterEach(() => {
    rmSync(sourceDir, { recursive: true, force: true });
  });

  it('returns true when content matches', () => {
    mkdirSync(sourceDir, { recursive: true });
    const content = '---\nname: match\n---\n\n# Match\n';
    const srcFile = join(sourceDir, 'match.md');
    writeFileSync(srcFile, content);

    installDriveFromSource(srcFile, `${PREFIX}match`);
    expect(driveContentMatches(`${PREFIX}match`, srcFile)).toBe(true);
  });

  it('returns false when content differs', () => {
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, 'v1.md'), '# V1\n');
    installDriveFromSource(join(sourceDir, 'v1.md'), `${PREFIX}diff`);

    writeFileSync(join(sourceDir, 'v1.md'), '# V2 updated\n');
    expect(driveContentMatches(`${PREFIX}diff`, join(sourceDir, 'v1.md'))).toBe(false);
  });

  it('returns false for nonexistent drive', () => {
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, 'nope.md'), '# Nope\n');
    expect(driveContentMatches(`${PREFIX}nope-match`, join(sourceDir, 'nope.md'))).toBe(false);
  });
});
