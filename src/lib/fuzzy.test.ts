import { describe, it, expect } from 'vitest';
import { levenshtein, fuzzyMatch, FUZZY_PRESETS } from './fuzzy.js';

describe('levenshtein', () => {
  it('returns 0 for identical strings', () => {
    expect(levenshtein('claude', 'claude')).toBe(0);
  });

  it('returns string length for empty comparisons', () => {
    expect(levenshtein('', 'abc')).toBe(3);
    expect(levenshtein('abc', '')).toBe(3);
  });

  it('calculates correct distance for typos', () => {
    expect(levenshtein('cladue', 'claude')).toBe(2);
    expect(levenshtein('claud', 'claude')).toBe(1);
    expect(levenshtein('codx', 'codex')).toBe(1);
    expect(levenshtein('gemni', 'gemini')).toBe(1);
  });
});

describe('fuzzyMatch', () => {
  const agents = ['claude', 'codex', 'gemini', 'cursor', 'opencode', 'openclaw', 'copilot', 'amp', 'kiro', 'goose', 'roo'];

  it('returns null for exact matches (fuzzy is for non-exact)', () => {
    expect(fuzzyMatch('claude', agents, FUZZY_PRESETS.agents)).toBeNull();
  });

  it('matches common typos', () => {
    expect(fuzzyMatch('cladue', agents, FUZZY_PRESETS.agents)).toBe('claude');
    expect(fuzzyMatch('claud', agents, FUZZY_PRESETS.agents)).toBe('claude');
    expect(fuzzyMatch('codx', agents, FUZZY_PRESETS.agents)).toBe('codex');
  });

  it('returns null for ambiguous inputs', () => {
    expect(fuzzyMatch('co', agents, FUZZY_PRESETS.agents)).toBeNull();
  });

  it('returns null for inputs too far from any candidate', () => {
    expect(fuzzyMatch('xyz', agents, FUZZY_PRESETS.agents)).toBeNull();
  });

  it('respects maxDistance for efforts (strict)', () => {
    const efforts = ['low', 'medium', 'high', 'xhigh', 'max', 'auto'];
    expect(fuzzyMatch('hgih', efforts, FUZZY_PRESETS.efforts)).toBeNull();
    expect(fuzzyMatch('hih', efforts, FUZZY_PRESETS.efforts)).toBe('high');
  });

  it('uses ratio-based threshold for dynamic presets', () => {
    const profiles = ['default', 'my-super-long-profile-name'];
    expect(fuzzyMatch('defult', profiles, FUZZY_PRESETS.dynamic)).toBe('default');
  });
});
