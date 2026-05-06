import { spawn, execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getProfileRuntimeDir } from './profiles.js';
import { discoverBrowserWsUrl } from './cdp.js';
import type { ChromeOptions } from './types.js';

const CHROME_PATHS: Record<string, string[]> = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  ],
  linux: [
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
  ],
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ],
};

export function findChromePath(): string | null {
  const platform = os.platform();
  const candidates = CHROME_PATHS[platform] || [];

  for (const p of candidates) {
    if (fs.existsSync(p)) {
      return p;
    }
  }
  return null;
}

export interface LaunchResult {
  pid: number;
  port: number;
  wsUrl: string;
}

export async function launchChrome(
  profileName: string,
  port: number,
  options: ChromeOptions = {}
): Promise<LaunchResult> {
  const chromePath = findChromePath();
  if (!chromePath) {
    throw new Error('Chrome not found. Install Google Chrome or Chromium.');
  }

  const runtimeDir = getProfileRuntimeDir(profileName);
  const userDataDir = path.join(runtimeDir, 'chrome-data');
  fs.mkdirSync(userDataDir, { recursive: true });

  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--remote-allow-origins=*',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    ...(options.headless ? ['--headless=new'] : []),
    ...(options.args || []),
  ];

  const child = spawn(chromePath, args, {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  const pid = child.pid!;
  fs.writeFileSync(path.join(runtimeDir, 'pid'), String(pid));
  fs.writeFileSync(path.join(runtimeDir, 'port'), String(port));

  let wsUrl: string | null = null;
  for (let i = 0; i < 30; i++) {
    await sleep(200);
    try {
      wsUrl = await discoverBrowserWsUrl(port);
      break;
    } catch {
      // Chrome still starting
    }
  }

  if (!wsUrl) {
    throw new Error('Chrome failed to start within 6 seconds');
  }

  return { pid, port, wsUrl };
}

export async function attachToChrome(port: number): Promise<string> {
  return discoverBrowserWsUrl(port);
}

export function killChrome(pid: number): void {
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // Process already dead
  }
}

export function getRunningChromeInfo(
  profileName: string
): { pid: number; port: number } | null {
  const runtimeDir = getProfileRuntimeDir(profileName);
  const pidFile = path.join(runtimeDir, 'pid');
  const portFile = path.join(runtimeDir, 'port');

  if (!fs.existsSync(pidFile) || !fs.existsSync(portFile)) {
    return null;
  }

  const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
  const port = parseInt(fs.readFileSync(portFile, 'utf-8').trim(), 10);

  if (!isProcessRunning(pid)) {
    fs.unlinkSync(pidFile);
    fs.unlinkSync(portFile);
    return null;
  }

  return { pid, port };
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function allocatePort(): number {
  const base = 9200;
  const max = 9300;

  for (let port = base; port < max; port++) {
    try {
      execSync(`lsof -i :${port}`, { stdio: 'ignore' });
    } catch {
      return port;
    }
  }

  throw new Error('No available ports in range 9200-9300');
}
