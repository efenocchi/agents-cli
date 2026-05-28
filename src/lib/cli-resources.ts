/**
 * CLI tool resources — declarative manifests for command-line binaries the user
 * wants installed on the host (e.g. higgsfield, gh, glab).
 *
 * A CLI resource is a YAML file under <repo>/cli/<name>.yaml. Resolution follows
 * the same project > user > system > extra-repo precedence as other resources,
 * but unlike skills/commands/hooks, CLI resources are NOT copied into per-agent
 * version homes — they install binaries onto the host PATH. The relationship is
 * "Brewfile-style": declare once in ~/.agents/cli/, install on any new machine.
 */
import * as fs from 'fs';
import * as path from 'path';
import { execSync, spawnSync } from 'child_process';
import * as yaml from 'yaml';
import { listResources, resolveResource } from './resources.js';

// ─── Schema ──────────────────────────────────────────────────────────────────

/** A single install method. Exactly one of the keys (npm/brew/script/binary) is set. */
export type InstallMethod =
  | { npm: string }
  | { brew: string }
  | { script: string }
  | { binary: BinarySpec };

/** Per-platform binary download spec. Keys are `<os>-<arch>` (e.g. darwin-arm64). */
export interface BinarySpec {
  [platform: string]: {
    url: string;
    /** Path inside the archive (relative). Required when url is a .tar.gz/.zip. */
    extract?: string;
  };
}

/** Parsed CLI manifest. */
export interface CliManifest {
  /** Name as it appears on the command line (e.g. "higgsfield"). */
  name: string;
  /** One-line summary shown in `agents cli list`. */
  description?: string;
  /** Project homepage; used in detail view + post-install messaging. */
  homepage?: string;
  /** Command run to verify the binary is installed (default: "<name> --version"). */
  check: string;
  /** Install methods tried in order; first one whose tool is available is used. */
  install: InstallMethod[];
  /** Message printed after successful install — typically auth instructions. */
  postInstall?: string;
  /** Origin layer this manifest was resolved from. */
  source: string;
  /** Absolute path to the yaml file. */
  path: string;
}

/** A validation problem in a CLI manifest. */
export interface CliManifestError {
  /** Filename that failed to parse. */
  file: string;
  /** Human-readable reason. */
  reason: string;
}

// ─── Parsing ─────────────────────────────────────────────────────────────────

/**
 * Parse a single CLI manifest from its YAML contents.
 * Returns a manifest on success; throws on schema violations so callers can
 * decide whether to surface or swallow the error per file.
 */
export function parseCliManifest(
  contents: string,
  opts: { name: string; source: string; path: string },
): CliManifest {
  const raw = yaml.parse(contents);
  if (!raw || typeof raw !== 'object') {
    throw new Error('manifest must be a YAML object');
  }

  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : opts.name;
  const description = typeof raw.description === 'string' ? raw.description : undefined;
  const homepage = typeof raw.homepage === 'string' ? raw.homepage : undefined;
  const check = typeof raw.check === 'string' && raw.check.trim()
    ? raw.check.trim()
    : `${name} --version`;
  const postInstall = typeof raw.post_install === 'string' ? raw.post_install : undefined;

  if (!Array.isArray(raw.install) || raw.install.length === 0) {
    throw new Error('install must be a non-empty list of methods');
  }

  const install: InstallMethod[] = raw.install.map((entry: unknown, i: number) => {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`install[${i}] must be an object with one of: npm, brew, script, binary`);
    }
    const e = entry as Record<string, unknown>;
    const keys = Object.keys(e).filter((k) => e[k] !== undefined && e[k] !== null);
    if (keys.length !== 1) {
      throw new Error(`install[${i}] must declare exactly one method (got: ${keys.join(', ') || 'none'})`);
    }
    const key = keys[0];
    const value = e[key];
    if (key === 'npm' || key === 'brew' || key === 'script') {
      if (typeof value !== 'string' || !value.trim()) {
        throw new Error(`install[${i}].${key} must be a non-empty string`);
      }
      return { [key]: value.trim() } as InstallMethod;
    }
    if (key === 'binary') {
      if (!value || typeof value !== 'object') {
        throw new Error(`install[${i}].binary must be a platform map`);
      }
      const binary: BinarySpec = {};
      for (const [platform, spec] of Object.entries(value as Record<string, unknown>)) {
        if (!spec || typeof spec !== 'object') {
          throw new Error(`install[${i}].binary.${platform} must be an object with a url`);
        }
        const s = spec as Record<string, unknown>;
        if (typeof s.url !== 'string' || !s.url.trim()) {
          throw new Error(`install[${i}].binary.${platform}.url must be a non-empty string`);
        }
        binary[platform] = {
          url: s.url.trim(),
          extract: typeof s.extract === 'string' ? s.extract : undefined,
        };
      }
      return { binary };
    }
    throw new Error(`install[${i}] has unknown method "${key}" (expected: npm, brew, script, binary)`);
  });

  return {
    name,
    description,
    homepage,
    check,
    install,
    postInstall,
    source: opts.source,
    path: opts.path,
  };
}

/**
 * Discover all CLI manifests resolvable from the current cwd. Returns valid
 * manifests and any parse errors separately so the CLI can show both.
 */
export function listCliManifests(cwd?: string): {
  manifests: CliManifest[];
  errors: CliManifestError[];
} {
  const resolved = listResources('cli', cwd);
  const manifests: CliManifest[] = [];
  const errors: CliManifestError[] = [];

  for (const entry of resolved) {
    if (!entry.path.endsWith('.yaml') && !entry.path.endsWith('.yml')) continue;
    try {
      const contents = fs.readFileSync(entry.path, 'utf-8');
      const manifest = parseCliManifest(contents, {
        name: entry.name,
        source: entry.source,
        path: entry.path,
      });
      manifests.push(manifest);
    } catch (err) {
      errors.push({ file: entry.path, reason: (err as Error).message });
    }
  }

  return { manifests, errors };
}

/** Resolve a single CLI manifest by name. Returns null when not declared. */
export function resolveCliManifest(name: string, cwd?: string): CliManifest | null {
  const resolved = resolveResource('cli', name, cwd);
  if (!resolved) return null;
  if (!resolved.path.endsWith('.yaml') && !resolved.path.endsWith('.yml')) return null;
  const contents = fs.readFileSync(resolved.path, 'utf-8');
  return parseCliManifest(contents, {
    name: resolved.name,
    source: resolved.source,
    path: resolved.path,
  });
}

// ─── Host detection ──────────────────────────────────────────────────────────

/**
 * Return true if a command resolves on the current PATH. Uses `which` on
 * POSIX hosts; results are cached for the lifetime of the process.
 */
const cmdExistsCache = new Map<string, boolean>();
export function hasCommand(cmd: string): boolean {
  if (cmdExistsCache.has(cmd)) return cmdExistsCache.get(cmd)!;
  const result = spawnSync('command', ['-v', cmd], { shell: true, stdio: 'ignore' });
  const ok = result.status === 0;
  cmdExistsCache.set(cmd, ok);
  return ok;
}

/** Run the manifest's `check` command. Returns true when it exits 0. */
export function isCliInstalled(manifest: CliManifest): boolean {
  const result = spawnSync(manifest.check, {
    shell: true,
    stdio: 'ignore',
    timeout: 10_000,
  });
  return result.status === 0;
}

// ─── Method selection ────────────────────────────────────────────────────────

/**
 * Pick the first install method whose required host tool is available.
 * Returns null when none of the declared methods can run on this host.
 */
export function selectInstallMethod(manifest: CliManifest): InstallMethod | null {
  for (const method of manifest.install) {
    if ('npm' in method && hasCommand('npm')) return method;
    if ('brew' in method && hasCommand('brew')) return method;
    if ('script' in method && (hasCommand('curl') || hasCommand('wget'))) return method;
    if ('binary' in method) {
      const key = `${process.platform}-${process.arch}`;
      if (method.binary[key]) return method;
    }
  }
  return null;
}

/** Short description of a method for display. */
export function describeMethod(method: InstallMethod): string {
  if ('npm' in method) return `npm install -g ${method.npm}`;
  if ('brew' in method) return `brew install ${method.brew}`;
  if ('script' in method) return `curl ${method.script} | sh`;
  const key = `${process.platform}-${process.arch}`;
  const spec = method.binary[key];
  return spec ? `download ${spec.url}` : 'binary download';
}

// ─── Install ─────────────────────────────────────────────────────────────────

export interface InstallResult {
  manifest: CliManifest;
  /** Method that was attempted (null if no compatible method existed). */
  method: InstallMethod | null;
  /** True when the post-install `check` passed. */
  installed: boolean;
  /** stdout/stderr captured from the install command, for surfacing on failure. */
  output?: string;
  /** Set when the install runner threw or exited non-zero. */
  error?: string;
}

/**
 * Install a single CLI by running its first compatible method. Streams the
 * underlying command's output to the parent terminal so users see brew/npm
 * progress live. Verifies success by re-running `check`.
 */
export function installCli(
  manifest: CliManifest,
  opts: { dryRun?: boolean } = {},
): InstallResult {
  const method = selectInstallMethod(manifest);
  if (!method) {
    return {
      manifest,
      method: null,
      installed: false,
      error: `No compatible install method for this host (${process.platform}-${process.arch}). Declared methods: ${manifest.install.map(describeMethod).join('; ')}`,
    };
  }

  if (opts.dryRun) {
    return { manifest, method, installed: false, output: `[dry-run] would run: ${describeMethod(method)}` };
  }

  const cmd = buildInstallCommand(method);
  try {
    execSync(cmd, { stdio: 'inherit' });
  } catch (err) {
    return {
      manifest,
      method,
      installed: false,
      error: `install command failed: ${(err as Error).message}`,
    };
  }

  // Re-check; many installers exit 0 but leave the binary off PATH for the
  // current shell (e.g. brew on a fresh install). Trust `check`, not the
  // installer's exit code.
  cmdExistsCache.delete(manifest.name);
  const installed = isCliInstalled(manifest);
  return { manifest, method, installed };
}

/**
 * Map a declarative method to a shell command. Centralized so tests and dry-run
 * surface the exact string that would execute.
 */
export function buildInstallCommand(method: InstallMethod): string {
  if ('npm' in method) return `npm install -g ${method.npm}`;
  if ('brew' in method) return `brew install ${method.brew}`;
  if ('script' in method) {
    // Prefer curl when both are present; fall back to wget.
    return hasCommand('curl')
      ? `curl -fsSL ${method.script} | sh`
      : `wget -qO- ${method.script} | sh`;
  }
  const key = `${process.platform}-${process.arch}`;
  const spec = method.binary[key];
  // The downloader is intentionally minimal — binary install is mostly used
  // for pre-built tarballs whose extract path varies per project. We expect
  // the manifest author to document any post-download steps in post_install.
  return spec.extract
    ? `curl -fsSL ${spec.url} -o /tmp/agents-cli-bin.tgz && tar -xzf /tmp/agents-cli-bin.tgz -C /usr/local/bin ${spec.extract}`
    : `curl -fsSL ${spec.url} -o /usr/local/bin/agents-cli-downloaded`;
}

// ─── Status snapshot ─────────────────────────────────────────────────────────

export interface CliStatus {
  manifest: CliManifest;
  installed: boolean;
}

/** Convenience: list all manifests + their installed-on-host status. */
export function listCliStatus(cwd?: string): {
  statuses: CliStatus[];
  errors: CliManifestError[];
} {
  const { manifests, errors } = listCliManifests(cwd);
  const statuses = manifests.map((manifest) => ({
    manifest,
    installed: isCliInstalled(manifest),
  }));
  return { statuses, errors };
}

/** Names of CLIs that are declared but not currently installed on the host. */
export function getMissingClis(cwd?: string): CliManifest[] {
  return listCliStatus(cwd).statuses.filter((s) => !s.installed).map((s) => s.manifest);
}
