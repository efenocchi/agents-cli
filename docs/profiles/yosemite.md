# Yosemite Local Proxy

Yosemite is the internal codename for a local-proxy pattern that routes Claude Code through a gateway like `claude-code-router` (CCR), LiteLLM, or a Synopsys-internal inference endpoint.

## Quick start

```bash
agents profiles add yosemite
# follow the prompts for your gateway URL and model ID
agents run yosemite "hello"
```

## When to use this

- **Corporate Gateways**: Your company (e.g. Synopsys) requires all LLM traffic to flow through a security/audit proxy.
- **Local Development**: You are testing a new agent-compatible API or router on your machine.
- **Custom Routing**: You want to switch backends (Bedrock, Vertex, Direct) dynamically without changing your agent config.

## Generated profile shape

```yaml
name: yosemite
host: { agent: claude }
env:
  ANTHROPIC_BASE_URL: http://127.0.0.1:3456
  ANTHROPIC_MODEL: claude-3-5-sonnet-latest
  API_TIMEOUT_MS: "600000"
```

## Auth

The `yosemite` preset is marked as `authOptional: true`. By default, it assumes your local proxy handles auth (e.g. via local machine trust or separate SSO) or that you've set `ANTHROPIC_AUTH_TOKEN` in your environment.

If your gateway requires a static bearer token:
1. Run `agents profiles login yosemite` to store the key in your macOS Keychain.
2. The `agents-cli` will automatically inject it as `ANTHROPIC_AUTH_TOKEN` when you run the profile.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `ECONNREFUSED` | Proxy is not running | Ensure your gateway/router (e.g. CCR) is started on the expected port |
| `401 Unauthorized` | Missing or invalid token | Run `agents profiles login yosemite` to provide a key |
| Timeout after 60s | Slow backend response | The preset sets `API_TIMEOUT_MS: "600000"` (10 min), but ensure your proxy isn't timing out earlier |
