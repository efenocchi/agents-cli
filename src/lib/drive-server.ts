import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { execSync } from 'child_process';
import * as fs from 'fs';
import {
  readDrive,
  listDrives,
  getDriveContent,
  getDriveForProject,
  addNote,
  driveExists,
  isDriveLarge,
  readDriveFiles,
} from './drives.js';
import { getDrivesDir } from './state.js';
import * as path from 'path';

let _hasMq: boolean | null = null;

function hasMq(): boolean {
  if (_hasMq !== null) return _hasMq;
  try {
    execSync('which mq', { stdio: 'pipe' });
    _hasMq = true;
  } catch {
    _hasMq = false;
  }
  return _hasMq;
}

function runMq(targetPath: string, query: string): string {
  try {
    return execSync(`mq "${targetPath}" '${query}'`, {
      encoding: 'utf-8',
      timeout: 10000,
    }).trim();
  } catch (err) {
    return `mq error: ${(err as Error).message}`;
  }
}

export function handleGetContext(project?: string): { content: string; drive: string; large: boolean } {
  let driveName: string | null = null;

  if (project) {
    if (driveExists(project)) {
      driveName = project;
    } else {
      const found = getDriveForProject(project);
      if (found) driveName = found.name;
    }
  } else {
    const cwd = process.cwd();
    const found = getDriveForProject(cwd);
    if (found) driveName = found.name;
  }

  if (!driveName) {
    const drives = listDrives();
    if (drives.length === 0) {
      return { content: 'No drives configured. Create one with: agents drive create <name>', drive: '', large: false };
    }
    const list = drives.map((d) => `- ${d.name}${d.description ? `: ${d.description}` : ''}`).join('\n');
    return { content: `No matching drive found. Available drives:\n${list}`, drive: '', large: false };
  }

  const large = isDriveLarge(driveName);

  if (large && hasMq()) {
    const drivesDir = getDrivesDir();
    const drivePath = path.join(drivesDir, driveName);
    const tree = runMq(drivePath, '.tree("full")');
    return { content: tree, drive: driveName, large: true };
  }

  const content = getDriveContent(driveName);
  if (!content) {
    return { content: `Drive '${driveName}' exists but has no content.`, drive: driveName, large: false };
  }

  const drive = readDrive(driveName);
  const header = drive?.frontmatter
    ? Object.entries(drive.frontmatter)
        .filter(([_, v]) => v)
        .map(([k, v]) => `${k}: ${v}`)
        .join('\n')
    : '';

  return { content: header ? `${header}\n\n${content}` : content, drive: driveName, large: false };
}

export function handleGetSection(project: string, file: string, section: string): string {
  if (!driveExists(project)) {
    return `Drive '${project}' not found`;
  }

  const drivesDir = getDrivesDir();
  const isSingleFile = fs.existsSync(path.join(drivesDir, `${project}.md`));

  if (hasMq()) {
    const filePath = isSingleFile
      ? path.join(drivesDir, `${project}.md`)
      : path.join(drivesDir, project, file);
    return runMq(filePath, `.section("${section}") | .text`);
  }

  const files = readDriveFiles(project);
  const target = isSingleFile
    ? files[0]
    : files.find((f) => path.basename(f.path) === file);
  if (!target) {
    return `File '${file}' not found in drive '${project}'`;
  }

  const sectionRe = new RegExp(`^#{1,6}\\s+${escapeRegex(section)}\\s*$`, 'm');
  const match = target.content.match(sectionRe);
  if (!match || match.index === undefined) {
    return `Section '${section}' not found in ${file}`;
  }

  const start = match.index;
  const level = match[0].match(/^(#+)/)?.[1].length || 1;
  const rest = target.content.slice(start + match[0].length);
  const nextHeading = rest.match(new RegExp(`^#{1,${level}}\\s`, 'm'));
  const end = nextHeading?.index !== undefined ? start + match[0].length + nextHeading.index : undefined;

  return target.content.slice(start, end).trim();
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function handleAddNote(project: string, title: string, content: string): string {
  try {
    const notePath = addNote(project, title, content);
    return `Note saved: ${notePath}`;
  } catch (err) {
    return `Error: ${(err as Error).message}`;
  }
}

export async function runDriveServer(): Promise<void> {
  const server = new Server(
    { name: 'agents-drive', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'get_context',
        description:
          'Get project context from a drive. If project is specified, returns that drive. ' +
          'If omitted, auto-detects from cwd. For small drives returns full content. ' +
          'For large drives returns a structural overview (use get_section for details).',
        inputSchema: {
          type: 'object' as const,
          properties: {
            project: {
              type: 'string',
              description: 'Drive name or project path. If omitted, auto-detects from cwd.',
            },
          },
        },
      },
      {
        name: 'get_section',
        description:
          'Extract a specific section from a drive file. Useful for large drives ' +
          'where get_context returned a structural overview.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            project: { type: 'string', description: 'Drive name' },
            file: { type: 'string', description: 'File name within the drive (e.g. "backend.md")' },
            section: { type: 'string', description: 'Section heading to extract' },
          },
          required: ['project', 'file', 'section'],
        },
      },
      {
        name: 'add_note',
        description:
          'Add an agent-contributed note to a drive. Notes are stored as timestamped markdown ' +
          'files in the drive\'s notes/ directory and synced on next push.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            project: { type: 'string', description: 'Drive name' },
            title: { type: 'string', description: 'Note title' },
            content: { type: 'string', description: 'Note content (markdown)' },
          },
          required: ['project', 'title', 'content'],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      let result: string;

      switch (name) {
        case 'get_context': {
          const { content, drive, large } = handleGetContext(args?.project as string | undefined);
          const meta = drive ? `[drive: ${drive}${large ? ', structural overview' : ''}]\n\n` : '';
          result = meta + content;
          break;
        }
        case 'get_section': {
          if (!args?.project || !args?.file || !args?.section) {
            result = 'Error: project, file, and section are required';
          } else {
            result = handleGetSection(args.project as string, args.file as string, args.section as string);
          }
          break;
        }
        case 'add_note': {
          if (!args?.project || !args?.title || !args?.content) {
            result = 'Error: project, title, and content are required';
          } else {
            result = handleAddNote(args.project as string, args.title as string, args.content as string);
          }
          break;
        }
        default:
          result = `Unknown tool: ${name}`;
      }

      return {
        content: [{ type: 'text' as const, text: result }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }],
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('agents-drive MCP server started');
}
