import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import {
  handleGetContext,
  handleGetSection,
  handleAddNote,
} from '../src/lib/drive-server.js';
import {
  createDrive,
  updateDriveFrontmatter,
  driveExists,
} from '../src/lib/drives.js';
import { getDrivesDir } from '../src/lib/state.js';

const PREFIX = '_test_drvsrv_';

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

describe('handleGetContext', () => {
  it('returns drive content by name', () => {
    createDrive(`${PREFIX}ctx-name`, 'test drive');
    const result = handleGetContext(`${PREFIX}ctx-name`);
    expect(result.drive).toBe(`${PREFIX}ctx-name`);
    expect(result.content).toContain(`# ${PREFIX}ctx-name`);
    expect(result.large).toBe(false);
  });

  it('returns drive content by project path', () => {
    createDrive(`${PREFIX}ctx-proj`);
    updateDriveFrontmatter(`${PREFIX}ctx-proj`, { project: '/tmp/test-ctx-proj-unique' });

    const result = handleGetContext('/tmp/test-ctx-proj-unique');
    expect(result.drive).toBe(`${PREFIX}ctx-proj`);
    expect(result.content).toContain(`# ${PREFIX}ctx-proj`);
  });

  it('lists available drives when no match found', () => {
    createDrive(`${PREFIX}ctx-list`);
    const result = handleGetContext('/tmp/no-match-xyz');
    expect(result.content).toContain('Available drives');
    expect(result.content).toContain(`${PREFIX}ctx-list`);
  });

  it('returns message when no drives exist', () => {
    const result = handleGetContext('/tmp/no-drives-anywhere-xyz');
    if (result.drive === '') {
      expect(result.content).toMatch(/No (drives configured|matching drive)/);
    }
  });

  it('includes frontmatter in output', () => {
    createDrive(`${PREFIX}ctx-fm`, 'A description');
    const result = handleGetContext(`${PREFIX}ctx-fm`);
    expect(result.content).toContain('description: A description');
  });
});

describe('handleGetSection', () => {
  it('extracts a section from a directory drive', () => {
    const drivesDir = getDrivesDir();
    const dirPath = join(drivesDir, `${PREFIX}sec-drive`);
    mkdirSync(dirPath, { recursive: true });
    writeFileSync(
      join(dirPath, 'architecture.md'),
      '---\nname: arch\n---\n\n# Architecture\n\n## Backend\n\nNode.js + Express\n\n## Frontend\n\nReact + Tailwind\n'
    );

    const result = handleGetSection(`${PREFIX}sec-drive`, 'architecture.md', 'Backend');
    expect(result).toContain('Backend');
    expect(result).toContain('Node.js + Express');
    expect(result).not.toContain('React + Tailwind');
  });

  it('returns error for nonexistent drive', () => {
    const result = handleGetSection(`${PREFIX}nope`, 'file.md', 'Section');
    expect(result).toContain('not found');
  });

  it('returns error for nonexistent file', () => {
    const drivesDir = getDrivesDir();
    const dirPath = join(drivesDir, `${PREFIX}sec-nofile`);
    mkdirSync(dirPath, { recursive: true });
    writeFileSync(join(dirPath, 'a.md'), '# A\n');

    const result = handleGetSection(`${PREFIX}sec-nofile`, 'nonexistent.md', 'Section');
    expect(result).toMatch(/not found|error/i);
  });

  it('returns error for nonexistent section', () => {
    const drivesDir = getDrivesDir();
    const dirPath = join(drivesDir, `${PREFIX}sec-nosec`);
    mkdirSync(dirPath, { recursive: true });
    writeFileSync(join(dirPath, 'doc.md'), '---\nname: doc\n---\n\n# Doc\n\n## Intro\n\nHello\n');

    const result = handleGetSection(`${PREFIX}sec-nosec`, 'doc.md', 'NonExistent');
    expect(result).toContain('not found');
  });

  it('extracts last section (no next heading)', () => {
    const drivesDir = getDrivesDir();
    const dirPath = join(drivesDir, `${PREFIX}sec-last`);
    mkdirSync(dirPath, { recursive: true });
    writeFileSync(
      join(dirPath, 'doc.md'),
      '---\nname: doc\n---\n\n## First\n\nFirst content\n\n## Last\n\nLast content\n'
    );

    const result = handleGetSection(`${PREFIX}sec-last`, 'doc.md', 'Last');
    expect(result).toContain('Last content');
  });
});

describe('handleAddNote', () => {
  it('adds a note to an existing drive', () => {
    const drivesDir = getDrivesDir();
    const dirPath = join(drivesDir, `${PREFIX}note-add`);
    mkdirSync(dirPath, { recursive: true });
    writeFileSync(join(dirPath, 'overview.md'), '# Drive\n');

    const result = handleAddNote(`${PREFIX}note-add`, 'My Note', 'Some observation');
    expect(result).toContain('Note saved');
  });

  it('returns error for nonexistent drive', () => {
    const result = handleAddNote(`${PREFIX}nope-note`, 'Title', 'Content');
    expect(result).toContain('Error');
    expect(result).toContain('not found');
  });
});
