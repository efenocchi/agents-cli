import { describe, expect, it } from 'vitest';
import { expandPreset, getPreset, listProviders } from './profiles-presets.js';

describe('profiles-presets', () => {
  it('truefoundry preset carries Bedrock-strict-validation env vars', () => {
    const p = getPreset('truefoundry');
    expect(p).toBeDefined();
    expect(p!.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS).toBe('1');
    expect(p!.env.CLAUDE_CODE_ATTRIBUTION_HEADER).toBe('0');
    expect(p!.env.DISABLE_PROMPT_CACHING).toBe('1');
  });

  it('foundry preset is Microsoft Azure AI Foundry on claude host', () => {
    const p = getPreset('foundry');
    expect(p).toBeDefined();
    expect(p!.host).toBe('claude');
    expect(p!.provider).toBe('foundry');
  });

  it('ollama preset uses codex host (not claude)', () => {
    const p = getPreset('ollama');
    expect(p).toBeDefined();
    expect(p!.host).toBe('codex');
  });

  it('expandPreset(truefoundry) returns two prompts', () => {
    const p = getPreset('truefoundry')!;
    expect(expandPreset(p).prompts).toHaveLength(2);
  });

  it('expandPreset(kimi) returns zero prompts (existing presets unchanged)', () => {
    const p = getPreset('kimi')!;
    expect(expandPreset(p).prompts).toHaveLength(0);
  });

  it('listProviders() includes all new gateway providers', () => {
    const providers = listProviders();
    for (const name of ['truefoundry', 'bedrock', 'vertex', 'foundry', 'litellm', 'vllm', 'ollama']) {
      expect(providers).toContain(name);
    }
  });
});
