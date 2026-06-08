#!/usr/bin/env node
// Runs after npm install -g @phnx-labs/agents-cli
// Sets up shims directory and prints PATH instructions.
// Set AGENTS_INIT_SHELL=1 to opt in to automatic shell-rc mutation.

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const HOME = os.homedir();
const USER_DIR = path.join(HOME, '.agents');
const SHIMS_DIR = path.join(USER_DIR, '.cache', 'shims');
// System repo lives inside the user repo (folded in v1.21). Legacy installs at
// ~/.agents-system/ are migrated by src/lib/migrate.ts on first CLI invocation.
const SYSTEM_DIR = path.join(USER_DIR, '.system');
const AGENTS_BIN = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const INSTALL_HELPER_SCRIPT = fileURLToPath(new URL('./install-helper.js', import.meta.url));

function installKeychainHelper() {
  if (process.platform !== 'darwin') return;
  if (!fs.existsSync(INSTALL_HELPER_SCRIPT)) return;
  // Sub-process so a hard failure (codesign / spctl missing on a weird host)
  // can't take down the rest of postinstall. install-helper.js stays silent
  // on no-op and emits one stdout line on success.
  spawnSync(process.execPath, [INSTALL_HELPER_SCRIPT], { stdio: 'inherit' });
}

function shellQuote(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// For local installs, create directories and show a message
const isGlobalInstall = process.env.npm_config_global || process.argv.includes('-g');
if (!isGlobalInstall) {
  // Still create user directories for local installs
  fs.mkdirSync(USER_DIR, { recursive: true, mode: 0o700 });
  installKeychainHelper();
  console.log(`
agents-cli installed locally.
To complete setup, run: npx agents setup
`);
  process.exit(0);
}

// Create directories. The full migration (legacy ~/.agents-system/ fold,
// runtime-state bucket moves, etc.) runs from src/lib/migrate.ts on the first
// CLI invocation — we don't duplicate it here.
//
// SYSTEM_DIR is intentionally NOT pre-created: if a legacy ~/.agents-system/
// exists, the migrator's fast-path rename needs SYSTEM_DIR to be absent so it
// can move the legacy tree in one shot (including .git). Pre-creating an empty
// skeleton forces the slower merge path AND can leave the new dir without
// `.git`, which makes ensureInitialized() exit "not set up" before the
// migrator runs. The migrator + first `agents setup` create SYSTEM_DIR as
// needed.
fs.mkdirSync(USER_DIR, { recursive: true, mode: 0o700 });
fs.mkdirSync(SHIMS_DIR, { recursive: true });

// Copy the signed macOS Keychain helper to a stable user path so its trusted-app
// ACLs survive future npm publishes (which re-sign the bundle).
installKeychainHelper();

const shellName = path.basename(process.env.SHELL || '/bin/bash');

function getShellRc() {
  switch (shellName) {
    case 'zsh':
      return path.join(HOME, '.zshrc');
    case 'fish':
      return path.join(HOME, '.config', 'fish', 'config.fish');
    case 'bash':
      const bashProfile = path.join(HOME, '.bash_profile');
      if (fs.existsSync(bashProfile)) {
        return bashProfile;
      }
      return path.join(HOME, '.bashrc');
    default:
      return path.join(HOME, '.profile');
  }
}

const exportLine = shellName === 'fish'
  ? `fish_add_path ${SHIMS_DIR}`
  : `export PATH="${SHIMS_DIR}:$PATH"`;

// Shorthands that delegate to the installed agents-cli entrypoint.
const ALIASES = ['sessions', 'secrets', 'browser', 'pty', 'teams'];

function writeAliasShims() {
  const written = [];
  for (const name of ALIASES) {
    const target = path.join(SHIMS_DIR, name);
    const script = `#!/bin/sh\nAGENTS_BIN=${shellQuote(AGENTS_BIN)}\nif [ -z "$AGENTS_BIN" ] || [ ! -x "$AGENTS_BIN" ]; then\n  echo "agents: agents-cli entrypoint missing or not executable: $AGENTS_BIN" >&2\n  exit 127\nfi\nexec "$AGENTS_BIN" ${name} "$@"\n`;
    fs.writeFileSync(target, script, { mode: 0o755 });
    written.push(name);
  }
  return written;
}

function getVersion() {
  const pkgPath = new URL('../package.json', import.meta.url).pathname;
  try {
    return JSON.parse(fs.readFileSync(pkgPath, 'utf-8')).version;
  } catch { return null; }
}

function getChangelogSection(version) {
  const changelogPath = new URL('../CHANGELOG.md', import.meta.url).pathname;
  if (!fs.existsSync(changelogPath)) return null;
  const lines = fs.readFileSync(changelogPath, 'utf-8').split('\n');
  let inSection = false;
  const section = [];
  for (const line of lines) {
    if (line.startsWith(`## ${version}`)) { inSection = true; continue; }
    if (inSection && line.startsWith('## ')) break;
    if (inSection) section.push(line);
  }
  return section.length ? section.join('\n').trim() : null;
}

function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function isAlreadyConfigured(rcFile) {
  if (!fs.existsSync(rcFile)) return false;
  const content = fs.readFileSync(rcFile, 'utf-8');
  // Accept either the new path or the legacy ~/.agents-system/shims path
  return content.includes('.agents/.cache/shims') || content.includes('.agents-system/shims');
}

async function main() {
  // Opt-in: AGENTS_INIT_SHELL=1 npm install -g @phnx-labs/agents-cli
  if (process.env.AGENTS_INIT_SHELL === '1') {
    const rcFile = getShellRc();
    if (!isAlreadyConfigured(rcFile)) {
      const addition = `\n# agents-cli: version switching for AI coding agents\n${exportLine}\n`;
      fs.mkdirSync(path.dirname(rcFile), { recursive: true });
      fs.appendFileSync(rcFile, addition);
      console.log(`\n  Added ${SHIMS_DIR} to PATH in ${path.basename(rcFile)}`);
      console.log(`  Restart your shell to enable version switching\n`);
    }
    writeAliasShims();
    console.log(`  Installed bare-command aliases: ${ALIASES.join(', ')}\n`);
  } else {
    // Default: offer to auto-add shims to PATH (like homebrew does)
    const rcFile = getShellRc();

    console.log(`\nagents-cli installed.`);

    if (!isAlreadyConfigured(rcFile) && process.stdin.isTTY && process.stdout.isTTY) {
      const answer = await ask(`\nAdd shims to PATH in ~/${path.basename(rcFile)}? [Y/n] `);
      if (answer === '' || answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes') {
        const addition = `\n# agents-cli: version switching for AI coding agents\n${exportLine}\n`;
        fs.mkdirSync(path.dirname(rcFile), { recursive: true });
        fs.appendFileSync(rcFile, addition);
        console.log(`\n  Added ${SHIMS_DIR} to PATH in ${path.basename(rcFile)}`);
        console.log(`  Restart your shell or run: source ~/${path.basename(rcFile)}\n`);
      } else {
        console.log(`
To enable version-aware shims, add this to your shell config:

  ${exportLine}
`);
      }
    } else if (!isAlreadyConfigured(rcFile)) {
      console.log(`
To enable version-aware shims, add this to your shell config:

  ${exportLine}
`);
    }

    const written = writeAliasShims();
    console.log(`  Installed shorthands: ${written.join(', ')}`);
  }

  const version = getVersion();
  if (version) {
    const section = getChangelogSection(version);
    if (section) {
      console.log(`\nWhat's new in ${version}:\n`);
      console.log(section);
      console.log('');
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(0);
});
