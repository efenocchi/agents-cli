import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import type { AgentId } from './types.js';
import { getVersionsDir, getShimsDir, ensureAgentsDir, readMeta, writeMeta, getCommandsDir, getSkillsDir, getHooksDir, getMemoryDir } from './state.js';
import { AGENTS } from './agents.js';
import { markdownToToml } from './convert.js';

const execAsync = promisify(exec);

export interface AgentSpec {
  agent: AgentId;
  version: string;
}

/**
 * Parse agent@version syntax.
 * Examples:
 *   "claude@1.5.0" -> { agent: "claude", version: "1.5.0" }
 *   "claude" -> { agent: "claude", version: "latest" }
 *   "codex@latest" -> { agent: "codex", version: "latest" }
 */
export function parseAgentSpec(spec: string): AgentSpec | null {
  const parts = spec.split('@');
  const agentName = parts[0].toLowerCase();
  const version = parts[1] || 'latest';

  if (!AGENTS[agentName as AgentId]) {
    return null;
  }

  return {
    agent: agentName as AgentId,
    version,
  };
}

/**
 * Get the directory where a specific version is installed.
 */
export function getVersionDir(agent: AgentId, version: string): string {
  return path.join(getVersionsDir(), agent, version);
}

/**
 * Get the binary path for a specific agent version.
 */
export function getBinaryPath(agent: AgentId, version: string): string {
  const versionDir = getVersionDir(agent, version);
  const agentConfig = AGENTS[agent];
  return path.join(versionDir, 'node_modules', '.bin', agentConfig.cliCommand);
}

/**
 * Get the isolated HOME directory for a specific agent version.
 * Each version has its own config isolation (like jobs sandbox).
 */
export function getVersionHomePath(agent: AgentId, version: string): string {
  return path.join(getVersionDir(agent, version), 'home');
}

/**
 * Check if a specific version is installed.
 */
export function isVersionInstalled(agent: AgentId, version: string): boolean {
  const binaryPath = getBinaryPath(agent, version);
  return fs.existsSync(binaryPath);
}

/**
 * List all installed versions for an agent.
 */
export function listInstalledVersions(agent: AgentId): string[] {
  const agentVersionsDir = path.join(getVersionsDir(), agent);
  if (!fs.existsSync(agentVersionsDir)) {
    return [];
  }

  const entries = fs.readdirSync(agentVersionsDir, { withFileTypes: true });
  const versions: string[] = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const binaryPath = getBinaryPath(agent, entry.name);
      if (fs.existsSync(binaryPath)) {
        versions.push(entry.name);
      }
    }
  }

  return versions.sort(compareVersions);
}

/**
 * Get the global default version for an agent.
 */
export function getGlobalDefault(agent: AgentId): string | null {
  const meta = readMeta();
  return meta.agents?.[agent] || null;
}

/**
 * Set the global default version for an agent.
 */
export function setGlobalDefault(agent: AgentId, version: string): void {
  const meta = readMeta();
  if (!meta.agents) {
    meta.agents = {};
  }
  meta.agents[agent] = version;
  writeMeta(meta);
}

/**
 * Install a specific version of an agent.
 */
export async function installVersion(
  agent: AgentId,
  version: string,
  onProgress?: (message: string) => void
): Promise<{ success: boolean; installedVersion: string; error?: string }> {
  const agentConfig = AGENTS[agent];

  if (!agentConfig.npmPackage) {
    return { success: false, installedVersion: version, error: 'Agent has no npm package' };
  }

  ensureAgentsDir();
  const versionDir = getVersionDir(agent, version);

  // Create version directory and isolated home
  fs.mkdirSync(versionDir, { recursive: true });
  fs.mkdirSync(path.join(versionDir, 'home'), { recursive: true });

  // Initialize package.json
  const packageJson = {
    name: `agents-${agent}-${version}`,
    version: '1.0.0',
    private: true,
  };
  fs.writeFileSync(path.join(versionDir, 'package.json'), JSON.stringify(packageJson, null, 2));

  // Install the package
  const packageSpec = version === 'latest'
    ? agentConfig.npmPackage
    : `${agentConfig.npmPackage}@${version}`;

  try {
    onProgress?.(`Installing ${packageSpec}...`);
    const { stdout } = await execAsync(`npm install ${packageSpec}`, { cwd: versionDir });

    // Determine the actual installed version
    let installedVersion = version;
    if (version === 'latest') {
      const pkgJsonPath = path.join(versionDir, 'node_modules', agentConfig.npmPackage.replace(/^@/, '').split('/')[0], 'package.json');
      // Try to read the actual version from installed package
      try {
        const installedPkgPath = path.join(versionDir, 'node_modules', agentConfig.npmPackage, 'package.json');
        if (fs.existsSync(installedPkgPath)) {
          const installedPkg = JSON.parse(fs.readFileSync(installedPkgPath, 'utf-8'));
          installedVersion = installedPkg.version;

          // Rename the directory to the actual version
          if (installedVersion !== 'latest') {
            const actualVersionDir = getVersionDir(agent, installedVersion);
            if (!fs.existsSync(actualVersionDir)) {
              fs.renameSync(versionDir, actualVersionDir);
            } else {
              // Already exists, remove the 'latest' dir
              fs.rmSync(versionDir, { recursive: true, force: true });
            }
          }
        }
      } catch {
        // Keep as 'latest' if we can't determine version
      }
    }

    // Set as default if first install
    if (!getGlobalDefault(agent)) {
      setGlobalDefault(agent, installedVersion);
    }

    return { success: true, installedVersion };
  } catch (err) {
    // Clean up on failure
    if (fs.existsSync(versionDir)) {
      fs.rmSync(versionDir, { recursive: true, force: true });
    }
    return { success: false, installedVersion: version, error: (err as Error).message };
  }
}

/**
 * Remove a specific version of an agent.
 */
export function removeVersion(agent: AgentId, version: string): boolean {
  const versionDir = getVersionDir(agent, version);

  if (!fs.existsSync(versionDir)) {
    return false;
  }

  fs.rmSync(versionDir, { recursive: true, force: true });

  // Update default if it was removed
  if (getGlobalDefault(agent) === version) {
    const remaining = listInstalledVersions(agent);
    const newDefault = remaining.length > 0 ? remaining[remaining.length - 1] : null;
    if (newDefault) {
      setGlobalDefault(agent, newDefault);
    } else {
      // Clear the default
      const meta = readMeta();
      if (meta.agents?.[agent]) {
        delete meta.agents[agent];
        writeMeta(meta);
      }
    }
  }

  return true;
}

/**
 * Remove all versions of an agent.
 */
export function removeAllVersions(agent: AgentId): number {
  const versions = listInstalledVersions(agent);
  let removed = 0;

  for (const version of versions) {
    if (removeVersion(agent, version)) {
      removed++;
    }
  }

  // Clean up the agent directory
  const agentDir = path.join(getVersionsDir(), agent);
  if (fs.existsSync(agentDir)) {
    fs.rmSync(agentDir, { recursive: true, force: true });
  }

  return removed;
}

/**
 * Get the resolved version for an agent in the current context.
 * Checks project manifest first, then global default.
 */
export function resolveVersion(agent: AgentId, projectPath?: string): string | null {
  // Check project manifest
  if (projectPath) {
    const version = getProjectVersion(agent, projectPath);
    if (version) {
      return version;
    }
  }

  // Fall back to global default
  return getGlobalDefault(agent);
}

/**
 * Get version specified in project manifest.
 */
export function getProjectVersion(agent: AgentId, startPath: string): string | null {
  let dir = path.resolve(startPath);

  while (dir !== path.dirname(dir)) {
    const manifestPath = path.join(dir, '.agents', 'agents.yaml');
    if (fs.existsSync(manifestPath)) {
      try {
        const content = fs.readFileSync(manifestPath, 'utf-8');
        // Simple YAML parsing for agents section (flat format: claude: "1.5.0")
        const agentMatch = content.match(new RegExp(`^\\s+${agent}:\\s*['"]?([^'"\n]+)['"]?`, 'm'));
        if (agentMatch) {
          return agentMatch[1].trim();
        }
      } catch {
        // Ignore parsing errors
      }
    }
    dir = path.dirname(dir);
  }

  return null;
}

/**
 * Compare semver versions for sorting.
 */
export function compareVersions(a: string, b: string): number {
  const aParts = a.split('.').map((n) => parseInt(n, 10) || 0);
  const bParts = b.split('.').map((n) => parseInt(n, 10) || 0);

  for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
    const aVal = aParts[i] || 0;
    const bVal = bParts[i] || 0;
    if (aVal !== bVal) {
      return aVal - bVal;
    }
  }

  return 0;
}

/**
 * Get actual version from an installed 'latest' directory.
 */
export async function getInstalledVersion(agent: AgentId, version: string): Promise<string | null> {
  const binaryPath = getBinaryPath(agent, version);
  if (!fs.existsSync(binaryPath)) {
    return null;
  }

  try {
    const { stdout } = await execAsync(`${binaryPath} --version`);
    const match = stdout.match(/(\d+\.\d+\.\d+)/);
    return match ? match[1] : version;
  } catch {
    return version;
  }
}

export interface SyncResult {
  commands: boolean;
  skills: boolean;
  hooks: boolean;
  memory: string[];
}

/**
 * Sync central resources (~/.agents/) into a specific version's config directory.
 * Creates symlinks from central storage into {versionHome}/.{agent}/.
 *
 * For Gemini: commands are converted from markdown to TOML and copied instead of symlinked.
 */
export function syncResourcesToVersion(agent: AgentId, version: string): SyncResult {
  const agentConfig = AGENTS[agent];
  const versionHome = getVersionHomePath(agent, version);
  const agentDir = path.join(versionHome, `.${agent}`);
  fs.mkdirSync(agentDir, { recursive: true });

  const result: SyncResult = { commands: false, skills: false, hooks: false, memory: [] };

  // Helper: remove a path (symlink or real) if it exists
  const removePath = (p: string) => {
    try {
      const stat = fs.lstatSync(p);
      if (stat.isSymbolicLink() || stat.isFile()) {
        fs.unlinkSync(p);
      } else if (stat.isDirectory()) {
        fs.rmSync(p, { recursive: true, force: true });
      }
    } catch {}
  };

  // Symlink commands
  const centralCommands = getCommandsDir();
  const commandsTarget = path.join(agentDir, agentConfig.commandsSubdir);
  if (fs.existsSync(centralCommands)) {
    removePath(commandsTarget);

    if (agentConfig.format === 'toml') {
      // Gemini: convert markdown commands to TOML and copy
      fs.mkdirSync(commandsTarget, { recursive: true });
      const files = fs.readdirSync(centralCommands).filter((f) => f.endsWith('.md'));
      for (const file of files) {
        const name = file.replace(/\.md$/, '');
        const content = fs.readFileSync(path.join(centralCommands, file), 'utf-8');
        const tomlContent = markdownToToml(name, content);
        fs.writeFileSync(path.join(commandsTarget, `${name}.toml`), tomlContent);
      }
      result.commands = files.length > 0;
    } else {
      // Other agents: symlink the entire directory
      try {
        fs.symlinkSync(centralCommands, commandsTarget);
        result.commands = true;
      } catch {}
    }
  }

  // Symlink skills
  const centralSkills = getSkillsDir();
  const skillsTarget = path.join(agentDir, 'skills');
  if (fs.existsSync(centralSkills)) {
    removePath(skillsTarget);
    try {
      fs.symlinkSync(centralSkills, skillsTarget);
      result.skills = true;
    } catch {}
  }

  // Symlink hooks (if agent supports them)
  if (agentConfig.supportsHooks) {
    const centralHooks = getHooksDir();
    const hooksTarget = path.join(agentDir, 'hooks');
    if (fs.existsSync(centralHooks)) {
      removePath(hooksTarget);
      try {
        fs.symlinkSync(centralHooks, hooksTarget);
        result.hooks = true;
      } catch {}
    }
  }

  // Symlink memory files
  const centralMemory = getMemoryDir();
  if (fs.existsSync(centralMemory)) {
    const memoryFiles = fs.readdirSync(centralMemory).filter((f) => f.endsWith('.md'));
    for (const file of memoryFiles) {
      const sourcePath = path.join(centralMemory, file);
      // AGENTS.md gets renamed to the agent's instructionsFile name
      const targetName = file === 'AGENTS.md' ? agentConfig.instructionsFile : file;
      const targetPath = path.join(agentDir, targetName);

      removePath(targetPath);
      try {
        fs.symlinkSync(sourcePath, targetPath);
        result.memory.push(targetName);
      } catch {}
    }
  }

  return result;
}
