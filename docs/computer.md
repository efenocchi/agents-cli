# Computer

Drive native macOS apps from AI agents via the Accessibility API.

## Overview

`agents computers` controls macOS applications through the Accessibility
(`AXUIElement`) and Screen Recording frameworks. It requires a separate helper
app (`Computer Helper.app`) installed in `/Applications/` with two macOS TCC
grants: Accessibility and Screen Recording.

The helper runs as a launchd user agent, listening on a UNIX socket. Agents
send JSON-RPC calls through the CLI; the helper translates them into AX actions
on running apps.

Use this when you need to drive a macOS app that has no web interface and no
CDP endpoint — a desktop finance tool, a native editor, a system preferences
pane, or an app that Electron automation cannot reach cleanly.

This is macOS-only. The daemon, socket, and all TCC plumbing are specific to
macOS APIs (`launchctl`, `AXUIElement`, `CoreGraphics`).

## Architecture

```
agent process
     │
     │  agents computers <subcommand>
     ▼
  CLI (computer.ts)
     │
     │  JSON-RPC over UNIX socket
     │  ~/.agents/.cache/helpers/computer.sock
     │
     │  Fallback: spawn helper binary as child process
     │            (for dev builds without install-helper)
     ▼
  Computer Helper.app
  /Applications/Computer Helper.app
  [launchd: com.phnx-labs.computer-helper]
     │
     │  AXUIElement  (Accessibility framework)
     │  CGWindowListCopyWindowInfo / CGDisplayCreateImage (Screen Recording)
     ▼
  macOS app process
  (any app in the allow list)
```

The helper reads an allow-list policy file
(`~/.agents/.cache/helpers/computer-policy.json`) at startup and on SIGHUP.
By default the policy is deny-all. You must explicitly whitelist each app the
daemon may drive.

A peer-auth list (`~/.agents/.cache/helpers/computer-peers.json`) controls
which caller executables may connect to the socket. The CLI writes this list
at `start` time based on the currently installed Node binary path. This
prevents a malicious npm postinstall from connecting to the socket through a
different process.

## Setup

### 1. Install the helper

```bash
agents computers install-helper
```

This copies `Computer Helper.app` to `/Applications/Computer Helper.app`,
verifies its codesign signature, writes a LaunchAgent plist at
`~/Library/LaunchAgents/com.phnx-labs.computer-helper.plist`, and prints
the next steps. It does **not** start the daemon.

### 2. Grant TCC permissions (one-time)

Open System Settings on macOS:

```
System Settings > Privacy & Security > Accessibility   — add Computer Helper.app
System Settings > Privacy & Security > Screen Recording — add Computer Helper.app
```

These grants are keyed to the app's signed bundle identity at
`/Applications/Computer Helper.app`. They survive `npm update` as long as the
app stays at that path and the same certificate signs it.

### 3. Whitelist the apps the daemon may drive

Add a YAML file under `~/.agents/permissions/groups/`:

```yaml
# ~/.agents/permissions/groups/computer.yaml
name: computer
allow:
  - "Computer(com.apple.mail)"
  - "Computer(com.apple.notes)"
  - "Computer(com.apple.finder)"
```

The bundle ID is the value from `CFBundleIdentifier` in the app's `Info.plist`.
Find it with:

```bash
defaults read /Applications/SomeApp.app/Contents/Info CFBundleIdentifier
```

### 4. Start the daemon when you need it

```bash
agents computers start
```

The daemon is not always-on. Start it when you need it, stop it when done.
This is intentional: Accessibility and Screen Recording are sensitive grants;
an always-on background listener that can drive any app is a large attack
surface.

```bash
agents computers stop   # when finished
```

## Command Reference

| Command | Description |
|---------|-------------|
| `agents computers install-helper` | Copy helper to /Applications/, write LaunchAgent plist |
| `agents computers start` | Load the LaunchAgent and start the daemon |
| `agents computers stop` | Unload the LaunchAgent, remove the socket |
| `agents computers reload` | Reload the allow-list policy from ~/.agents/permissions/groups/ (SIGHUP the daemon) |
| `agents computers status` | Report install state, daemon state, TCC trust, policy, and peer list |
| `agents computers screenshot` | Capture a JPEG of the frontmost window of an allowed app |

`screenshot` flags:

| Flag | Default | Description |
|------|---------|-------------|
| `--bundle <id>` | frontmost app | Bundle ID of the app to capture |
| `--out <path>` | `./computer-screenshot.jpg` | Output JPEG path |
| `--quality <n>` | 85 | JPEG quality 1–100 |

`status` output fields:

| Field | Description |
|-------|-------------|
| `installed` | Whether `/Applications/Computer Helper.app` exists |
| `daemon` | Socket up (running) or down (stopped) |
| `policy` | Count and names of allowed apps from the policy file |
| `peers` | Count of caller executables allowed to connect |
| `trust` | `granted` or `denied` from a live `trust_status` RPC call |
| `pid` | Helper process PID (when trust is probed successfully) |

## Recipes

### 1. Install helper and grant accessibility

```bash
# Install
agents computers install-helper

# Grant permissions in System Settings (manual step)
# Then:
agents computers start
agents computers status
# trust: granted means you are ready
```

### 2. Screenshot the active app

```bash
agents computers start

# Bring the app you want to the foreground, then:
agents computers screenshot --out /tmp/app-snapshot.jpg

# Or target a specific app by bundle ID:
agents computers screenshot --bundle com.apple.mail --out /tmp/mail.jpg

agents computers stop
```

### 3. Add a new app to the allow list, then reload

```bash
# Add the bundle ID to your permissions group
cat >> ~/.agents/permissions/groups/computer.yaml << 'EOF'
  - "Computer(com.apple.calendar)"
EOF

# Reload without restarting the daemon
agents computers reload
# Output: policy: 4 apps allowed (com.apple.mail, com.apple.notes, ...)

# Now screenshot Calendar
agents computers screenshot --bundle com.apple.calendar --out /tmp/calendar.jpg
```

### 4. Automate a native macOS app from an agent

The computer helper exposes JSON-RPC methods (`list_apps`, `screenshot`,
`trust_status`) over the socket. Agents calling these directly should use
`agents computers start` to bring the daemon up, then target the socket at
`~/.agents/.cache/helpers/computer.sock`. The CLI is the intended interface;
see `src/lib/computer-rpc.ts` for the raw wire format if you need to call the
socket from another process.

```bash
agents computers start
agents computers status          # confirm trust: granted

# Screenshot Finder and feed the image to your agent
agents computers screenshot --bundle com.apple.finder --out /tmp/finder.jpg

# When automation is complete:
agents computers stop
```

## Demo

<video autoplay loop muted playsinline width="100%" src="../assets/videos/computer.mp4"></video>

## See also

- [docs/browser.md](browser.md) — drive real browsers via CDP; part of the automation triad
- [docs/pty.md](pty.md) — drive REPLs and TUI programs from an agent; part of the automation triad
- [docs/00-concepts.md](00-concepts.md) — DotAgents repos, resource resolution model
