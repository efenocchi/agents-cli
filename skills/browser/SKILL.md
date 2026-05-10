---
name: browser
description: "Drive a browser via CDP - navigate, click, type, screenshot. Profiles persist login state across sessions."
author: phnx-labs
version: 1.1.0
license: MIT
---

# Browser

Control a real browser via CDP. Profiles persist login state, so agents log in once and stay authenticated. Screenshots auto-resize to save tokens.

`browser` is shorthand for `agents browser` — use the short form.

## "I need to automate a site that blocks bots"

Use your real browser. Same fingerprint, same IP, nothing to detect:

```bash
browser profiles create work --browser chrome
browser start --profile work --task scrape --url https://linkedin.com
browser refs scrape
browser click scrape 5
```

## "I don't want to log in every time"

Log in once to a profile — the session persists. Every future task is already authenticated:

```bash
browser profiles create social --browser chrome
browser start --profile social --task setup
# Log in manually or via automation
browser done setup

# Next time — already logged in
browser start --profile social --task post --url https://twitter.com
```

## "I have multiple accounts and want to keep them separate"

Profiles are identities. Create one per account group:

```bash
browser profiles create social --browser chrome    # Twitter, LinkedIn
browser profiles create email --browser chrome     # Gmail, work email
browser profiles create finance --browser chrome   # Banking, trading
```

An agent using `social` can't see your `finance` cookies.

## "I'm running multiple agents and they keep stepping on each other"

Each agent gets its own task. Tasks share the window but own separate tabs:

```bash
# Agent 1 starts research
browser start --profile work --task agent1-research --url https://arxiv.org

# Agent 2 starts monitoring (same profile, same window, different tabs)
browser start --profile work --task agent2-monitor --url https://grafana.internal

# Each agent only sees its own tabs
browser tab list agent1-research
browser tab list agent2-monitor

# Completing one doesn't affect the other
browser done agent1-research  # agent2's tabs stay open
```

## "I need to give an agent login credentials safely"

Attach a secrets bundle. Credentials stay in Keychain, and every access is logged:

```bash
browser profiles create bank --browser chrome --secrets bank-login
```

## "I want to use a cloud browser instead of local"

Connect to BrowserBase, Steel, or any CDP service:

```bash
browser profiles create cloud --browser chrome \
  --endpoint "wss://connect.browserbase.com?apiKey=..."
```

## "I need to automate an Electron app"

Point to the binary:

```bash
browser profiles create slack --browser custom \
  --binary "/Applications/Slack.app/Contents/MacOS/Slack"
```

## Common workflows

### Navigate and interact

```bash
browser start --profile work --task demo --url https://example.com
browser refs demo                    # Get clickable elements
browser click demo 3                 # Click element ref 3
browser type demo 5 "search query"   # Type into element ref 5
browser press demo Enter             # Press Enter key
browser screenshot demo              # Take screenshot
browser done demo                    # Close task's tabs
```

### Manage tabs

```bash
browser tab add demo https://github.com      # Open new tab
browser tab focus demo github                # Switch by URL substring
browser tab list demo                        # List all tabs
browser tab close demo                       # Close all tabs
```

### Check status

```bash
browser status                       # Show all profiles and tasks
browser tasks                        # List just tasks
```

## Quick reference

| Task | Command |
|------|---------|
| Create profile | `browser profiles create <name> --browser chrome` |
| Start task | `browser start --profile <name> --task <task> --url <url>` |
| Navigate | `browser navigate <task> <url>` |
| Get elements | `browser refs <task>` |
| Click | `browser click <task> <ref>` |
| Type | `browser type <task> <ref> "text"` |
| Press key | `browser press <task> Enter` |
| Screenshot | `browser screenshot <task>` |
| New tab | `browser tab add <task> <url>` |
| Switch tab | `browser tab focus <task> <hint>` |
| Complete task | `browser done <task>` |
| Status | `browser status` |
