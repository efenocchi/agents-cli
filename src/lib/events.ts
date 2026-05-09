/**
 * Centralized event logging for agents-cli.
 *
 * Structured JSONL logs at ~/.agents/logs/events-YYYY-MM-DD.jsonl
 * with automatic daily rotation and rich metadata for debugging/auditing.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ─── Constants ────────────────────────────────────────────────────────────────

const USER_AGENTS_DIR = path.join(os.homedir(), '.agents');
const LOGS_DIR = path.join(USER_AGENTS_DIR, 'logs');

/** Default retention period in days. */
const DEFAULT_RETENTION_DAYS = 30;

// ─── Types ────────────────────────────────────────────────────────────────────

export type EventType =
  // Agent lifecycle
  | 'agent.run.start'
  | 'agent.run.end'
  // Version management
  | 'version.install'
  | 'version.switch'
  | 'version.remove'
  // Skills
  | 'skill.install'
  | 'skill.remove'
  // Browser
  | 'browser.launch'
  | 'browser.close'
  // Secrets (no values logged)
  | 'secrets.get'
  | 'secrets.set'
  | 'secrets.delete'
  // Cloud dispatch
  | 'cloud.dispatch'
  | 'cloud.complete'
  // Teams
  | 'teams.create'
  | 'teams.start'
  | 'teams.complete'
  // Hooks
  | 'hook.fire'
  | 'hook.error'
  // Resources
  | 'resource.sync'
  // Generic
  | 'error'
  | 'warn'
  | 'info';

export interface EventMeta {
  ts: string;
  tz: string;
  tzName: string;
  hostname: string;
  platform: NodeJS.Platform;
  arch: string;
  pid: number;
  event: EventType;
}

export interface EventPayload {
  agent?: string;
  version?: string;
  cwd?: string;
  durationMs?: number;
  error?: string;
  [key: string]: unknown;
}

export type EventRecord = EventMeta & EventPayload;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getTimezoneOffset(): string {
  const offset = new Date().getTimezoneOffset();
  const sign = offset <= 0 ? '+' : '-';
  const hours = String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0');
  const mins = String(Math.abs(offset) % 60).padStart(2, '0');
  return `${sign}${hours}:${mins}`;
}

function getTimezoneName(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return 'Unknown';
  }
}

function getLogFilePath(date: Date = new Date()): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return path.join(LOGS_DIR, `events-${yyyy}-${mm}-${dd}.jsonl`);
}

function ensureLogsDir(): void {
  if (!fs.existsSync(LOGS_DIR)) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
  }
}

// ─── Core API ─────────────────────────────────────────────────────────────────

/**
 * Emit a structured event to the daily log file.
 *
 * @param event - The event type
 * @param payload - Event-specific data (agent, version, cwd, etc.)
 */
export function emit(event: EventType, payload: EventPayload = {}): void {
  try {
    ensureLogsDir();

    const record: EventRecord = {
      ts: new Date().toISOString(),
      tz: getTimezoneOffset(),
      tzName: getTimezoneName(),
      hostname: os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
      pid: process.pid,
      event,
      ...payload,
    };

    const line = JSON.stringify(record) + '\n';
    fs.appendFileSync(getLogFilePath(), line);
  } catch {
    // Silent failure - logging should never break the CLI
  }
}

/**
 * Convenience wrapper for timed operations.
 * Returns a function to call when the operation completes.
 *
 * @example
 * const done = emitStart('agent.run.start', { agent: 'claude' });
 * // ... do work ...
 * done({ exitCode: 0 }); // emits agent.run.end with durationMs
 */
export function emitStart(
  startEvent: EventType,
  payload: EventPayload = {}
): (endPayload?: EventPayload) => void {
  const startTime = Date.now();
  emit(startEvent, payload);

  const endEvent = startEvent.replace('.start', '.end') as EventType;

  return (endPayload: EventPayload = {}) => {
    emit(endEvent, {
      ...payload,
      ...endPayload,
      durationMs: Date.now() - startTime,
    });
  };
}

// ─── Rotation ─────────────────────────────────────────────────────────────────

/**
 * Remove log files older than the retention period.
 * Called lazily on emit or explicitly via CLI.
 *
 * @param retentionDays - Number of days to keep (default 30)
 * @returns Number of files removed
 */
export function rotate(retentionDays: number = DEFAULT_RETENTION_DAYS): number {
  try {
    if (!fs.existsSync(LOGS_DIR)) return 0;

    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const files = fs.readdirSync(LOGS_DIR).filter(f => f.startsWith('events-') && f.endsWith('.jsonl'));
    let removed = 0;

    for (const file of files) {
      const match = file.match(/^events-(\d{4})-(\d{2})-(\d{2})\.jsonl$/);
      if (!match) continue;

      const [, yyyy, mm, dd] = match;
      const fileDate = new Date(parseInt(yyyy), parseInt(mm) - 1, parseInt(dd));

      if (fileDate.getTime() < cutoff) {
        fs.unlinkSync(path.join(LOGS_DIR, file));
        removed++;
      }
    }

    return removed;
  } catch {
    return 0;
  }
}

/**
 * Lazy rotation - runs at most once per day per process.
 */
let lastRotationCheck = 0;
export function maybeRotate(): void {
  const now = Date.now();
  const oneDayMs = 24 * 60 * 60 * 1000;

  if (now - lastRotationCheck > oneDayMs) {
    lastRotationCheck = now;
    rotate();
  }
}

// ─── Query ────────────────────────────────────────────────────────────────────

/**
 * Read events from log files within a date range.
 *
 * @param options - Query options
 * @returns Array of event records
 */
export function query(options: {
  startDate?: Date;
  endDate?: Date;
  eventTypes?: EventType[];
  agent?: string;
  limit?: number;
}): EventRecord[] {
  const { startDate, endDate = new Date(), eventTypes, agent, limit } = options;
  const results: EventRecord[] = [];

  if (!fs.existsSync(LOGS_DIR)) return results;

  const files = fs.readdirSync(LOGS_DIR)
    .filter(f => f.startsWith('events-') && f.endsWith('.jsonl'))
    .sort()
    .reverse();

  for (const file of files) {
    const match = file.match(/^events-(\d{4})-(\d{2})-(\d{2})\.jsonl$/);
    if (!match) continue;

    const [, yyyy, mm, dd] = match;
    const fileDate = new Date(parseInt(yyyy), parseInt(mm) - 1, parseInt(dd));

    if (startDate && fileDate < startDate) continue;
    if (endDate && fileDate > endDate) continue;

    const content = fs.readFileSync(path.join(LOGS_DIR, file), 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);

    for (const line of lines.reverse()) {
      try {
        const record = JSON.parse(line) as EventRecord;

        if (eventTypes && !eventTypes.includes(record.event)) continue;
        if (agent && record.agent !== agent) continue;

        results.push(record);

        if (limit && results.length >= limit) {
          return results;
        }
      } catch {
        // Skip malformed lines
      }
    }
  }

  return results;
}

// ─── Exports ──────────────────────────────────────────────────────────────────

export const LOGS_PATH = LOGS_DIR;
