/**
 * Sync manifest — fast staleness guard for syncResourcesToVersion.
 *
 * Written after each full sync; read before the next to skip unconditional
 * re-copies when nothing has changed. Two-tier check:
 *   Tier 1 — stat mtime+size   ~0.01ms/file   (kernel VFS cache)
 *   Tier 2 — sha256 on miss    ~0.1–0.5ms/file
 *
 * Env vars in MCP YAML are NOT substituted by agents-cli — ${VAR} is stored
 * verbatim and passed as-is to `claude mcp add`. Value-only env var changes
 * (YAML content unchanged) are not detected and are not in scope.
 *
 * Layering model:
 *   First-wins (commands, skills, hooks, MCP, rules): manifest stores fingerprint
 *   of the WINNING source (project > user > system > extra). A scope change
 *   (e.g. project file added/removed) is detected via resolved-path mismatch.
 *
 *   Merged (permissions): all group files across all scopes contribute. Any
 *   change in any scope file triggers re-sync.
 *
 * The manifest is written only after a full (unselected) sync and is only used
 * as a guard for full syncs — partial/interactive syncs bypass it entirely.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { AgentId } from './types.js';
import type { AvailableResources } from './versions.js';
import {
  getVersionsDir,
  getProjectAgentsDir,
  getUserAgentsDir,
  getSkillsDir,
  getUserHooksDir,
  getHooksDir,
  getUserRulesDir,
  getResolvedRulesDir,
  getUserPermissionsDir,
  getPermissionsDir,
  getEnabledExtraRepos,
} from './state.js';
import { resolveResource } from './resources.js';
import { listMcpServerConfigs } from './mcp.js';
import { isMemoryStale } from './memory-compile.js';
import { getActivePermissionSetName } from './permissions.js';
import { safeJoin } from './paths.js';

// ─── Types ────────────────────────────────────────────────────────────────────

const MANIFEST_VERSION = 1 as const;

/** Fingerprint of a single source file. */
export interface Fingerprint {
  path:   string;
  mtime:  number;   // stat.mtimeMs
  size:   number;   // stat.size in bytes
  sha256: string;
}

/** A single-file resource (command, hook, MCP server YAML). */
interface FileEntry { source: Fingerprint }

/** A directory resource (skill). */
interface DirEntry {
  dirPath: string;        // winning source directory (absolute)
  files:   Fingerprint[]; // all files, sorted by path relative to dirPath
}

/** Rules/memory: per-file first-wins fingerprints. */
interface RulesEntry {
  files: Record<string, FileEntry>; // key = mem name (without .md)
}

/** Permissions: all group files across all scopes (merged). */
interface PermEntry {
  groups:        Record<string, FileEntry>; // key = group name, first-wins per name
  permissionSet: string | null;             // AGENTS_PERMISSION_SET env var at sync time
}

export interface SyncManifest {
  v:          typeof MANIFEST_VERSION;
  syncedAt:   string;
  commands:   Record<string, FileEntry>;
  skills:     Record<string, DirEntry>;
  hooks:      Record<string, FileEntry>;
  rules:      RulesEntry;
  mcp:        Record<string, FileEntry>;
  permissions: PermEntry;
}

// ─── Path helpers ─────────────────────────────────────────────────────────────

function manifestPath(agent: AgentId, version: string): string {
  return path.join(getVersionsDir(), agent, version, 'home', '.sync-manifest.json');
}

// ─── Fingerprinting ───────────────────────────────────────────────────────────

function sha256(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/** Compute fingerprint for a single file. Returns null if the file can't be read. */
function fingerprintFile(filePath: string): Fingerprint | null {
  try {
    const stat = fs.statSync(filePath);
    const content = fs.readFileSync(filePath, 'utf-8');
    return {
      path:   filePath,
      mtime:  stat.mtimeMs,
      size:   stat.size,
      sha256: sha256(content),
    };
  } catch {
    return null;
  }
}

/**
 * Fingerprint all files in a directory recursively.
 * Returns sorted by absolute path so ordering is deterministic.
 */
function fingerprintDir(dirPath: string): Fingerprint[] {
  const results: Fingerprint[] = [];
  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); }
      else if (entry.isFile()) {
        const fp = fingerprintFile(full);
        if (fp) results.push(fp);
      }
    }
  }
  walk(dirPath);
  results.sort((a, b) => a.path.localeCompare(b.path));
  return results;
}

// ─── Staleness check ──────────────────────────────────────────────────────────

/**
 * Check if a stored fingerprint is still valid for the file at its recorded path.
 * Tier 1: mtime+size match → clean (no read needed).
 * Tier 2: sha256 match → clean (mtime drifted, content same).
 * Path mismatch → immediately stale (scope changed).
 */
function isFileStale(stored: Fingerprint, currentPath: string): boolean {
  if (stored.path !== currentPath) return true;
  try {
    const stat = fs.statSync(currentPath);
    if (stat.mtimeMs === stored.mtime && stat.size === stored.size) return false;
    return sha256(fs.readFileSync(currentPath, 'utf-8')) !== stored.sha256;
  } catch {
    return true; // file disappeared
  }
}

/** Check if a DirEntry is stale for the given source directory. */
function isDirStale(stored: DirEntry, currentDirPath: string): boolean {
  if (stored.dirPath !== currentDirPath) return true;
  const current = fingerprintDir(currentDirPath);
  if (current.length !== stored.files.length) return true;
  for (let i = 0; i < current.length; i++) {
    if (isFileStale(stored.files[i], current[i].path)) return true;
  }
  return false;
}

/** Compare sorted name sets. Returns true if they differ. */
function nameSetDiffers(manifestKeys: string[], available: string[]): boolean {
  if (manifestKeys.length !== available.length) return true;
  const sorted = [...available].sort();
  const mSorted = [...manifestKeys].sort();
  return sorted.some((name, i) => name !== mSorted[i]);
}

// ─── Source resolution helpers ────────────────────────────────────────────────

function resolveSkillDir(skill: string, cwd: string): string | null {
  const projectDir = getProjectAgentsDir(cwd);
  const candidates: Array<string | null> = [
    projectDir ? path.join(projectDir, 'skills', skill) : null,
    path.join(getUserAgentsDir(), 'skills', skill),
    path.join(getSkillsDir(), skill),
    ...getEnabledExtraRepos().map(e => path.join(e.dir, 'skills', skill)),
  ];
  return candidates.find(p => p && fs.existsSync(p) && fs.statSync(p).isDirectory()) ?? null;
}

function resolveRuleFile(mem: string, cwd: string): string | null {
  const projectDir = getProjectAgentsDir(cwd);
  const candidates: Array<string | null> = [
    projectDir ? safeJoin(path.join(projectDir, 'rules'), `${mem}.md`) : null,
    safeJoin(getUserRulesDir(), `${mem}.md`),
    safeJoin(getResolvedRulesDir(), `${mem}.md`),
    ...getEnabledExtraRepos().map(e => safeJoin(path.join(e.dir, 'rules'), `${mem}.md`)),
  ];
  return candidates.find(p => {
    if (!p) return false;
    try { return !fs.lstatSync(p).isSymbolicLink() && fs.existsSync(p); } catch { return false; }
  }) ?? null;
}

/** Collect all permission group files across all scopes (first-wins per name). */
function collectPermissionGroupFiles(): Record<string, string> {
  const seen = new Map<string, string>(); // name → filePath (first-wins: user > system)
  for (const baseDir of [getUserPermissionsDir(), getPermissionsDir()]) {
    const groupsDir = path.join(baseDir, 'groups');
    if (!fs.existsSync(groupsDir)) continue;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(groupsDir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.yaml') && !entry.name.endsWith('.yml')) continue;
      const name = entry.name.replace(/\.(yaml|yml)$/, '');
      if (!seen.has(name)) seen.set(name, path.join(groupsDir, entry.name));
    }
  }
  return Object.fromEntries(seen);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** Load the manifest for a given agent+version. Returns null on miss or parse error. */
export function loadSyncManifest(agent: AgentId, version: string): SyncManifest | null {
  const p = manifestPath(agent, version);
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8')) as SyncManifest;
    if (raw.v !== MANIFEST_VERSION) return null;
    return raw;
  } catch {
    return null;
  }
}

/** Write the manifest atomically (tmp + rename). */
export function saveSyncManifest(agent: AgentId, version: string, manifest: SyncManifest): void {
  const p = manifestPath(agent, version);
  const tmp = p + '.tmp';
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2));
    fs.renameSync(tmp, p);
  } catch {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

/**
 * Build a manifest by fingerprinting current source state.
 * Call this after a successful full sync.
 */
export function buildManifest(
  agent: AgentId,
  version: string,
  available: AvailableResources,
  cwd: string,
): SyncManifest {
  const commands: Record<string, FileEntry> = {};
  for (const name of available.commands) {
    const resolved = resolveResource('commands', `${name}.md`, cwd);
    if (!resolved) continue;
    const fp = fingerprintFile(resolved.path);
    if (fp) commands[name] = { source: fp };
  }

  const skills: Record<string, DirEntry> = {};
  for (const name of available.skills) {
    const dirPath = resolveSkillDir(name, cwd);
    if (!dirPath) continue;
    skills[name] = { dirPath, files: fingerprintDir(dirPath) };
  }

  const hooks: Record<string, FileEntry> = {};
  for (const name of available.hooks) {
    // Hooks: resolve winning source manually (project > user > system > extra)
    const projectDir = getProjectAgentsDir(cwd);
    const candidates: Array<string | null> = [
      projectDir ? path.join(projectDir, 'hooks', name) : null,
      path.join(getUserHooksDir(), name),
      path.join(getHooksDir(), name),
      ...getEnabledExtraRepos().map(e => path.join(e.dir, 'hooks', name)),
    ];
    const hookPath = candidates.find(p => p && fs.existsSync(p)) ?? null;
    if (!hookPath) continue;
    const fp = fingerprintFile(hookPath);
    if (fp) hooks[name] = { source: fp };
  }

  const ruleFiles: Record<string, FileEntry> = {};
  for (const name of available.memory) {
    const srcPath = resolveRuleFile(name, cwd);
    if (!srcPath) continue;
    const fp = fingerprintFile(srcPath);
    if (fp) ruleFiles[name] = { source: fp };
  }

  const mcp: Record<string, FileEntry> = {};
  for (const server of listMcpServerConfigs(cwd)) {
    const fp = fingerprintFile(server.path);
    if (fp) mcp[server.name] = { source: fp };
  }

  const groupFiles = collectPermissionGroupFiles();
  const permGroups: Record<string, FileEntry> = {};
  for (const [name, filePath] of Object.entries(groupFiles)) {
    const fp = fingerprintFile(filePath);
    if (fp) permGroups[name] = { source: fp };
  }

  return {
    v:       MANIFEST_VERSION,
    syncedAt: new Date().toISOString(),
    commands,
    skills,
    hooks,
    rules: { files: ruleFiles },
    mcp,
    permissions: {
      groups:        permGroups,
      permissionSet: getActivePermissionSetName(),
    },
  };
}

/**
 * Check if sources have changed since the manifest was written.
 * Returns true (stale) at the first detected mismatch — no need to scan everything.
 * Returns false (clean) only after all checks pass.
 *
 * For rules, also delegates to isMemoryStale() to catch @-import changes
 * for agents that pre-compile their memory file.
 */
export function isSyncStale(
  manifest: SyncManifest,
  available: AvailableResources,
  agent: AgentId,
  version: string,
  cwd: string,
): boolean {
  // ── Commands ──────────────────────────────────────────────────────────────
  if (nameSetDiffers(Object.keys(manifest.commands), available.commands)) return true;
  for (const name of available.commands) {
    const resolved = resolveResource('commands', `${name}.md`, cwd);
    if (!resolved) return true;
    const entry = manifest.commands[name];
    if (!entry || isFileStale(entry.source, resolved.path)) return true;
  }

  // ── Skills ────────────────────────────────────────────────────────────────
  if (nameSetDiffers(Object.keys(manifest.skills), available.skills)) return true;
  for (const name of available.skills) {
    const dirPath = resolveSkillDir(name, cwd);
    if (!dirPath) return true;
    const entry = manifest.skills[name];
    if (!entry || isDirStale(entry, dirPath)) return true;
  }

  // ── Hooks ─────────────────────────────────────────────────────────────────
  if (nameSetDiffers(Object.keys(manifest.hooks), available.hooks)) return true;
  for (const name of available.hooks) {
    const projectDir = getProjectAgentsDir(cwd);
    const candidates: Array<string | null> = [
      projectDir ? path.join(projectDir, 'hooks', name) : null,
      path.join(getUserHooksDir(), name),
      path.join(getHooksDir(), name),
      ...getEnabledExtraRepos().map(e => path.join(e.dir, 'hooks', name)),
    ];
    const hookPath = candidates.find(p => p && fs.existsSync(p)) ?? null;
    if (!hookPath) return true;
    const entry = manifest.hooks[name];
    if (!entry || isFileStale(entry.source, hookPath)) return true;
  }

  // ── Rules/memory ──────────────────────────────────────────────────────────
  if (nameSetDiffers(Object.keys(manifest.rules.files), available.memory)) return true;
  for (const name of available.memory) {
    const srcPath = resolveRuleFile(name, cwd);
    if (!srcPath) return true;
    const entry = manifest.rules.files[name];
    if (!entry || isFileStale(entry.source, srcPath)) return true;
  }
  // Also catch @-import changes for non-native-import agents
  if (isMemoryStale(agent, version)) return true;

  // ── MCP ───────────────────────────────────────────────────────────────────
  const mcpServers = listMcpServerConfigs(cwd);
  const mcpNames = mcpServers.map(s => s.name);
  if (nameSetDiffers(Object.keys(manifest.mcp), mcpNames)) return true;
  for (const server of mcpServers) {
    const entry = manifest.mcp[server.name];
    if (!entry || isFileStale(entry.source, server.path)) return true;
  }

  // ── Permissions ───────────────────────────────────────────────────────────
  if (manifest.permissions.permissionSet !== getActivePermissionSetName()) return true;
  const currentGroups = collectPermissionGroupFiles();
  if (nameSetDiffers(Object.keys(manifest.permissions.groups), Object.keys(currentGroups))) return true;
  for (const [name, filePath] of Object.entries(currentGroups)) {
    const entry = manifest.permissions.groups[name];
    if (!entry || isFileStale(entry.source, filePath)) return true;
  }

  return false;
}
