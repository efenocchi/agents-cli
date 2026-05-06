/**
 * macOS Keychain integration for secure credential storage.
 *
 * Calls a compiled Swift helper (keychain-helper.swift) to store and retrieve
 * API keys and tokens via the Security framework, with kSecAttrSynchronizable
 * set so iCloud Keychain syncs them across the user's Macs.
 */

import { fileURLToPath } from 'url';
import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

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

// Resolve the bundled, signed-and-notarized AgentsKeychain.app shipped
// alongside the compiled JS. The .app embeds a provisioning profile that
// grants the application-identifier + keychain-access-groups entitlements
// macOS requires for kSecAttrSynchronizable writes. Bare CLI binaries
// (ad-hoc or Developer ID) cannot do this; only an .app with an embedded
// profile can. So compile-on-first-use is not possible — the binary must
// be prebuilt by `scripts/build-keychain-helper.sh` and shipped.
function ensureKeychainHelper(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const binPath = path.join(here, 'AgentsKeychain.app', 'Contents', 'MacOS', 'AgentsKeychain');
  if (!fs.existsSync(binPath)) {
    throw new Error(
      `iCloud Keychain helper missing at ${binPath}. ` +
      'This npm package was built without the signed helper bundle. ' +
      'Reinstall agents-cli, or create the bundle without --icloud-sync to use device-local storage.'
    );
  }
  return binPath;
}

// iCloud Keychain sync is opt-in per bundle. When sync=true we route through
// the Swift helper (kSecAttrSynchronizable=true). When sync is false/undefined
// we use /usr/bin/security, which is always present on macOS — so a user who
// never opts in to iCloud sync never needs Xcode Command Line Tools.

/** Check if a keychain item exists (macOS only). */
export function hasKeychainToken(item: string, sync = false): boolean {
  assertMacOS();
  if (sync) {
    const bin = ensureKeychainHelper();
    return spawnSync(bin, ['has', item, os.userInfo().username], {
      stdio: ['ignore', 'pipe', 'pipe'],
    }).status === 0;
  }
  return spawnSync('security', ['find-generic-password', '-a', os.userInfo().username, '-s', item, '-w'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  }).status === 0;
}

/** Retrieve a secret value from the macOS Keychain. Throws if not found. */
export function getKeychainToken(item: string, sync = false): string {
  assertMacOS();
  if (sync) {
    const bin = ensureKeychainHelper();
    const result = spawnSync(bin, ['get', item, os.userInfo().username], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.status === 1) throw new Error(`Keychain item '${item}' not found.`);
    if (result.status !== 0) {
      const msg = result.stderr?.toString().trim();
      throw new Error(msg || `Failed to read keychain item '${item}'.`);
    }
    const token = result.stdout?.toString().trim();
    if (!token) throw new Error(`Keychain item '${item}' exists but is empty.`);
    return token;
  }
  const result = spawnSync('security', ['find-generic-password', '-a', os.userInfo().username, '-s', item, '-w'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status === 44) throw new Error(`Keychain item '${item}' not found.`);
  if (result.status !== 0) {
    const stderr = result.stderr?.toString() || '';
    if (/could not be found/i.test(stderr)) throw new Error(`Keychain item '${item}' not found.`);
    throw new Error(`Failed to read keychain item '${item}': ${stderr.trim() || `exit ${result.status}`}`);
  }
  const token = result.stdout?.toString().trim();
  if (!token) throw new Error(`Keychain item '${item}' exists but is empty.`);
  return token;
}

/** Store or update a secret value in the macOS Keychain. iCloud-synced when sync=true. */
export function setKeychainToken(item: string, value: string, sync = false): void {
  assertMacOS();
  if (!value || !value.trim()) throw new Error('Secret value is empty.');
  if (/[\r\n]/.test(value)) throw new Error('Secret value contains newlines, which are not supported.');

  if (sync) {
    const bin = ensureKeychainHelper();
    const result = spawnSync(bin, ['set', item, os.userInfo().username], {
      input: value,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (result.status !== 0) {
      const msg = result.stderr?.toString().trim();
      throw new Error(msg || `Failed to write keychain item '${item}'.`);
    }
    return;
  }
  // The `security -i` interactive form keeps the value out of argv (and `ps`).
  const user = os.userInfo().username;
  const cmd = `add-generic-password -a ${quoteForSecurityCli(user)} -s ${quoteForSecurityCli(item)} -w ${quoteForSecurityCli(value)} -U\n`;
  const result = spawnSync('security', ['-i'], {
    input: cmd,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    throw new Error(`Failed to write keychain item '${item}' (exit ${result.status}).`);
  }
}

/** Delete a keychain item. Returns true if it existed. */
export function deleteKeychainToken(item: string, sync = false): boolean {
  assertMacOS();
  if (sync) {
    const bin = ensureKeychainHelper();
    return spawnSync(bin, ['delete', item, os.userInfo().username], {
      stdio: ['ignore', 'pipe', 'pipe'],
    }).status === 0;
  }
  return spawnSync('security', ['delete-generic-password', '-a', os.userInfo().username, '-s', item], {
    stdio: ['ignore', 'pipe', 'pipe'],
  }).status === 0;
}

// Quote a value for `security -i`'s shell-like tokenizer so it stays out of argv.
function quoteForSecurityCli(s: string): string {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

/** Options controlling how secret refs are resolved. */
export interface ResolveOptions {
  /** Translate a short keychain ID to a fully namespaced item name. */
  keychainItemFor?: (shortId: string) => string;
  /** Allow exec: refs. When false (default), exec refs throw. */
  allowExec?: boolean;
  /** Restrict env: refs to this allowlist. When undefined, any env var may be read. */
  envAllowlist?: string[];
  /** Read keychain refs from the iCloud-synced keychain backend. */
  iCloudSync?: boolean;
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
      return getKeychainToken(item, opts.iCloudSync);
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
