/**
 * One-shot idempotent migrations for the FOUNDATION refactor.
 *
 * Called from postinstall and as a command-time fallback from agents view/use/pull.
 * Each migration is guarded by an existence check so re-running is safe.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const HOME = os.homedir();
const SYSTEM_DIR = path.join(HOME, '.agents-system');
const USER_DIR = path.join(HOME, '.agents');

/**
 * Move ~/.agents-system/agents.yaml -> ~/.agents/agents.yaml.
 * No-op if user file already exists or system file absent.
 * (This is also handled inline in state.ts readMeta, but is exposed here
 *  for explicit migration calls from postinstall / CLI entry points.)
 */
function migrateAgentsYaml(): void {
  const src = path.join(SYSTEM_DIR, 'agents.yaml');
  const dest = path.join(USER_DIR, 'agents.yaml');
  if (fs.existsSync(dest) || !fs.existsSync(src)) return;
  try {
    fs.mkdirSync(USER_DIR, { recursive: true, mode: 0o700 });
    fs.renameSync(src, dest);
    console.log('Migrated agents.yaml to ~/.agents/');
  } catch { /* best-effort */ }
}

/**
 * Delete ~/.agents-system/prompts.json (dead file — zero refs in src/).
 */
function deleteSystemPromptsJson(): void {
  const f = path.join(SYSTEM_DIR, 'prompts.json');
  if (!fs.existsSync(f)) return;
  try {
    fs.unlinkSync(f);
  } catch { /* best-effort */ }
}

/**
 * Move ~/.agents-system/config.json -> ~/.agents/teams/config.json.
 * The teams persistence layer already reads the legacy path as a fallback;
 * moving it here keeps the canonical location consistent.
 */
function migrateSystemConfigJson(): void {
  const src = path.join(SYSTEM_DIR, 'config.json');
  const dest = path.join(USER_DIR, 'teams', 'config.json');
  if (!fs.existsSync(src) || fs.existsSync(dest)) return;
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
    fs.copyFileSync(src, dest);
    fs.unlinkSync(src);
  } catch { /* best-effort */ }
}

/**
 * Move promptcuts.yaml from each repo root into hooks/ subdir.
 *   ~/.agents-system/promptcuts.yaml -> ~/.agents-system/hooks/promptcuts.yaml
 *   ~/.agents/promptcuts.yaml        -> ~/.agents/hooks/promptcuts.yaml
 * Idempotent: skips if dest already exists or src absent.
 */
function migratePromptcutsIntoHooks(): void {
  for (const root of [SYSTEM_DIR, USER_DIR]) {
    const src = path.join(root, 'promptcuts.yaml');
    const dest = path.join(root, 'hooks', 'promptcuts.yaml');
    if (fs.existsSync(dest) || !fs.existsSync(src)) continue;
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
      fs.renameSync(src, dest);
    } catch { /* best-effort */ }
  }
}

/** Run all idempotent migrations. Safe to call multiple times. */
export function runMigration(): void {
  migrateAgentsYaml();
  deleteSystemPromptsJson();
  migrateSystemConfigJson();
  migratePromptcutsIntoHooks();
}
