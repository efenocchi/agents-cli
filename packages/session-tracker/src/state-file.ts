import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { SessionState } from './types.js';

export const STATE_DIR = path.join(os.homedir(), '.agents', '.cache', 'terminals', 'sessions');

export function stateFilePath(pid: number): string {
  return path.join(STATE_DIR, `${pid}.json`);
}

const KEY_ORDER: (keyof SessionState)[] = [
  'session_id',
  'agent',
  'cwd',
  'pid',
  'terminal_id',
  'launch_id',
  'ts',
  'method',
];

export function serializeState(s: SessionState): string {
  const ordered: Record<string, unknown> = {};
  for (const k of KEY_ORDER) {
    const v = s[k];
    if (v !== undefined) ordered[k] = v;
  }
  return JSON.stringify(ordered);
}

export function parseState(raw: string): SessionState | null {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  if (
    typeof o.session_id !== 'string' ||
    typeof o.cwd !== 'string' ||
    typeof o.pid !== 'number' ||
    typeof o.ts !== 'number'
  ) {
    return null;
  }
  // Legacy hooks (the pre-package SessionStart capture script) wrote a subset
  // of fields. Default the rest rather than reject — session_id is the load-
  // bearing field and is always present.
  if (typeof o.agent !== 'string') o.agent = 'unknown' as any;
  if (typeof o.method !== 'string') o.method = 'hook-stdin';
  return o as unknown as SessionState;
}

export async function writeStateAtomic(state: SessionState): Promise<void> {
  await fs.promises.mkdir(STATE_DIR, { recursive: true });
  const finalPath = stateFilePath(state.pid);
  const tmpPath = `${finalPath}.${process.pid}.${Date.now()}.tmp`;
  await fs.promises.writeFile(tmpPath, serializeState(state), 'utf8');
  await fs.promises.rename(tmpPath, finalPath);
}
