import { describe, it, expect } from 'vitest';
import { normalizeBrowserName, verifyBrowserIdentity } from './cdp.js';

describe('normalizeBrowserName', () => {
  it('strips version suffix and lowercases', () => {
    expect(normalizeBrowserName('Chrome/126.0.6478.126')).toBe('chrome');
    expect(normalizeBrowserName('Comet/3.0.0')).toBe('comet');
    expect(normalizeBrowserName('HeadlessChrome/118.0')).toBe('headlesschrome');
  });

  it('returns "unknown" for empty or missing input', () => {
    expect(normalizeBrowserName('')).toBe('unknown');
  });

  it('hyphenates spaces (e.g. "Brave Browser")', () => {
    expect(normalizeBrowserName('Brave Browser/1.50')).toBe('brave-browser');
    expect(normalizeBrowserName('Microsoft Edge/118.0')).toBe('microsoft-edge');
  });

  it('handles bare browser name without version', () => {
    expect(normalizeBrowserName('Chrome')).toBe('chrome');
  });
});

describe('verifyBrowserIdentity', () => {
  it('passes when reported matches expected', () => {
    expect(() => verifyBrowserIdentity('chrome', 'chrome', 9222)).not.toThrow();
    expect(() => verifyBrowserIdentity('comet', 'comet', 9222)).not.toThrow();
  });

  it('skips check when expected is "custom"', () => {
    expect(() => verifyBrowserIdentity('comet', 'custom', 9222)).not.toThrow();
    expect(() => verifyBrowserIdentity('whatever-electron', 'custom', 9222)).not.toThrow();
  });

  it('skips check when reported is "unknown"', () => {
    expect(() => verifyBrowserIdentity('unknown', 'chrome', 9222)).not.toThrow();
  });

  it('throws when reported does not match expected', () => {
    expect(() => verifyBrowserIdentity('comet', 'chrome', 9222)).toThrow(
      /profile expects "chrome" but port 9222 is serving "comet"/
    );
  });

  it('error message includes recovery hint with reported name', () => {
    const fn = () => verifyBrowserIdentity('comet', 'chrome', 9222);
    expect(fn).toThrow(/pkill -f comet/);
    expect(fn).toThrow(/update the profile to browser=comet/);
  });

  it('uses host:port format for non-localhost hosts', () => {
    expect(() => verifyBrowserIdentity('comet', 'chrome', 9222, 'mac-mini')).toThrow(
      /mac-mini:9222 is serving "comet"/
    );
  });

  it('accepts chrome alias "google-chrome"', () => {
    expect(() => verifyBrowserIdentity('google-chrome', 'chrome', 9222)).not.toThrow();
  });

  it('accepts chromium for headlesschrome', () => {
    expect(() => verifyBrowserIdentity('headlesschrome', 'chromium', 9222)).not.toThrow();
  });

  it('accepts edge aliases', () => {
    expect(() => verifyBrowserIdentity('msedge', 'edge', 9222)).not.toThrow();
    expect(() => verifyBrowserIdentity('microsoft-edge', 'edge', 9222)).not.toThrow();
  });

  it('accepts brave-browser for brave', () => {
    expect(() => verifyBrowserIdentity('brave-browser', 'brave', 9222)).not.toThrow();
  });

  it('accepts chrome for chromium (Chromium-family browsers report Chrome/<version>)', () => {
    expect(() => verifyBrowserIdentity('chrome', 'chromium', 9222)).not.toThrow();
  });

  it('accepts chrome for brave (Brave reports Chrome/<version> in /json/version)', () => {
    expect(() => verifyBrowserIdentity('chrome', 'brave', 9222)).not.toThrow();
  });

  it('accepts chrome for edge (Edge reports Chrome/<version> in /json/version)', () => {
    expect(() => verifyBrowserIdentity('chrome', 'edge', 9222)).not.toThrow();
  });
});
