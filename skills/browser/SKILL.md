---
name: browser
description: "Browser automation via CDP. Uses your existing residential browser (undetectable), supports profile isolation for multi-agent work, and connects to local, SSH, or cloud browsers (BrowserBase, Steel)."
author: phnx-labs
version: 1.0.0
license: MIT
---

# Browser

Control a real browser via CDP. Profiles persist login state, so agents log in once and stay authenticated. Screenshots auto-resize to save tokens.

## Why not Browser Use, BrowserBase, or agent-browser?

**Browser Use**: Great Python library, but you manage your own browser infrastructure. For production, they push you to their cloud service.

**BrowserBase**: Cloud browsers with anti-detection — but per-session pricing, and your data flows through their servers. Great for scraping at scale, less ideal for personal accounts.

**agent-browser**: Solid standalone CLI with profile persistence. Good choice if you just need browser automation.

**agents browser**: 
- **Free and fast** — runs locally, no per-session pricing. Lower latency than cloud round-trips.
- **SSH for remote power** — run the browser on your always-on home desktop, control it from your laptop anywhere
- **Token-efficient screenshots** — auto-resizes to <100KB by progressively lowering JPEG quality, so agents don't burn tokens on oversized images
- **Ecosystem integration** — profiles work with `agents secrets` for credential injection, `agents teams` for multi-agent orchestration, `agents sessions` for audit trails, `agents routines` for scheduled browser tasks
- **Task isolation** — multiple concurrent tasks per profile, each with its own tabs and state

## "I need to automate a site that blocks bots"

Use your real browser. Same fingerprint, same IP, nothing to detect:

```bash
agents browser profiles create work --browser chrome
agents browser start task --profile work
agents browser navigate task https://linkedin.com
```

## "I don't want to log in every time"

Log in once to a profile — the session persists. Every future task is already authenticated:

```bash
agents browser profiles create social --browser chrome
agents browser start setup --profile social
# Log in manually or via automation, then stop

# Next time — already logged in
agents browser start post --profile social
```

## "I have multiple accounts and want to keep them separate"

Profiles are identities. Create one per account group:

```bash
agents browser profiles create social --browser chrome    # Twitter, LinkedIn
agents browser profiles create email --browser chrome     # Gmail, work email
agents browser profiles create finance --browser chrome   # Banking, trading
```

An agent using `social` can't see your `finance` cookies.

## "I'm running multiple agents and they keep interfering"

Each agent gets its own profile. No shared state:

```bash
agents browser start agent1-work --profile social
agents browser start agent2-work --profile email
```

## "I need to give an agent login credentials safely"

Attach a secrets bundle. Credentials stay in Keychain, and every access is logged:

```bash
agents browser profiles create bank --browser chrome --secrets bank-login
```

## "I want to use a cloud browser instead of local"

Connect to BrowserBase, Steel, or any CDP service:

```bash
agents browser profiles create cloud --browser chrome \
  --endpoint "wss://connect.browserbase.com?apiKey=..."
```

## "I need to automate an Electron app"

Point to the binary:

```bash
agents browser profiles create slack --browser custom \
  --binary "/Applications/Slack.app/Contents/MacOS/Slack" \
  --electron
```

## "What else can I do?"

Run `agents browser --help` — there's more: screenshots, element refs, clicking, typing, evaluating JavaScript, SSH tunnels to remote machines.
