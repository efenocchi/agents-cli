/**
 * macOS Keychain integration for secure credential storage.
 *
 * Wraps the `security` command to store and retrieve API keys and tokens
 * in the system keychain rather than environment variables or plaintext files.
 */

import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getSystemAgentsDir } from './state.js';

const SERVICE_PREFIX = 'agents-cli';

/** Supported secret resolution backends. */
export type SecretProvider = 'keychain' | 'env' | 'file' | 'exec';

/** A typed reference to a secret, consisting of a provider and a provider-specific value. */
export interface SecretRef {
  provider: SecretProvider;
  value: string;
}

const REF_PATTERN = /^(keychain|env|file|exec):(.+)$/s;

/**
 * A bundle YAML value: either a string (literal or provider-prefixed ref) or
 * an object `{value: string}` used to escape a literal that would otherwise
 * be parsed as a ref (e.g. a URL that happens to start with 'env:').
 */
export type BundleValue = string | { value: string };

/** Parse a bundle YAML value into either a literal string or a typed secret ref. */
export function parseBundleValue(raw: BundleValue): { literal: string } | { ref: SecretRef } {
  if (typeof raw === 'object' && raw !== null && typeof (raw as any).value === 'string') {
    return { literal: (raw as { value: string }).value };
  }
  if (typeof raw !== 'string') {
    throw new Error(`Invalid bundle value (expected string or {value: string}): ${JSON.stringify(raw)}`);
  }
  const match = REF_PATTERN.exec(raw);
  if (!match) return { literal: raw };
  return { ref: { provider: match[1] as SecretProvider, value: match[2] } };
}

/** Serialize a secret ref back to its `provider:value` string form. */
export function serializeRef(ref: SecretRef): string {
  return `${ref.provider}:${ref.value}`;
}

function assertMacOS(): void {
  if (process.platform !== 'darwin') {
    throw new Error('Keychain-based secrets require macOS. On Linux, use environment variables or .env files instead. Native Linux credential store support is planned.');
  }
}

/** Build the keychain item name for a profile provider token. */
export function profileKeychainItem(provider: string): string {
  return `${SERVICE_PREFIX}.${provider}.token`;
}

/** Build the keychain item name for a secrets-bundle key. */
export function secretsKeychainItem(bundle: string, key: string): string {
  return `${SERVICE_PREFIX}.secrets.${bundle}.${key}`;
}

// Compile the Swift keychain helper on first use and cache it by source hash.
// The binary lives at ~/.agents-system/bin/agents-keychain-<hash> so a new
// version of the source triggers a recompile without invalidating the old one
// until the new binary is ready.
function ensureKeychainHelper(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const sourcePath = path.join(here, 'keychain-helper.swift');
  const sourceContent = fs.readFileSync(sourcePath);
  const hash = createHash('sha256').update(sourceContent).digest('hex').slice(0, 8);

  const binDir = path.join(getSystemAgentsDir(), 'bin');
  const binName = `agents-keychain-${hash}`;
  const binPath = path.join(binDir, binName);

  if (fs.existsSync(binPath)) return binPath;

  const swiftcCheck = spawnSync('swiftc', ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
  if (swiftcCheck.error || swiftcCheck.status !== 0) {
    throw new Error(
      'Keychain sync requires Xcode Command Line Tools. Install with: xcode-select --install'
    );
  }

  if (!fs.existsSync(binDir)) fs.mkdirSync(binDir, { recursive: true });

  const compile = spawnSync('swiftc', ['-O', sourcePath, '-o', binPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (compile.status !== 0) {
    const err = compile.stderr?.toString().trim();
    throw new Error(`Failed to compile keychain helper: ${err}`);
  }

  // Remove stale binaries from previous versions
  try {
    for (const f of fs.readdirSync(binDir)) {
      if (f.startsWith('agents-keychain-') && f !== binName) {
        try { fs.unlinkSync(path.join(binDir, f)); } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }

  return binPath;
}

/** Check if a keychain item exists (macOS only). */
export function hasKeychainToken(item: string): boolean {
  assertMacOS();
  const bin = ensureKeychainHelper();
  const result = spawnSync(bin, ['has', item, os.userInfo().username], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return result.status === 0;
}

/** Retrieve a secret value from the macOS Keychain. Throws if not found. */
export function getKeychainToken(item: string): string {
  assertMacOS();
  const bin = ensureKeychainHelper();
  const result = spawnSync(bin, ['get', item, os.userInfo().username], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status === 1) {
    throw new Error(`Keychain item '${item}' not found.`);
  }
  if (result.status !== 0) {
    const msg = result.stderr?.toString().trim();
    throw new Error(msg || `Failed to read keychain item '${item}'.`);
  }
  const token = result.stdout?.toString().trim();
  if (!token) throw new Error(`Keychain item '${item}' exists but is empty.`);
  return token;
}

/** Store or update a secret value in the macOS Keychain, synced via iCloud Keychain. */
export function setKeychainToken(item: string, value: string): void {
  assertMacOS();
  if (!value || !value.trim()) {
    throw new Error('Secret value is empty.');
  }
  if (/[\r\n]/.test(value)) {
    throw new Error('Secret value contains newlines, which are not supported.');
  }
  const bin = ensureKeychainHelper();
  const result = spawnSync(bin, ['set', item, os.userInfo().username], {
    input: value,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    const msg = result.stderr?.toString().trim();
    throw new Error(msg || `Failed to write keychain item '${item}'.`);
  }
}

/** Delete a keychain item. Returns true if it existed. */
export function deleteKeychainToken(item: string): boolean {
  assertMacOS();
  const bin = ensureKeychainHelper();
  const result = spawnSync(bin, ['delete', item, os.userInfo().username], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return result.status === 0;
}

/** Options controlling how secret refs are resolved. */
export interface ResolveOptions {
  /** Translate a short keychain ID to a fully namespaced item name. */
  keychainItemFor?: (shortId: string) => string;
  /** Allow exec: refs. When false (default), exec refs throw. */
  allowExec?: boolean;
  /** Restrict env: refs to this allowlist. When undefined, any env var may be read. */
  envAllowlist?: string[];
}

function expandHome(p: string): string {
  if (p.startsWith('~/') || p === '~') {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

/** Resolve a secret ref to its plaintext value using the appropriate provider. */
export function resolveRef(ref: SecretRef, opts: ResolveOptions = {}): string {
  switch (ref.provider) {
    case 'keychain': {
      const item = opts.keychainItemFor ? opts.keychainItemFor(ref.value) : ref.value;
      return getKeychainToken(item);
    }
    case 'env': {
      const name = ref.value;
      if (opts.envAllowlist && !opts.envAllowlist.includes(name)) {
        throw new Error(`env: ref '${name}' not in allowlist.`);
      }
      const val = process.env[name];
      if (val === undefined) {
        throw new Error(`env: ref '${name}' not set in parent environment.`);
      }
      return val;
    }
    case 'file': {
      const target = expandHome(ref.value);
      if (!fs.existsSync(target)) {
        throw new Error(`file: ref '${ref.value}' does not exist.`);
      }
      return fs.readFileSync(target, 'utf-8').trim();
    }
    case 'exec': {
      if (!opts.allowExec) {
        throw new Error(
          `exec: ref '${ref.value}' blocked. Set 'allow_exec: true' in the bundle to enable.`
        );
      }
      // shell: false — the bundle author controls the command; no injection
      // from secret identifiers. Parse a simple space-separated command.
      const parts = ref.value.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((p) => p.replace(/^"|"$/g, '')) || [];
      if (parts.length === 0) {
        throw new Error(`exec: ref '${ref.value}' is empty.`);
      }
      const [cmd, ...args] = parts;
      try {
        return execFileSync(cmd, args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
      } catch (err: any) {
        throw new Error(`exec: ref '${ref.value}' failed: ${err.message}`);
      }
    }
  }
}
