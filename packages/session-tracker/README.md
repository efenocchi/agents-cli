# @agents/session-tracker

One reliable way to know which session a coding-agent CLI is currently running.

## Why

Each agent CLI (claude / codex / gemini / cursor / grok / opencode / antigravity) emits its session id differently — some via SessionStart hooks (stdin JSON), some via env vars, some only via session-file presence. swarmify and agents-cli both reinvented per-agent detection logic and both got it wrong in subtle ways (stale ids in the status bar; persisted-session fuzzy matching at restore time).

This package gives every agent **one canonical state file** at `~/.agents/.cache/terminals/sessions/<pid>.json`, written by **one polyglot SessionStart hook**, read by **one descendant-pid lookup**.

## Pieces

- `src/hook.sh` — polyglot SessionStart hook. Invoked as `hook.sh <agent>`; handles stdin-JSON (claude/codex/cursor), env-var (grok), and `gemini`/`antigravity` placeholder branches.
- `src/install-hook.ts` — wires the hook into each agent's native config file (idempotent). For claude: writes into **every** installed version's per-version settings.json under `~/.agents/.history/versions/claude/*/home/.claude/`.
- `src/state-file.ts` — canonical SessionState schema, atomic write/read, STATE_DIR const.
- `src/writer.ts` — `recordSession()` for the future fs-watch correlator (opencode etc).
- `src/reader.ts` — descendant-pid BFS (depth ≤ 5, nodes ≤ 100), terminal-id and launch-id lookups, prune-stale.
- `src/index.ts` — public API: `trackSpawn()` polls for the state file; `getLiveSession()` does the layered lookup (launchId → terminalId → shellPid).
- `src/adapters/claude.ts` — per-agent metadata + ground-truth snapshot helper (multi-root: walks every installed claude version's `projects/<workspace>/`).
- `tests/harness.ts` + `tests/smoke.test.ts` — real `agents run claude` spawn, captures ground truth from session-file appearance, compares to tracker output.

## Use

```bash
bun install
bun run install-hook claude        # idempotent — wires hook into every claude version
chmod +x src/hook.sh               # one-time
bun run test:smoke                 # spawn real claude, verify detection
```

In code:

```ts
import { trackSpawn, getLiveSession } from '@agents/session-tracker';

const detected = await trackSpawn({ agent: 'claude', agentPid, cwd, launchId });
// detected: { sessionId, method, latencyMs, confidence }

const live = await getLiveSession({ shellPid });
// live: SessionState | null
```
