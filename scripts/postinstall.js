#!/usr/bin/env node
// Runs after npm install -g @phnx-labs/agents-cli
// Sets up shims directory and prints PATH instructions.
// Set AGENTS_INIT_SHELL=1 to opt in to automatic shell-rc mutation.

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline';

const HOME = os.homedir();
const SHIMS_DIR = path.join(HOME, '.agents', 'shims');
const AGENTS_DIR = path.join(HOME, '.agents');

// Only run for global installs
if (!process.env.npm_config_global && !process.argv.includes('-g')) {
  process.exit(0);
}

// Create directories
fs.mkdirSync(SHIMS_DIR, { recursive: true });
fs.mkdirSync(AGENTS_DIR, { recursive: true });

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

const ALIASES = ['sessions', 'teams'];

function writeAliasShims() {
  const written = [];
  for (const name of ALIASES) {
    const target = path.join(SHIMS_DIR, name);
    const script = `#!/bin/sh\nexec agents ${name} "$@"\n`;
    fs.writeFileSync(target, script, { mode: 0o755 });
    written.push(name);
  }
  return written;
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

async function promptForAliases() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return 'skip';
  console.log(`
Install bare-command aliases for common subcommands?
This creates ${ALIASES.map((n) => `\`${n}\``).join(', ')} as wrappers in ${SHIMS_DIR}
so you can type \`sessions\` instead of \`agents sessions\`.

  1) Let's do it
  2) Skip this time
  3) I'll do it manually if needed
`);
  const answer = await ask('Choose [1/2/3] (default 1): ');
  if (answer === '' || answer === '1') return 'install';
  if (answer === '3') return 'manual';
  return 'skip';
}

async function main() {
  // Opt-in: AGENTS_INIT_SHELL=1 npm install -g @phnx-labs/agents-cli
  if (process.env.AGENTS_INIT_SHELL === '1') {
    const rcFile = getShellRc();
    let alreadyConfigured = false;
    if (fs.existsSync(rcFile)) {
      const content = fs.readFileSync(rcFile, 'utf-8');
      alreadyConfigured = content.includes('.agents/shims');
    }
    if (!alreadyConfigured) {
      const addition = `\n# agents-cli: version switching for AI coding agents\n${exportLine}\n`;
      fs.mkdirSync(path.dirname(rcFile), { recursive: true });
      fs.appendFileSync(rcFile, addition);
      console.log(`\n  Added ${SHIMS_DIR} to PATH in ${path.basename(rcFile)}`);
      console.log(`  Restart your shell to enable version switching\n`);
    }
    writeAliasShims();
    console.log(`  Installed bare-command aliases: ${ALIASES.join(', ')}\n`);
    return;
  }

  // Default: print PATH instructions, then offer aliases interactively.
  console.log(`
agents-cli installed.
To enable version-aware shims, add the following line to your shell config:

  ${exportLine}

(zsh: ~/.zshrc, bash: ~/.bashrc, fish: ~/.config/fish/config.fish)

Or re-run with AGENTS_INIT_SHELL=1 to have the installer add it for you.
`);

  const choice = await promptForAliases();
  if (choice === 'install') {
    const written = writeAliasShims();
    console.log(`\n  Installed aliases: ${written.join(', ')} (in ${SHIMS_DIR})`);
    console.log(`  Make sure ${SHIMS_DIR} is on your PATH (see above).\n`);
  } else if (choice === 'manual') {
    console.log(`\n  To add aliases later, drop these in a directory on your PATH:`);
    for (const name of ALIASES) {
      console.log(`    ${name} -> exec agents ${name} "$@"`);
    }
    console.log('');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(0);
});
