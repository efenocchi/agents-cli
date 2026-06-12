import { describe, expect, it } from 'vitest';
import {
  pickTarget,
  parseXY,
  buildElementOrCoords,
  buildRaiseParams,
  buildWaitParams,
  type AppInfo,
} from './computer-actions.js';
import { resolveRpcTimeoutMs, RPC_TIMEOUT_MS } from '../lib/computer-rpc.js';

const apps: AppInfo[] = [
  { pid: 100, name: 'Finder', bundle_id: 'com.apple.finder', active: false },
  { pid: 200, name: 'Photoshop', bundle_id: 'com.adobe.Photoshop', active: true },
  { pid: 300, name: 'Notes', bundle_id: 'com.apple.notes', active: false },
];

describe('pickTarget', () => {
  it('prefers an explicit pid, returning the matching app', () => {
    const r = pickTarget(apps, { pid: 300 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.app.bundle_id).toBe('com.apple.notes');
  });

  it('passes through a pid the daemon does not list (daemon is the authority)', () => {
    const r = pickTarget(apps, { pid: 999 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.app.pid).toBe(999);
      expect(r.app.bundle_id).toBe('');
    }
  });

  it('pid wins over bundle when both are given', () => {
    const r = pickTarget(apps, { pid: 100, bundle: 'com.adobe.Photoshop' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.app.pid).toBe(100);
  });

  it('resolves a bundle id to its running pid', () => {
    const r = pickTarget(apps, { bundle: 'com.adobe.Photoshop' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.app.pid).toBe(200);
  });

  it('errors when the bundle is not running / not allow-listed', () => {
    const r = pickTarget(apps, { bundle: 'com.unknown.app' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('com.unknown.app');
  });

  it('falls back to the frontmost active app when neither pid nor bundle is given', () => {
    const r = pickTarget(apps, {});
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.app.pid).toBe(200);
  });

  it('errors when nothing is active and no target is specified', () => {
    const noneActive = apps.map((a) => ({ ...a, active: false }));
    const r = pickTarget(noneActive, {});
    expect(r.ok).toBe(false);
  });
});

describe('parseXY', () => {
  it('parses a valid coordinate pair', () => {
    expect(parseXY('18,136', '--from')).toEqual({ x: 18, y: 136 });
  });

  it('tolerates surrounding whitespace', () => {
    expect(parseXY(' 18 , 136 ', '--to')).toEqual({ x: 18, y: 136 });
  });

  it('parses negative coordinates', () => {
    expect(parseXY('-5,-10', '--from')).toEqual({ x: -5, y: -10 });
  });

  it('throws on the wrong number of parts', () => {
    expect(() => parseXY('18', '--from')).toThrow('--from');
    expect(() => parseXY('1,2,3', '--from')).toThrow('--from');
  });

  it('throws on non-numeric parts', () => {
    expect(() => parseXY('a,b', '--to')).toThrow('--to');
  });
});

describe('buildElementOrCoords', () => {
  it('builds an element_id spec from --id', () => {
    const r = buildElementOrCoords({ id: '@e7' });
    expect(r).toEqual({ ok: true, params: { element_id: '@e7' } });
  });

  it('builds an x/y spec from coordinates', () => {
    const r = buildElementOrCoords({ x: 18, y: 136 });
    expect(r).toEqual({ ok: true, params: { x: 18, y: 136 } });
  });

  it('prefers --id over coordinates when both are present', () => {
    const r = buildElementOrCoords({ id: '@e7', x: 1, y: 2 });
    expect(r).toEqual({ ok: true, params: { element_id: '@e7' } });
  });

  it('errors when neither target is provided', () => {
    const r = buildElementOrCoords({});
    expect(r.ok).toBe(false);
  });

  it('errors when only one coordinate is provided', () => {
    const r = buildElementOrCoords({ x: 18 });
    expect(r.ok).toBe(false);
  });
});

describe('buildRaiseParams', () => {
  it('returns empty params for an app-level raise', () => {
    expect(buildRaiseParams({})).toEqual({});
  });

  it('builds a window_id param', () => {
    expect(buildRaiseParams({ windowId: 127403 })).toEqual({ window_id: 127403 });
  });

  it('builds a title param', () => {
    expect(buildRaiseParams({ title: 'Windows 11' })).toEqual({ title: 'Windows 11' });
  });

  it('passes both refinements through when given', () => {
    expect(buildRaiseParams({ windowId: 5, title: 'VM' })).toEqual({ window_id: 5, title: 'VM' });
  });
});

describe('buildWaitParams', () => {
  it('duration wins over every other mode', () => {
    const r = buildWaitParams({ duration: 500, id: '@e1', role: 'AXButton' });
    expect(r).toEqual({ ok: true, params: { duration_ms: 500 } });
  });

  it('builds an element poll from --id', () => {
    const r = buildWaitParams({ id: '@e3', until: 'enabled', timeout: 2000 });
    expect(r).toEqual({ ok: true, params: { until: 'enabled', timeout_ms: 2000, element_id: '@e3' } });
  });

  it('element id wins over a locator', () => {
    const r = buildWaitParams({ id: '@e3', role: 'AXButton' });
    expect(r).toEqual({ ok: true, params: { element_id: '@e3' } });
  });

  it('builds a locator from role/label/identifier', () => {
    const r = buildWaitParams({ role: 'AXButton', label: 'Save' });
    expect(r).toEqual({ ok: true, params: { locator: { role: 'AXButton', label: 'Save' } } });
  });

  it('errors when no mode is selected', () => {
    const r = buildWaitParams({});
    expect(r.ok).toBe(false);
  });

  it('errors when only --until/--timeout are given (no target)', () => {
    const r = buildWaitParams({ until: 'exists', timeout: 1000 });
    expect(r.ok).toBe(false);
  });
});

describe('resolveRpcTimeoutMs', () => {
  it('defaults to RPC_TIMEOUT_MS when the env var is unset', () => {
    expect(resolveRpcTimeoutMs(undefined)).toBe(RPC_TIMEOUT_MS);
  });

  it('parses a positive override', () => {
    expect(resolveRpcTimeoutMs('5000')).toBe(5000);
  });

  it('rejects garbage and non-positive values', () => {
    expect(resolveRpcTimeoutMs('abc')).toBe(RPC_TIMEOUT_MS);
    expect(resolveRpcTimeoutMs('0')).toBe(RPC_TIMEOUT_MS);
    expect(resolveRpcTimeoutMs('-1')).toBe(RPC_TIMEOUT_MS);
  });
});
