import { describe, it, expect } from 'vitest';
import { extractConfiguredPort } from './profiles.js';
import type { BrowserProfile } from './types.js';

function profile(endpoints: string[]): BrowserProfile {
  return { name: 'test', browser: 'chrome', endpoints };
}

describe('extractConfiguredPort', () => {
  it('extracts explicit port from cdp://', () => {
    expect(extractConfiguredPort(profile(['cdp://localhost:9333']))).toBe(9333);
  });

  it('extracts explicit port from ssh:// with ?port=', () => {
    expect(extractConfiguredPort(profile(['ssh://mac-mini:9444']))).toBe(9444);
  });

  it('defaults to 9222 for cdp:// without explicit port', () => {
    expect(extractConfiguredPort(profile(['cdp://localhost']))).toBe(9222);
  });

  it('defaults to 9222 for ssh:// without explicit port', () => {
    expect(extractConfiguredPort(profile(['ssh://mac-mini']))).toBe(9222);
  });

  it('extracts port from ws:// and wss://', () => {
    expect(extractConfiguredPort(profile(['ws://example.com:9555']))).toBe(9555);
    expect(extractConfiguredPort(profile(['wss://example.com:9666']))).toBe(9666);
  });

  it('returns undefined for endpoint with no port and no default', () => {
    expect(extractConfiguredPort(profile(['ws://example.com']))).toBeUndefined();
  });

  it('returns undefined when endpoints empty', () => {
    expect(extractConfiguredPort(profile([]))).toBeUndefined();
  });

  it('returns undefined for malformed endpoint', () => {
    expect(extractConfiguredPort(profile(['not-a-url']))).toBeUndefined();
  });

  it('uses only the first endpoint', () => {
    expect(
      extractConfiguredPort(profile(['cdp://localhost:9001', 'cdp://localhost:9002']))
    ).toBe(9001);
  });
});
