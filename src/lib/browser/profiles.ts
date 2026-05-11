import * as path from 'path';
import {
  getBrowserRuntimeDir as getBrowserRuntimeDirRoot,
  readMeta,
  writeMeta,
} from '../state.js';
import type { BrowserProfileConfig } from '../types.js';
import type { BrowserProfile } from './types.js';
import { findBrowserPath } from './chrome.js';

export type { BrowserProfile } from './types.js';

export function getBrowserRuntimeDir(): string {
  return getBrowserRuntimeDirRoot();
}

export function getProfileRuntimeDir(name: string): string {
  return path.join(getBrowserRuntimeDir(), name);
}

function configToProfile(name: string, config: BrowserProfileConfig): BrowserProfile {
  return {
    name,
    description: config.description,
    browser: config.browser,
    binary: config.binary,
    electron: config.electron,
    endpoints: config.endpoints,
    chrome: config.chrome,
    secrets: config.secrets,
    viewport: config.viewport,
  };
}

function profileToConfig(profile: BrowserProfile): BrowserProfileConfig {
  const config: BrowserProfileConfig = {
    browser: profile.browser,
    endpoints: profile.endpoints,
  };
  if (profile.description) config.description = profile.description;
  if (profile.binary) config.binary = profile.binary;
  if (profile.electron) config.electron = profile.electron;
  if (profile.chrome) config.chrome = profile.chrome;
  if (profile.secrets) config.secrets = profile.secrets;
  if (profile.viewport) config.viewport = profile.viewport;
  return config;
}

export async function listProfiles(): Promise<BrowserProfile[]> {
  const meta = readMeta();
  if (!meta.browser) return [];

  return Object.entries(meta.browser).map(([name, config]) =>
    configToProfile(name, config)
  );
}

export async function getProfile(name: string): Promise<BrowserProfile | null> {
  const meta = readMeta();
  const config = meta.browser?.[name];
  if (!config) return null;
  return configToProfile(name, config);
}

export async function createProfile(profile: BrowserProfile): Promise<void> {
  const meta = readMeta();
  if (meta.browser?.[profile.name]) {
    throw new Error(`Profile "${profile.name}" already exists`);
  }

  // Resolve the browser binary at create time. Fails fast with an actionable
  // error ("Comet not installed at /Applications/Comet.app") rather than
  // deferring the failure to the first task. `findBrowserPath` short-circuits
  // for browser=custom without a binary by throwing — same outcome.
  findBrowserPath(profile.browser, profile.binary);

  meta.browser = meta.browser ?? {};
  meta.browser[profile.name] = profileToConfig(profile);
  writeMeta(meta);
}

export async function updateProfile(profile: BrowserProfile): Promise<void> {
  const meta = readMeta();
  if (!meta.browser?.[profile.name]) {
    throw new Error(`Profile "${profile.name}" does not exist`);
  }

  meta.browser[profile.name] = profileToConfig(profile);
  writeMeta(meta);
}

export async function deleteProfile(name: string): Promise<void> {
  const meta = readMeta();
  if (!meta.browser?.[name]) {
    throw new Error(`Profile "${name}" does not exist`);
  }

  delete meta.browser[name];
  writeMeta(meta);
}

/**
 * Extract the port intended by the profile's first endpoint.
 * Returns undefined for endpoint shapes that don't carry a port (e.g. ws:// without one).
 */
export function extractConfiguredPort(profile: BrowserProfile): number | undefined {
  const endpoint = profile.endpoints[0];
  if (!endpoint) return undefined;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return undefined;
  }
  if (url.port) return parseInt(url.port, 10);
  if (url.protocol === 'cdp:') return 9222;
  if (url.protocol === 'ssh:') return 9222;
  return undefined;
}
