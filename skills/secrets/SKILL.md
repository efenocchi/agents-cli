---
name: secrets
description: "Manage named bundles of environment variables backed by macOS Keychain. Create bundles, add secrets, generate passwords, and inject them into agent runs. Triggers on: 'API key', 'credentials', 'secrets bundle', 'inject env vars', '--secrets', 'keychain'."
argument-hint: "[create|add|list|view|import|export|rotate|generate]"
allowed-tools: Bash(agents secrets*)
user-invocable: true
---

# Secrets

Store credentials in your OS keychain and inject them into agent runs. Nothing touches disk in plaintext — not even the bundle metadata.

## Platform support

| Platform | Backend | Install |
|----------|---------|---------|
| macOS | Keychain | Built-in |
| Linux (desktop) | GNOME Keyring (libsecret) | `sudo apt install libsecret-tools` |
| Linux (headless/server) | Use `env:` refs | See below |
| Windows | Not yet supported | — |

**Desktop Linux:** GNOME Keyring (or another Secret Service provider) must be running. Most desktop environments start it automatically.

**Headless Linux (SSH, CI, containers):** No keyring daemon available. Use `env:` refs to pass secrets via environment:

```bash
# Create bundle with env refs
agents secrets create prod
agents secrets add prod DB_PASSWORD --env DB_PASSWORD

# Pass at runtime
DB_PASSWORD=xxx agents run claude "..." --secrets prod
```

Vault providers (1Password, AWS Secrets Manager, HashiCorp Vault) are planned for headless environments.

## Why not just use .zshrc or 1Password?

**Environment variables in .zshrc**: The agent inherits your *entire* environment. You can't scope what it sees — it gets everything, including keys for services it doesn't need. And they're plaintext on disk.

**1Password / iCloud Passwords**: Designed for humans, not agents. They require interactive authentication (biometrics, master password). An agent can't programmatically fetch or store credentials without you approving each access. And they can't *write* — if an agent generates a new API key, it can't save it back.

**agents secrets**: Scoped bundles (agent only sees what you pass), OS keychain-backed (encrypted at rest), and agent-friendly (agents can read *and* write programmatically).

## "I need to give an agent access to my API keys"

Create a bundle, add your keys, then pass the bundle when running agents:

```bash
agents secrets create prod
agents secrets add prod STRIPE_API_KEY      # prompts for value
agents secrets add prod DATABASE_URL

agents run claude "deploy the api" --secrets prod
```

The secrets inject as environment variables at runtime.

## "I just generated a new API key in the browser — how do I save it?"

Pipe it via stdin so it never appears in shell history:

```bash
echo "$NEW_API_KEY" | agents secrets add prod STRIPE_KEY --value-stdin
```

## "I need a secure password"

```bash
agents secrets generate --copy    # copies to clipboard, prints nothing
```

## "I have multiple Macs and want secrets to sync"

Bundles auto-sync via iCloud Keychain by default. Create on one Mac, and the bundle appears on every Mac signed into the same iCloud account:

```bash
agents secrets create work
```

Pass `--no-icloud-sync` to keep values device-local instead.

## "I want to track when API keys expire"

Add metadata when storing secrets:

```bash
agents secrets add prod STRIPE_KEY --type api-key --expires 2027-12-31 --note "Live key, rotate annually"
```

The `list` command shows secrets expiring in the next 30 days. Expired secrets show in red.

## "I have a .env file I want to import"

```bash
agents secrets import prod --from .env.prod
```

Every key goes into Keychain.

## "I need a secret that reads from a file or command at runtime"

Secrets can be dynamic references, not just static values:

```bash
agents secrets add prod AWS_TOKEN --exec "aws sts get-session-token --query Credentials.SessionToken"
agents secrets add prod CERT --file /path/to/cert.pem
agents secrets add prod LOG_LEVEL --env LOG_LEVEL
```

(Exec refs require creating the bundle with `--allow-exec`.)

## "What else can I do?"

Run `agents secrets --help` — there's more: viewing/revealing values, rotating secrets with preserved metadata, exporting to shell, organizing by environment or service.
