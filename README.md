# agents-cli

**One config for all your AI coding agents.** Sync commands, MCP servers, hooks, and skills across Claude, Codex, Gemini, and Cursor - plus schedule agents to run autonomously as sandboxed jobs.

```bash
npm install -g @swarmify/agents-cli
```

## The Problem

Each agent stores config differently. Different paths, different formats. You configure Claude Code, then start from scratch with Codex. New machine? Do it all again.

## The Solution

Put your config in a GitHub repo. One command syncs everything.

```bash
agents pull            # Sync all agents
agents pull claude     # Sync just Claude
agents status          # See what's installed
```

Write commands once in markdown - auto-converts to TOML for Gemini. Define MCP servers once - installs to all agents.

## What Gets Synced

| Resource | Agents |
|----------|--------|
| Slash commands | Claude, Codex, Gemini, Cursor, OpenCode |
| MCP servers | Claude, Codex, Gemini |
| Hooks | Claude, Gemini |
| Skills | Claude, Codex, Gemini |
| CLI versions | All |

## Quick Start

```bash
npm install -g @swarmify/agents-cli
agents pull       # Auto-configures from default repo on first run
agents status     # See what got installed
```

Use your own config repo:

```bash
agents repo add gh:username/.agents
agents pull
```

## Commands

```bash
# Sync
agents pull [agent]              # Pull config (optionally for one agent)
agents push                      # Push local changes back

# Resources
agents commands list|add|remove|push
agents mcp list|add|remove|push
agents skills list|add|info
agents hooks list|add|remove

# CLI management
agents cli list|add|remove|upgrade

# Registries
agents search <query>            # Search MCP registries
agents add mcp:<name>            # Install from registry

# Jobs
agents jobs list|add|run|enable|disable|logs|report
agents daemon start|stop|status|logs
```

Resources support two scopes: **user** (`~/.{agent}/`) for global availability, and **project** (`./.{agent}/`) for repo-specific config. Use `push` subcommands to promote project scope to user scope.

## Jobs

Schedule AI agents to run autonomously on a cron schedule. Define a job in YAML, the daemon handles the rest.

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

Jobs support `claude`, `codex`, and `gemini` agents. The `prompt` supports template variables: `{day}`, `{date}`, `{time}`, `{job_name}`, `{last_report}`.

### Sandboxed Execution

Each job runs in an isolated environment. The agent doesn't see your real home directory - it gets an overlay:

```
~/.agents/jobs/reddit-engagement/home/     <-- agent sees this as $HOME
  .claude/
    settings.json                          <-- generated from allow.tools
  .agents/
    reports/
      reddit-engagement/ -> ~/real/path    <-- symlink from allow.dirs
```

Two layers of enforcement, neither relies on prompt injection:

| Layer | What it does | How |
|-------|-------------|-----|
| **Agent config** | Tool allowlists (`WebSearch(*)`, `Read(*)`, etc.) | Agent CLI reads generated config and blocks disallowed tools |
| **HOME overlay** | Filesystem isolation | Only `allow.dirs` entries are symlinked in; everything else is invisible |
| **Env sanitization** | No credential leakage | Only safe env vars (PATH, SHELL, LANG, etc.) are passed through |

The agent can't access `~/.ssh`, `~/.aws`, `~/.gitconfig`, API keys in env vars, or anything else you didn't explicitly allow. The overlay is recreated fresh before each run.

### Model Pinning

```yaml
# Claude
config:
  model: claude-sonnet-4-5

# Codex
agent: codex
config:
  model: gpt-5.2-codex
```

## Supported Agents

| Agent | Commands | MCP | Hooks | Skills | Jobs |
|-------|----------|-----|-------|--------|------|
| Claude Code | Yes | Yes | Yes | Yes | Yes |
| Codex | Yes | Yes | - | Yes | Yes |
| Gemini CLI | Yes | Yes | Yes | Yes | Yes |
| Cursor | Yes | Yes | - | - | - |
| OpenCode | Yes | Yes | - | - | - |

## Roadmap: Context Drives

Sync docs, research, and agent chat history across machines and teams. Per-directory conflict strategies (CRDT, git, lock, last-write-wins). Checkpointing and rollback.

```bash
agents drive create <name>
agents drive sync
agents drive checkpoint "before refactor"
agents drive rollback <checkpoint>
```

## License

MIT
