---
name: browser
description: "Drive a browser via CDP - navigate, click, type, screenshot. Profiles persist login state across sessions."
author: phnx-labs
version: 1.1.0
license: MIT
---

# Browser

Control Chrome, Brave, Edge, Chromium, or Electron apps via Chrome DevTools Protocol. Profiles persist cookies and login state, so you authenticate once and stay logged in.

`browser` is shorthand for `agents browser` — use the short form.

## Quick Reference

| Task | Command |
|------|---------|
| Create a profile | `browser profiles create <name> --browser chrome` |
| Start a task | `browser start --profile <name> --task <task> --url <url>` |
| Navigate | `browser navigate <task> <url>` |
| Open new tab | `browser tab add <task> <url>` |
| Take screenshot | `browser screenshot <task>` |
| Get clickable elements | `browser refs <task>` |
| Click element | `browser click <task> <ref>` |
| Type text | `browser type <task> <ref> "text"` |
| Press key | `browser press <task> Enter` |
| Complete task | `browser done <task>` |
| Check status | `browser status` |

## Profile Setup

Profiles are browser identities with isolated cookies, storage, and login state.

### Create a profile

```bash
browser profiles create work --browser chrome
```

Valid browsers: `chrome`, `comet`, `chromium`, `brave`, `edge`

### With credentials

Attach a secrets bundle for automated login:

```bash
browser profiles create bank --browser chrome --secrets bank-creds
```

### For Electron apps

```bash
browser profiles create slack --browser custom \
  --binary "/Applications/Slack.app/Contents/MacOS/Slack"
```

### List profiles

```bash
browser profiles list
```

## Task Workflow

Tasks are units of work within a profile. Multiple tasks share one browser window, each managing its own tabs.

### Step 1: Start a task

```bash
browser start --profile work --task research --url https://google.com
```

Options:
- `--profile <name>` — required, which browser identity to use
- `--task <name>` — optional, auto-generates fun name if omitted
- `--url <url>` — optional, opens URL in first tab

### Step 2: Navigate and interact

```bash
# Navigate current tab
browser navigate research https://example.com

# Open additional tabs
browser tab add research https://github.com
browser tab add research https://stackoverflow.com

# Switch between tabs
browser tab focus research github    # by URL substring
browser tab focus research a1b2     # by tab ID prefix

# List tabs
browser tab list research
```

### Step 3: Interact with elements

```bash
# Get refs for clickable elements
browser refs research

# Output:
# [1] button "Sign In"
# [2] input[type=text] placeholder="Search"
# [3] a "Documentation"

# Click by ref number
browser click research 1

# Type into input
browser type research 2 "search query"

# Press keys
browser press research Enter
browser press research Tab
browser press research Escape
```

### Step 4: Screenshot

```bash
browser screenshot research
# Output: /path/to/screenshot.png

# Specific tab
browser screenshot research a1b2

# Custom path
browser screenshot research --output ./my-screenshot.png
```

### Step 5: Complete the task

```bash
browser done research
```

This closes all tabs owned by the task. The browser window stays open for other tasks.

## Multi-Task Example

Multiple agents can work on the same profile simultaneously:

```bash
# Agent 1 starts research task
browser start --profile work --task agent1-research --url https://arxiv.org

# Agent 2 starts monitoring task (same profile, same window)
browser start --profile work --task agent2-monitor --url https://dashboards.example.com

# Each agent manages only its own tabs
browser navigate agent1-research https://papers.nips.cc
browser navigate agent2-monitor https://prometheus.internal

# Tasks complete independently
browser done agent1-research  # agent2's tabs remain
```

## Evaluate JavaScript

Run JavaScript in the page context:

```bash
browser evaluate research "document.title"
browser evaluate research "document.querySelectorAll('a').length"
browser evaluate research "localStorage.getItem('token')"
```

## Status and Debugging

```bash
# Show all running profiles and tasks
browser status

# Output:
# work (port 9200, pid 12345)
#   TASK          TABS    CREATED
#   research      3       5m ago
#   monitoring    1       2m ago

# JSON output for scripting
browser status --json
```

## Command Reference

### Profiles

```
browser profiles list              List all profiles
browser profiles create <name>     Create profile (--browser, --secrets, --binary)
browser profiles show <name>       Show profile details
browser profiles delete <name>     Delete profile
```

### Tasks

```
browser start                      Start task (--profile, --task, --url)
browser done <task>                Complete task, close its tabs
browser stop <task>                Alias for done
browser status                     Show running tasks
browser tasks                      List all tasks
```

### Navigation

```
browser navigate <task> <url>      Navigate current tab
browser tab add <task> <url>       Open new tab
browser tab focus <task> <hint>    Switch to tab (ID prefix or URL substring)
browser tab close <task> [id]      Close tab(s)
browser tab list <task>            List tabs
```

### Interaction

```
browser refs <task>                Get interactive element refs
browser click <task> <ref>         Click element
browser type <task> <ref> <text>   Type into element
browser press <task> <key>         Press key (Enter, Tab, Escape, etc)
browser hover <task> <ref>         Hover over element
browser screenshot <task>          Take screenshot
browser evaluate <task> <expr>     Run JavaScript
```

## Tips

- **Tab hints are fuzzy** — `browser tab focus task git` matches `https://github.com`
- **Refs reset on navigation** — call `browser refs` again after page changes
- **Screenshots auto-compress** — JPEG quality reduces until under 100KB for token efficiency
- **Login state persists** — authenticate once per profile, all future tasks are logged in
