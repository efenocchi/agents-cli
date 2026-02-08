# agents-cli

**One config for all your AI coding agents.** Sync CLIs, MCP servers, commands, hooks, and skills across Claude, Codex, Gemini, and Cursor.

[NPM](https://www.npmjs.com/package/@swarmify/agents-cli)

```bash
npm install -g @swarmify/agents-cli
```

## The Problem

Each agent stores config differently. Different paths, different formats:

| What | Claude | Codex | Gemini |
|------|--------|-------|--------|
| Commands | `~/.claude/commands/` (md) | `~/.codex/prompts/` (md) | `~/.gemini/commands/` (TOML) |
| MCP config | `~/.claude/settings.json` | `~/.codex/config.json` | `~/.gemini/settings.json` |
| Hooks | `~/.claude/hooks/` | - | `~/.gemini/hooks/` |

You spend hours configuring Claude Code - MCP servers, slash commands, hooks, skills. Then you switch to Codex and start from scratch. Get a new machine and lose everything.

## The Solution

```
                      .agents repo (GitHub)
                             |
            +----------------+----------------+
            |                |                |
      agents.yaml      commands/          hooks/
     (CLIs, MCPs)     (slash cmds)       (scripts)
            |                |                |
            +----------------+----------------+
                             |
                       agents pull
                             |
         +-------------------+-------------------+
         |                   |                   |
    ~/.claude/          ~/.codex/          ~/.gemini/
  - commands/ (md)    - prompts/ (md)    - commands/ (TOML)
  - hooks/            - config.json      - hooks/
  - settings.json                        - settings.json
```

One repo. One command. All agents configured.

```bash
# New machine? One command.
agents pull

# See what's installed
agents status
```

```
Agent CLIs

  Claude Code    2.0.65
  Codex          1.0.3
  Gemini CLI     0.1.15

Installed Commands

  Claude Code:   clean, debug, plan, ship, test
  Codex:         clean, debug, plan, ship, test
  Gemini CLI:    clean, debug, plan, ship, test

Installed MCP Servers

  All agents:    Swarm, filesystem, memory

Installed Hooks

  Claude Code:   pre-commit, post-tool
  Gemini CLI:    pre-commit, post-tool
```

Write commands once in markdown - auto-converts to TOML for Gemini. Define MCP servers once - installs to all agents. Your `.agents` repo becomes the single source of truth.

## What Gets Synced

| Resource | Description | Agents |
|----------|-------------|--------|
| Slash commands | `/debug`, `/plan`, custom prompts | Claude, Codex, Gemini, Cursor, OpenCode |
| MCP servers | Tools your agents can use | Claude, Codex, Gemini |
| Hooks | Pre/post execution scripts | Claude, Gemini |
| Skills | Reusable agent capabilities | Claude, Codex, Gemini |
| CLI versions | Which version of each agent | All |

## Quick Start

```bash
# 1. Install
npm install -g @swarmify/agents-cli

# 2. Pull (auto-configures from default repo on first run)
agents pull

# 3. Check what's installed
agents status
```

Pull a specific agent only:

```bash
agents pull claude    # Only configure Claude Code
agents pull codex     # Only configure Codex
```

## Using Your Own Config

By default, `agents pull` uses the [system repo](https://github.com/muqsitnawaz/.agents). To use your own:

```bash
# Fork the system repo, then:
agents repo add gh:username/.agents

# Now pull uses your repo
agents pull
```

## .agents Repo Structure

```
.agents/
  agents.yaml              # CLI versions, MCP servers, defaults
  shared/commands/         # Slash commands for all agents
  claude/commands/         # Claude-specific commands
  claude/hooks/            # Claude hooks
  codex/prompts/           # Codex-specific prompts
  gemini/commands/         # Gemini commands (auto-converted to TOML)
  skills/                  # Agent Skills (SKILL.md + rules/)
```

Example `agents.yaml`:

```yaml
clis:
  claude:
    package: "@anthropic-ai/claude-code"
    version: "latest"
  codex:
    package: "@openai/codex"
    version: "latest"

mcp:
  filesystem:
    command: "npx -y @anthropic-ai/mcp-filesystem"
    transport: stdio
    scope: user
    agents: [claude, codex, gemini]

  memory:
    command: "npx -y @anthropic-ai/mcp-memory"
    transport: stdio
    scope: user
    agents: [claude, codex, gemini]

defaults:
  method: symlink
  scope: user
  agents: [claude, codex, gemini]
```

## Commands

### Status

```bash
agents status              # Full overview
agents status --agent claude
```

### Pull & Push

```bash
agents pull                # Sync all agents from your repo
agents pull claude         # Sync only Claude resources
agents pull cc             # Same (aliases: cc, codex/cx, gemini/gx)
agents pull --dry-run      # Preview what would change
agents pull -y             # Auto-confirm, skip conflicts
agents pull -f             # Auto-confirm, overwrite conflicts
agents push                # Push local changes back
```

The pull command shows an overview of NEW vs EXISTING resources before installation. For conflicts, you're prompted per-resource to overwrite, skip, or cancel.

### Slash Commands

```bash
agents commands list
agents commands add gh:user/my-commands
agents commands remove my-command
agents commands push my-command   # Promote project -> user scope
```

### MCP Servers

```bash
# List across all agents
agents mcp list

# Add (use -- before the command)
agents mcp add memory -- npx -y @anthropic-ai/mcp-memory
agents mcp add api https://api.example.com --transport http

# Search registries
agents search filesystem
agents add mcp:@anthropic-ai/mcp-filesystem

# Remove
agents mcp remove memory
```

### Skills

```bash
agents skills list
agents skills add gh:user/my-skills
agents skills info my-skill
```

### Hooks

```bash
agents hooks list
agents hooks add gh:user/my-hooks
agents hooks remove my-hook
```

### CLI Management

```bash
agents cli list            # Show installed versions
agents cli add claude      # Install agent CLI
agents cli remove codex    # Uninstall agent CLI
agents cli upgrade         # Upgrade all to latest
```

### Jobs & Daemon

```bash
agents jobs list           # List all scheduled jobs
agents jobs add job.yml    # Add a job from YAML
agents jobs run my-job     # Run a job immediately
agents jobs enable my-job  # Enable a job
agents jobs disable my-job # Disable a job
agents jobs logs my-job    # Show stdout from latest run
agents jobs report my-job  # Show report from latest run

agents daemon start        # Start the job daemon
agents daemon stop         # Stop the daemon
agents daemon status       # Show daemon status
agents daemon logs         # Show daemon logs
```

## Jobs

Jobs let you schedule AI agents to run autonomously on a cron schedule. Define a job as a YAML file and the daemon handles the rest.

```yaml
name: reddit-engagement
schedule: "0 9 * * 1-4"
agent: claude
mode: plan
timeout: 30m
prompt: |
  Today is {day}. Follow the engagement plan.

allow:
  tools: [web_search, web_fetch]
  sites: [reddit.com, old.reddit.com]
  dirs: [~/.agents/reports/reddit-engagement]

config:
  model: claude-sonnet-4-5
```

The `allow` block controls what the agent can do. `config` passes agent-specific settings like model selection. The `prompt` supports template variables (`{day}`, `{date}`, `{time}`, `{job_name}`, `{last_report}`).

### Sandboxed Execution

When a job runs, the agent doesn't see your real home directory. Instead, it gets an isolated overlay:

```
~/.agents/jobs/reddit-engagement/home/     <-- agent sees this as $HOME
  .claude/
    settings.json                          <-- generated permissions
  .agents/
    reports/
      reddit-engagement/ -> ~/real/path    <-- symlink to allowed dir
```

This works by setting `HOME` to the overlay directory before spawning the agent process. The agent CLI reads its config from `$HOME/.claude/settings.json` (or `.codex/config.toml`, `.gemini/settings.json`) as usual - but those config files are generated from your job's `allow` block.

The result is a two-layer permission system:

| Layer | What it does | Enforcement |
|-------|-------------|-------------|
| **Agent config** | Tool allowlists (`Read(*)`, `WebSearch(*)`, etc.) | Hard - the agent CLI itself blocks disallowed tools |
| **HOME overlay** | Filesystem isolation - only `allow.dirs` are visible | Hard - dirs outside the overlay simply don't exist |

Neither layer relies on prompt injection. The agent CLI enforces tool permissions because it reads the generated config file. The filesystem is isolated because the overlay HOME contains only what you explicitly symlink in. The agent can't access `~/.ssh`, `~/.gitconfig`, `~/.aws`, or anything else unless you add it to `allow.dirs`.

### How the layers compose

Say you define a job with:

```yaml
allow:
  tools: [web_search, read]
  dirs: [~/projects/my-repo]
```

Here's what happens:

1. **Overlay created** at `~/.agents/jobs/{name}/home/`
2. **Agent config generated** - for Claude, `settings.json` gets `permissions.allow: ["WebSearch(*)", "Read(*)"]`
3. **Dirs symlinked** - `~/projects/my-repo` becomes accessible inside the overlay
4. **Agent spawned** with `HOME=/overlay/path` - it can only use `web_search` and `read` (enforced by the CLI), and can only see files in `~/projects/my-repo` (enforced by the overlay)

The overlay is cleaned and recreated fresh before each run, so no stale state carries over between executions.

### Model and version pinning

Jobs can pin the model and (eventually) the CLI version:

```yaml
# Use a specific model for this job
config:
  model: claude-sonnet-4-5

# Pin CLI version (planned)
# version: 1.0.23
```

For Codex jobs, `config` maps directly to `~/.codex/config.toml`:

```yaml
agent: codex
config:
  model: gpt-5.2-codex
  approval_mode: full-auto
```

## Scopes

Resources can exist at two levels:

| Scope | Location | Use |
|-------|----------|-----|
| User | `~/.{agent}/` | Available everywhere |
| Project | `./.{agent}/` | This repo only, committed |

Promote project-scoped items to user scope:

```bash
agents commands push my-command
agents mcp push my-server
agents skills push my-skill
```

## Filtering

All list commands support filters:

```bash
agents commands list --agent claude
agents mcp list --scope project
agents skills list --agent codex --scope user
```

## Registries

Search and install from public registries:

```bash
# Search
agents search github --type mcp

# Install from registry
agents add mcp:@anthropic-ai/mcp-filesystem

# Manage registries
agents registry list
agents registry add mcp myregistry https://api.example.com
agents registry config mcp myregistry --api-key KEY
```

## Supported Agents

| Agent | Commands | MCP | Hooks | Skills |
|-------|----------|-----|-------|--------|
| Claude Code | Yes | Yes | Yes | Yes |
| Codex | Yes | Yes | - | Yes |
| Gemini CLI | Yes | Yes | Yes | Yes |
| Cursor | Yes | Yes | - | - |
| OpenCode | Yes | Yes | - | - |

Format conversion is automatic. Write commands in markdown, they're converted to TOML for Gemini.

## Roadmap: Context Drives

Sync your docs, research, and chat history across machines and teams.

```
~/.agents/
  drives/                    # Context drives (synced)
    work/
      .context               # Per-drive settings
      docs/
      research/
      specs/
    personal/
      .context
      notes/

  sessions/                  # Agent chat history (synced)
    claude/
    codex/
    gemini/
```

**Why not just Google Drive?**

| Feature | Google Drive | Context Drives |
|---------|--------------|----------------|
| Sync files | Yes | Yes |
| Real-time collab | Yes (Docs only) | Yes (CRDT for all files) |
| Agent session sync | No | Yes |
| Checkpointing | No | Yes (snapshot & rollback) |
| Per-directory conflict strategy | No | Yes (`.context` file) |
| Designed for AI agents | No | Yes |

**Conflict resolution strategies** (configurable per directory):

```yaml
# .context file
strategy: crdt              # Auto-merge (like Google Docs)
# strategy: git             # Branch/PR/merge (for code)
# strategy: lock            # Exclusive access
# strategy: last-write-wins # Don't care about conflicts

sync: realtime              # or: on-demand, ignore
```

**Planned commands:**

```bash
agents drive create <name>
agents drive list
agents drive use <name>
agents drive sync
agents drive checkpoint "before refactor"
agents drive rollback <checkpoint>
```

**Multi-agent coordination:** When multiple agents (or developers) work on the same drive, the drive acts as a coordination layer - checkout files, see who's working on what, avoid conflicts.

## License

MIT
