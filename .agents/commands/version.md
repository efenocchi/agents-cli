---
description: Show agents-cli and pinned agent CLI versions for this workspace
agents:
  - claude
  - codex
  - gemini
  - cursor
  - opencode
  - copilot
  - grok
---

Report which agent CLIs are installed and which versions this project pins.

Run:

```bash
agents --version
agents view
```

If `agents view --json` is available in this build, prefer it for structured output.

Summarize from the command output only:

- agents-cli version
- Each managed agent's pinned or default version
- Whether each agent CLI binary is on PATH

Do not guess versions. If a command fails, say which one failed and show stderr.