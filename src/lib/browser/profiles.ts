import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as yaml from 'yaml';
import { getUserAgentsDir } from '../state.js';
import type { BrowserProfile } from './types.js';

export type { BrowserProfile } from './types.js';

export function getBrowserProfilesDir(): string {
  return path.join(getUserAgentsDir(), 'browser', 'profiles');
}

export function getBrowserRuntimeDir(): string {
  const agentsDir = path.join(os.homedir(), '.agents-system');
  return path.join(agentsDir, 'browser');
}

export function getProfilePath(name: string): string {
  return path.join(getBrowserProfilesDir(), `${name}.yaml`);
}

export function getProfileRuntimeDir(name: string): string {
  return path.join(getBrowserRuntimeDir(), name);
}

export async function listProfiles(): Promise<BrowserProfile[]> {
  const dir = getBrowserProfilesDir();
  if (!fs.existsSync(dir)) return [];

  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.yaml'));
  const profiles: BrowserProfile[] = [];

  for (const file of files) {
    const content = fs.readFileSync(path.join(dir, file), 'utf-8');
    const profile = yaml.parse(content) as BrowserProfile;
    profiles.push(profile);
  }

  return profiles;
}

export async function getProfile(name: string): Promise<BrowserProfile | null> {
  const filePath = getProfilePath(name);
  if (!fs.existsSync(filePath)) return null;

  const content = fs.readFileSync(filePath, 'utf-8');
  return yaml.parse(content) as BrowserProfile;
}

export async function createProfile(profile: BrowserProfile): Promise<void> {
  const dir = getBrowserProfilesDir();
  fs.mkdirSync(dir, { recursive: true });

  const filePath = getProfilePath(profile.name);
  if (fs.existsSync(filePath)) {
    throw new Error(`Profile "${profile.name}" already exists`);
  }

  fs.writeFileSync(filePath, yaml.stringify(profile), 'utf-8');
}

export async function updateProfile(profile: BrowserProfile): Promise<void> {
  const filePath = getProfilePath(profile.name);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Profile "${profile.name}" does not exist`);
  }

  fs.writeFileSync(filePath, yaml.stringify(profile), 'utf-8');
}

export async function deleteProfile(name: string): Promise<void> {
  const filePath = getProfilePath(name);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Profile "${name}" does not exist`);
  }

  fs.unlinkSync(filePath);
}
