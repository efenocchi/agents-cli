# agents-cli Development Guide

## Architecture

```
src/
  index.ts              # CLI entry point, all commands
  lib/
    types.ts            # Core types (AgentId, Manifest, State, Registry)
    agents.ts           # Agent configs, CLI detection, MCP ops
    manifest.ts         # agents.yaml parsing/serialization
    state.ts            # ~/.agents/meta.yaml management
    git.ts              # Git clone/pull operations
    hooks.ts            # Hook discovery and installation
    commands.ts         # Slash command discovery and installation
    skills.ts           # Agent Skills (SKILL.md + rules/) management
    instructions.ts     # Agent instructions (CLAUDE.md, etc.) management
    convert.ts          # Markdown <-> TOML conversion
    registry.ts         # Package registry client (MCP, skills)
    jobs.ts             # Job config YAML parsing and management
    runner.ts           # Job execution (spawn agent processes)
    scheduler.ts        # Cron scheduling for jobs
    daemon.ts           # Background daemon process management
    sandbox.ts          # HOME overlay sandbox for job isolation
```

## Key Types

```typescript
type AgentId = 'claude' | 'codex' | 'gemini' | 'cursor' | 'opencode';

interface Manifest {
  clis?: Partial<Record<AgentId, CliConfig>>;
  dependencies?: Record<string, string>;
  mcp?: Record<string, McpServerConfig>;
  defaults?: { method?: 'symlink' | 'copy'; scope?: 'global' | 'project'; agents?: AgentId[] };
}

interface JobConfig {
  name: string;
  schedule: string;
  agent: AgentId;
  mode: 'plan' | 'edit';
  effort: 'fast' | 'default' | 'detailed';
  timeout: string;
  enabled: boolean;
  prompt: string;
  allow?: JobAllowConfig;
  config?: Record<string, unknown>;
  version?: string;
}
```

## Agent Configuration

Each agent has different paths and formats. See `AGENTS` object in `lib/agents.ts`:

| Agent | Commands Dir | Format | Instructions File | MCP Support |
|-------|--------------|--------|-------------------|-------------|
| Claude | `~/.claude/commands/` | markdown | `CLAUDE.md` | Yes |
| Codex | `~/.codex/prompts/` | markdown | `AGENTS.md` | Yes |
| Gemini | `~/.gemini/commands/` | toml | `GEMINI.md` | Yes |
| Cursor | `~/.cursor/commands/` | markdown | `.cursorrules` | Yes |
| OpenCode | `~/.opencode/commands/` | markdown | `OPENCODE.md` | Yes |

## Critical Patterns

### Scope System

Commands, skills, hooks, MCPs, and instructions can exist at two scopes:

| Scope | Location | Use Case |
|-------|----------|----------|
| User | `~/.{agent}/` | Available globally, all projects |
| Project | `./.{agent}/` | Project-specific, committed to repo |

### Jobs & Daemon

Jobs are YAML files in `~/.agents/jobs/`. The daemon runs in the background and executes jobs on their cron schedules.

**HOME overlay sandbox:** Each job runs with `HOME` set to an overlay directory (`~/.agents/jobs/{name}/home/`). This overlay contains:
- Agent-specific config files with permissions from `allow.tools`
- Symlinks to directories from `allow.dirs`
- Nothing else - agent can't see `~/.ssh`, `~/.gitconfig`, etc.

This provides real permission enforcement via the agent CLI's own config system, replacing prompt injection.

**Key files:**
- `lib/sandbox.ts` - overlay creation, config generation, dir symlinking
- `lib/runner.ts` - job execution with sandbox integration
- `lib/scheduler.ts` - cron scheduling via croner
- `lib/daemon.ts` - background daemon lifecycle

### Command Discovery

Commands are discovered from repo in this order:
1. `shared/commands/*.md` - Shared across all agents
2. `{agent}/{commandsSubdir}/*` - Agent-specific

Agent-specific commands override shared commands with the same name.

### Format Conversion

Gemini requires TOML format. When installing a markdown skill to Gemini:

```typescript
// lib/convert.ts
markdownToToml(skillName, markdownContent) -> tomlContent
```

### MCP Registration

Each agent has different MCP registration commands:

```typescript
// lib/agents.ts
registerMcp(agentId, serverName, command, scope)
unregisterMcp(agentId, serverName)
isMcpRegistered(agentId, serverName)
```

Claude/Codex use `claude mcp add` / `codex mcp add`.
Gemini uses config file modification.

### Git Source Parsing

Sources can be specified as:
- `gh:user/repo` - GitHub shorthand
- `https://github.com/user/repo` - Full URL
- `/path/to/local` - Local directory

### Package Registries

Registries are URL-based indexes for discovering MCP servers and skills.

Package identifier prefixes:
- `mcp:name` - Search MCP registries
- `skill:user/repo` - Skill (falls back to git)
- `gh:user/repo` - Git source directly

## State Management

State is persisted to `~/.agents/meta.yaml`:

```typescript
// lib/state.ts
readMeta() -> Meta
writeMeta(meta)
updateMeta(partial) -> Meta
```

Always use these functions - they handle directory creation and defaults.

## Adding a New Agent

1. Add to `AgentId` type in `lib/types.ts`
2. Add config to `AGENTS` object in `lib/agents.ts`
3. Add to `ALL_AGENT_IDS` array
4. If MCP capable, add to `MCP_CAPABLE_AGENTS`
5. Implement any custom detection in `isCliInstalled()`

## Adding a New Command

Commands are defined in `index.ts` using Commander.js:

```typescript
program
  .command('mycommand <arg>')
  .description('What it does')
  .option('-f, --flag', 'Description')
  .action(async (arg, options) => {
    // Implementation
  });
```

For subcommands:

```typescript
const myCmd = program.command('my').description('Parent command');
myCmd.command('sub').action(() => { ... });
```

## Build & Test

```bash
bun install
bun run build    # Compiles to dist/
bun test         # Run vitest
```

## Dependencies

- `commander` - CLI framework
- `chalk` - Terminal colors
- `ora` - Spinners
- `@inquirer/prompts` - Interactive prompts
- `simple-git` - Git operations
- `yaml` - YAML parsing
- `semver` - Version comparison
- `croner` - Cron scheduling

## File Locations

### Global State

| Item | Path |
|------|------|
| State | `~/.agents/meta.yaml` |
| Cloned repos | `~/.agents/repos/` |
| External packages | `~/.agents/packages/` |
| Agent Skills | `~/.agents/skills/` |
| Jobs | `~/.agents/jobs/` |
| Job runs | `~/.agents/runs/` |
| Daemon log | `~/.agents/daemon.log` |
| Daemon PID | `~/.agents/daemon.pid` |

### User Scope (global)

| Item | Path |
|------|------|
| Claude commands | `~/.claude/commands/` |
| Claude skills | `~/.claude/skills/` |
| Claude instructions | `~/.claude/CLAUDE.md` |
| Claude MCP config | `~/.claude/settings.json` |
| Codex prompts | `~/.codex/prompts/` |
| Codex skills | `~/.codex/skills/` |
| Codex instructions | `~/.codex/AGENTS.md` |
| Codex MCP config | `~/.codex/config.json` |
| Gemini commands | `~/.gemini/commands/` |
| Gemini skills | `~/.gemini/skills/` |
| Gemini instructions | `~/.gemini/GEMINI.md` |
| Gemini MCP config | `~/.gemini/settings.json` |

### Project Scope (per-directory)

| Item | Path |
|------|------|
| Claude commands | `./.claude/commands/` |
| Claude skills | `./.claude/skills/` |
| Claude instructions | `./.claude/CLAUDE.md` |
| Claude MCP config | `./.claude/settings.json` |
| Codex prompts | `./.codex/prompts/` |
| Codex skills | `./.codex/skills/` |
| Codex instructions | `./.codex/AGENTS.md` |
| Codex MCP config | `./.codex/config.json` |
| Gemini commands | `./.gemini/commands/` |
| Gemini skills | `./.gemini/skills/` |
| Gemini instructions | `./.gemini/GEMINI.md` |
| Gemini MCP config | `./.gemini/settings.json` |
