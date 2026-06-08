/**
 * Registry coverage test — the assertion that would have caught the grok
 * silent-skip class. For every (agent, kind) pair where the capability
 * matrix says "supported," both a writer and a detector must exist in the
 * registry, OR the pair must be on the `isExempt` allow-list inside
 * registry.ts.
 *
 * Also exercises the registry's lazy assertion entry point so that any
 * regression that breaks the cycle protection surfaces here, not on a
 * production CLI launch.
 */
import { describe, expect, it } from 'vitest';
import { AGENTS } from '../agents.js';
import { supports } from '../capabilities.js';
import type { AgentId } from '../types.js';
import {
  ALL_RESOURCE_KINDS,
  WRITERS,
  DETECTORS,
  kindToCapability,
  assertRegistryComplete,
  type ResourceKind,
} from './registry.js';

function isExempt(agent: AgentId, kind: ResourceKind): boolean {
  if (kind === 'skills' && AGENTS[agent].nativeAgentsSkillsDir) return true;
  return false;
}

describe('staleness/registry', () => {
  it('boots without throwing', () => {
    expect(() => assertRegistryComplete()).not.toThrow();
  });

  it('every supported (agent, kind) has both a writer and a detector', () => {
    const gaps: string[] = [];
    for (const kind of ALL_RESOURCE_KINDS) {
      const cap = kindToCapability(kind);
      for (const agent of Object.keys(AGENTS) as AgentId[]) {
        if (!supports(agent, cap).ok) continue;
        if (isExempt(agent, kind)) continue;
        if (!WRITERS[kind][agent]) gaps.push(`writer ${kind}/${agent}`);
        if (!DETECTORS[kind][agent]) gaps.push(`detector ${kind}/${agent}`);
      }
    }
    expect(gaps).toEqual([]);
  });

  it('grok has a rules writer (covers the silent-skip bug)', () => {
    expect(WRITERS.rules.grok).toBeDefined();
    expect(DETECTORS.rules.grok).toBeDefined();
  });

  it('grok has a commands writer for commands-as-skills', () => {
    // grok.capabilities.commands === false, but the commands writer is
    // registered because it ALSO handles commands-as-skills via the
    // shouldInstallCommandAsSkill path.
    expect(WRITERS.commands.grok).toBeDefined();
    expect(DETECTORS.commands.grok).toBeDefined();
  });

  it('grok has a permissions writer + detector', () => {
    expect(WRITERS.permissions.grok).toBeDefined();
    expect(DETECTORS.permissions.grok).toBeDefined();
  });

  it('antigravity has a permissions writer + detector', () => {
    expect(WRITERS.permissions.antigravity).toBeDefined();
    expect(DETECTORS.permissions.antigravity).toBeDefined();
  });

  // Gemini's allowlist capability is `false` in the matrix today even though
  // applyPermissionsToVersion has a Gemini branch. Flipping that capability
  // is its own PR — when it lands, add the assertion here.
});
