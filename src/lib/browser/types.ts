export type BrowserType = 'chrome' | 'comet' | 'chromium' | 'brave' | 'edge' | 'custom';

export interface BrowserProfile {
  name: string;
  description?: string;
  browser: BrowserType;
  binary?: string;
  electron?: boolean;
  endpoints: string[];
  chrome?: ChromeOptions;
  secrets?: string;
  viewport?: { width: number; height: number };
}

export interface ChromeOptions {
  headless?: boolean;
  args?: string[];
}

export interface Task {
  id: string;
  name: string;
  profile: string;
  tabs: Record<string, string>; // shortId (8 chars) -> CDP targetId
  currentTabId?: string; // shortId of current tab
  createdAt: number;
  pid: number;
}

export interface TabInfo {
  id: string;
  url: string;
  title: string;
  task: string;
}

export interface ProfileStatus {
  name: string;
  running: boolean;
  port?: number;
  pid?: number;
  /** The port declared in the profile's first endpoint, when it differs from the running port. */
  configuredPort?: number;
  tasks: TaskStatus[];
}

export interface TaskStatus {
  id: string;
  name: string;
  tabCount: number;
  currentTabId?: string;
  createdAt: number;
  endedAt?: number;
  domains?: string[];
  tabs?: Array<{ id: string; url: string; title?: string; current?: boolean }>;
}

export interface HistoricalTask {
  id: string;
  name: string;
  profile: string;
  createdAt: number;
  endedAt: number;
  domains: string[];
  tabCount: number;
}

export type IPCAction =
  | 'start'
  | 'done'
  | 'stop'
  | 'status'
  | 'history'
  | 'navigate'
  | 'tab-add'
  | 'tab-focus'
  | 'tab-close'
  | 'tab-list'
  | 'evaluate'
  | 'screenshot'
  | 'refs'
  | 'click'
  | 'type'
  | 'press'
  | 'hover';

export interface IPCRequest {
  action: IPCAction;
  task?: string;
  taskName?: string; // human-readable task name for 'open'
  profile?: string;
  url?: string;
  tabId?: string;
  expr?: string;
  path?: string;
  ref?: number;
  text?: string;
  key?: string;
  interactive?: boolean;
  limit?: number;
}

export interface IPCResponse {
  ok: boolean;
  error?: string;
  task?: string;
  tabId?: string;
  windowTargetId?: string;
  tabs?: TabInfo[];
  profiles?: ProfileStatus[];
  history?: HistoricalTask[];
  result?: unknown;
  path?: string;
  refs?: string;
}

export const TASK_ID_REGEX = /^[a-z0-9][a-z0-9-]*$/;

export function isValidTaskId(id: string): boolean {
  return TASK_ID_REGEX.test(id) && id.length <= 64;
}

export function generateTaskId(): string {
  return crypto.randomUUID().slice(0, 8);
}

export function generateShortId(): string {
  return crypto.randomUUID().split('-')[0]; // 8 chars
}

const ADJECTIVES = [
  'swift', 'cosmic', 'jolly', 'quiet', 'bold', 'bright', 'calm', 'eager',
  'golden', 'happy', 'keen', 'lucky', 'noble', 'proud', 'quick', 'royal',
];

const NOUNS = [
  'falcon', 'comet', 'tiger', 'nebula', 'phoenix', 'river', 'summit', 'wave',
  'aurora', 'breeze', 'crystal', 'dragon', 'ember', 'forest', 'glacier', 'harbor',
];

export function generateFunName(): string {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  return `${adj}-${noun}`;
}
