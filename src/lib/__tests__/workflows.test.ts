import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveWorkflowRef } from '../workflows.js';

const tmpDirs: string[] = [];

function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-workflow-ref-'));
  tmpDirs.push(dir);
  return dir;
}

function writeWorkflow(parent: string, name: string): string {
  const dir = path.join(parent, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'WORKFLOW.md'), '---\nname: Test Workflow\n---\nDo the work.\n');
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('resolveWorkflowRef', () => {
  it('resolves an absolute workflow directory path', () => {
    const workflowDir = writeWorkflow(tmpRoot(), 'absolute-workflow');
    expect(resolveWorkflowRef(workflowDir, '/')).toBe(workflowDir);
  });

  it('resolves a relative workflow directory path from cwd', () => {
    const root = tmpRoot();
    const workflowDir = writeWorkflow(root, 'relative-workflow');
    expect(resolveWorkflowRef('./relative-workflow', root)).toBe(workflowDir);
  });

  it('does not resolve a directory without WORKFLOW.md', () => {
    const dir = path.join(tmpRoot(), 'not-a-workflow');
    fs.mkdirSync(dir, { recursive: true });
    expect(resolveWorkflowRef(dir, '/')).toBeNull();
  });
});
