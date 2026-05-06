import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { getUserAgentsDir } from '../state.js';

describe('cloud path roots', () => {
  it('reads cloud config from ~/.agents/agents.yaml', async () => {
    const { getDefaultProviderId } = await import('./registry.js');
    expect(getDefaultProviderId()).toBeDefined();
    expect(path.join(getUserAgentsDir(), 'agents.yaml')).toBe(
      path.join(process.env.HOME!, '.agents', 'agents.yaml'),
    );
  });

  it('stores cloud task state and consent under ~/.agents/cloud', () => {
    expect(path.join(getUserAgentsDir(), 'cloud', 'tasks.db')).toBe(
      path.join(process.env.HOME!, '.agents', 'cloud', 'tasks.db'),
    );
    expect(path.join(getUserAgentsDir(), 'cloud', 'rush-consent.json')).toBe(
      path.join(process.env.HOME!, '.agents', 'cloud', 'rush-consent.json'),
    );
  });
});
