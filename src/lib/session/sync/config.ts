/**
 * Configuration for cross-machine session sync: R2 credentials and this
 * machine's stable identity. Credentials come from the `r2.backups` secrets
 * bundle (OS keychain on macOS, libsecret on Linux) — never from env or disk.
 */

import * as os from 'os';
import { readAndResolveBundleEnv } from '../../secrets/bundles.js';

/** Secrets bundle holding the R2 credentials. */
export const SYNC_BUNDLE = 'r2.backups';

export interface R2Config {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** S3-compatible endpoint for the account (no bucket, no trailing slash). */
  endpoint: string;
}

/**
 * Resolve R2 credentials from the `r2.backups` bundle. Throws a clear,
 * actionable error if the bundle or any key is missing — sync cannot proceed
 * without real credentials (no silent fallback).
 */
export function loadR2Config(): R2Config {
  const { env } = readAndResolveBundleEnv(SYNC_BUNDLE, { caller: 'sessions-sync' });
  const accountId = env.R2_ACCOUNT_ID?.trim();
  const bucket = env.R2_BUCKET_NAME?.trim();
  const accessKeyId = env.R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY?.trim();

  const missing = [
    !accountId && 'R2_ACCOUNT_ID',
    !bucket && 'R2_BUCKET_NAME',
    !accessKeyId && 'R2_ACCESS_KEY_ID',
    !secretAccessKey && 'R2_SECRET_ACCESS_KEY',
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new Error(
      `Sessions sync: bundle '${SYNC_BUNDLE}' is missing ${missing.join(', ')}. ` +
      `Add them with: agents secrets add ${SYNC_BUNDLE} <KEY>`,
    );
  }

  return {
    accountId: accountId!,
    bucket: bucket!,
    accessKeyId: accessKeyId!,
    secretAccessKey: secretAccessKey!,
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
  };
}

/** True when the sync bundle exists and looks resolvable, without throwing. */
export function isSyncConfigured(): boolean {
  try {
    loadR2Config();
    return true;
  } catch {
    return false;
  }
}

/**
 * This machine's stable, human-readable id, used as its R2 prefix and mirror
 * directory name. Tailnet hostnames (zion, yosemite-s0, mac-mini) are already
 * unique and readable; we lowercase and strip any domain suffix. Overridable
 * via AGENTS_SYNC_MACHINE_ID for tests and unusual setups.
 */
export function machineId(): string {
  const raw = process.env.AGENTS_SYNC_MACHINE_ID || os.hostname();
  return raw.split('.')[0].trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-') || 'unknown';
}
