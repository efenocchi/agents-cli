import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import { getDrivesDir, ensureAgentsDir } from './state.js';

export interface DriveFrontmatter {
  name: string;
  description?: string;
  project?: string;
  repo?: string;
  updated?: string;
}

export interface DriveFile {
  name: string;
  path: string;
  frontmatter: DriveFrontmatter;
  content: string;
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

function parseDriveFile(filePath: string): DriveFile | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const name = path.basename(filePath, '.md');

    const match = raw.match(FRONTMATTER_RE);
    if (match) {
      const frontmatter = (yaml.parse(match[1]) || {}) as DriveFrontmatter;
      frontmatter.name = frontmatter.name || name;
      return { name, path: filePath, frontmatter, content: match[2] };
    }

    return { name, path: filePath, frontmatter: { name }, content: raw };
  } catch {
    return null;
  }
}

function serializeDrive(frontmatter: DriveFrontmatter, content: string): string {
  const fm: Record<string, unknown> = {};
  if (frontmatter.name) fm.name = frontmatter.name;
  if (frontmatter.description) fm.description = frontmatter.description;
  if (frontmatter.project) fm.project = frontmatter.project;
  if (frontmatter.repo) fm.repo = frontmatter.repo;
  fm.updated = new Date().toISOString();

  return `---\n${yaml.stringify(fm).trimEnd()}\n---\n${content}`;
}

export function createDrive(name: string, description?: string): string {
  ensureAgentsDir();
  const drivesDir = getDrivesDir();
  const filePath = path.join(drivesDir, `${name}.md`);
  const dirPath = path.join(drivesDir, name);

  if (fs.existsSync(filePath) || (fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory())) {
    throw new Error(`Drive '${name}' already exists`);
  }

  const frontmatter: DriveFrontmatter = { name };
  if (description) frontmatter.description = description;

  const content = `\n# ${name}\n`;
  fs.writeFileSync(filePath, serializeDrive(frontmatter, content), 'utf-8');
  return filePath;
}

export function readDrive(name: string): DriveFile | null {
  ensureAgentsDir();
  const drivesDir = getDrivesDir();

  const filePath = path.join(drivesDir, `${name}.md`);
  if (fs.existsSync(filePath)) {
    return parseDriveFile(filePath);
  }

  const dirPath = path.join(drivesDir, name);
  if (fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory()) {
    const overviewPath = path.join(dirPath, 'overview.md');
    if (fs.existsSync(overviewPath)) {
      return parseDriveFile(overviewPath);
    }
    const mdFiles = fs.readdirSync(dirPath).filter((f) => f.endsWith('.md')).sort();
    if (mdFiles.length > 0) {
      return parseDriveFile(path.join(dirPath, mdFiles[0]));
    }
  }

  return null;
}

export function readDriveFiles(name: string): DriveFile[] {
  ensureAgentsDir();
  const drivesDir = getDrivesDir();

  const filePath = path.join(drivesDir, `${name}.md`);
  if (fs.existsSync(filePath)) {
    const drive = parseDriveFile(filePath);
    return drive ? [drive] : [];
  }

  const dirPath = path.join(drivesDir, name);
  if (fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory()) {
    const files: DriveFile[] = [];
    for (const f of fs.readdirSync(dirPath).filter((f) => f.endsWith('.md')).sort()) {
      const drive = parseDriveFile(path.join(dirPath, f));
      if (drive) files.push(drive);
    }
    return files;
  }

  return [];
}

export function listDrives(): DriveFrontmatter[] {
  ensureAgentsDir();
  const drivesDir = getDrivesDir();
  if (!fs.existsSync(drivesDir)) return [];

  const entries = fs.readdirSync(drivesDir, { withFileTypes: true });
  const drives: DriveFrontmatter[] = [];

  for (const entry of entries) {
    if (entry.name === 'notes') continue;

    if (entry.isFile() && entry.name.endsWith('.md')) {
      const drive = parseDriveFile(path.join(drivesDir, entry.name));
      if (drive) drives.push(drive.frontmatter);
    } else if (entry.isDirectory()) {
      const overviewPath = path.join(drivesDir, entry.name, 'overview.md');
      if (fs.existsSync(overviewPath)) {
        const drive = parseDriveFile(overviewPath);
        if (drive) {
          drive.frontmatter.name = entry.name;
          drives.push(drive.frontmatter);
        }
      } else {
        drives.push({ name: entry.name });
      }
    }
  }

  return drives;
}

export function deleteDrive(name: string): boolean {
  const drivesDir = getDrivesDir();

  const filePath = path.join(drivesDir, `${name}.md`);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    return true;
  }

  const dirPath = path.join(drivesDir, name);
  if (fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory()) {
    fs.rmSync(dirPath, { recursive: true, force: true });
    return true;
  }

  return false;
}

export function driveExists(name: string): boolean {
  const drivesDir = getDrivesDir();
  const filePath = path.join(drivesDir, `${name}.md`);
  const dirPath = path.join(drivesDir, name);
  return fs.existsSync(filePath) || (fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory());
}

export function updateDriveFrontmatter(name: string, updates: Partial<DriveFrontmatter>): void {
  const drive = readDrive(name);
  if (!drive) throw new Error(`Drive '${name}' not found`);

  const newFrontmatter = { ...drive.frontmatter, ...updates };
  fs.writeFileSync(drive.path, serializeDrive(newFrontmatter, drive.content), 'utf-8');
}

export function getDriveContent(name: string): string | null {
  const files = readDriveFiles(name);
  if (files.length === 0) return null;

  if (files.length === 1) {
    return files[0].content;
  }

  return files.map((f) => `## ${path.basename(f.path, '.md')}\n\n${f.content}`).join('\n\n');
}

export function getDriveForProject(projectPath: string): DriveFrontmatter | null {
  const resolved = path.resolve(projectPath);
  const drives = listDrives();

  for (const drive of drives) {
    if (!drive.project) continue;
    const driveProject = drive.project.startsWith('~')
      ? path.join(process.env.HOME || '', drive.project.slice(1))
      : path.resolve(drive.project);
    if (driveProject === resolved) return drive;
  }

  return null;
}

function ensureDriveIsDirectory(driveName: string): void {
  const drivesDir = getDrivesDir();
  const filePath = path.join(drivesDir, `${driveName}.md`);
  const dirPath = path.join(drivesDir, driveName);

  if (fs.existsSync(filePath) && !fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
    fs.renameSync(filePath, path.join(dirPath, 'overview.md'));
  }
}

export function addNote(driveName: string, title: string, content: string): string {
  if (!driveExists(driveName)) {
    throw new Error(`Drive '${driveName}' not found`);
  }

  ensureDriveIsDirectory(driveName);

  const drivesDir = getDrivesDir();
  const notesDir = path.join(drivesDir, driveName, 'notes');
  fs.mkdirSync(notesDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  const fileName = `${timestamp}-${slug}.md`;
  const filePath = path.join(notesDir, fileName);

  const noteContent = `---\ntitle: ${title}\ncreated: ${new Date().toISOString()}\n---\n\n${content}\n`;
  fs.writeFileSync(filePath, noteContent, 'utf-8');
  return filePath;
}

export function isDriveLarge(name: string): boolean {
  const drivesDir = getDrivesDir();

  const filePath = path.join(drivesDir, `${name}.md`);
  if (fs.existsSync(filePath)) {
    const stats = fs.statSync(filePath);
    return stats.size > 50 * 1024;
  }

  const dirPath = path.join(drivesDir, name);
  if (fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory()) {
    const files = fs.readdirSync(dirPath, { recursive: true }) as string[];
    return files.filter((f) => f.endsWith('.md')).length > 20;
  }

  return false;
}

export function discoverDrivesFromRepo(repoPath: string): Array<{ name: string; path: string }> {
  const drivesPath = path.join(repoPath, 'drives');
  if (!fs.existsSync(drivesPath)) return [];

  const entries = fs.readdirSync(drivesPath, { withFileTypes: true });
  const result: Array<{ name: string; path: string }> = [];

  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.md')) {
      result.push({
        name: entry.name.replace(/\.md$/, ''),
        path: path.join(drivesPath, entry.name),
      });
    } else if (entry.isDirectory() && entry.name !== 'notes') {
      result.push({
        name: entry.name,
        path: path.join(drivesPath, entry.name),
      });
    }
  }

  return result;
}

export function installDriveFromSource(sourcePath: string, name: string): { success: boolean; error?: string } {
  try {
    const drivesDir = getDrivesDir();
    ensureAgentsDir();

    const stat = fs.statSync(sourcePath);
    if (stat.isDirectory()) {
      const destDir = path.join(drivesDir, name);
      fs.cpSync(sourcePath, destDir, { recursive: true });
    } else {
      const destFile = path.join(drivesDir, `${name}.md`);
      fs.copyFileSync(sourcePath, destFile);
    }

    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

export function driveContentMatches(name: string, sourcePath: string): boolean {
  try {
    const drivesDir = getDrivesDir();
    const stat = fs.statSync(sourcePath);

    if (stat.isFile()) {
      const destFile = path.join(drivesDir, `${name}.md`);
      if (!fs.existsSync(destFile)) return false;
      return fs.readFileSync(sourcePath, 'utf-8') === fs.readFileSync(destFile, 'utf-8');
    }

    return false;
  } catch {
    return false;
  }
}
