// Action verbs for `agents computer` — the interaction surface over the
// computer-helper daemon's RPC methods (click, type, key, drag, scroll,
// describe, ax-action, focus, ...). These mirror `agents browser`'s verb
// layout: flat verbs under the noun, bundle-id targeting, --json on reads.
//
// The daemon already implements every method; this file is the thin, typed
// CLI skin over it plus a shared target resolver so callers stay in bundle-id
// space and never hand-manage pids.

import { Command } from 'commander';
import {
  openComputerClient,
  describeTransport,
  type ComputerClient,
  type RPCResponse,
} from '../lib/computer-rpc.js';

export interface AppInfo {
  pid: number;
  name: string;
  bundle_id: string;
  active: boolean;
}

// Pure target picker — exercised by unit tests. Precedence: explicit --pid,
// then --bundle, then the frontmost active allow-listed app (the same default
// `screenshot` uses). Kept side-effect-free so the resolution rules are
// testable without a live daemon.
export function pickTarget(
  list: AppInfo[],
  opts: { pid?: number; bundle?: string },
): { ok: true; app: AppInfo } | { ok: false; error: string } {
  if (opts.pid != null) {
    const app = list.find((a) => a.pid === opts.pid);
    // A --pid the daemon doesn't list (not allow-listed / not running) is
    // still passed through: the daemon is the authority and will return a
    // precise permission_denied / app_not_found. We don't second-guess it.
    return { ok: true, app: app ?? { pid: opts.pid, name: '', bundle_id: '', active: false } };
  }
  if (opts.bundle) {
    const app = list.find((a) => a.bundle_id === opts.bundle);
    if (!app) {
      return {
        ok: false,
        error: `bundle not in allow list (or not running): ${opts.bundle}\nadd Computer(${opts.bundle}) to a permissions group, then \`agents computer reload\``,
      };
    }
    return { ok: true, app };
  }
  const active = list.find((a) => a.active);
  if (!active) {
    return {
      ok: false,
      error: 'no active app found in allow list\nadd Computer(<bundle-id>) to a permissions group, then `agents computer reload`',
    };
  }
  return { ok: true, app: active };
}

// Parse an "x,y" coordinate pair. Pure + tested.
export function parseXY(s: string, flag: string): { x: number; y: number } {
  const parts = s.split(',').map((v) => v.trim());
  if (parts.length !== 2) {
    throw new Error(`${flag} must be "x,y" (got: ${s})`);
  }
  const x = Number(parts[0]);
  const y = Number(parts[1]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error(`${flag} must be two numbers "x,y" (got: ${s})`);
  }
  return { x, y };
}

// Build the element-or-coords target spec shared by click/type/scroll/etc.
// Pure + tested: returns the params fragment or an error string.
export function buildElementOrCoords(opts: {
  id?: string;
  x?: number;
  y?: number;
}): { ok: true; params: Record<string, unknown> } | { ok: false; error: string } {
  if (opts.id) return { ok: true, params: { element_id: opts.id } };
  if (opts.x != null && opts.y != null) return { ok: true, params: { x: opts.x, y: opts.y } };
  return { ok: false, error: 'pass --id <@eN> (from `describe`) or --x <n> --y <n>' };
}

function reportMissingHelper(): never {
  console.error('helper not built. Run: ./packages/computer-helper/scripts/build.sh debug');
  process.exit(1);
}

// Open a client, run fn, always close. Fails fast if no helper is present.
export async function withClient<T>(fn: (client: ComputerClient) => Promise<T>): Promise<T> {
  if (describeTransport().kind === 'none') reportMissingHelper();
  const client = openComputerClient();
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

// Unwrap an RPC response: print + exit on error, else return result.
export function unwrap(r: RPCResponse): Record<string, unknown> {
  if (r.error) {
    console.error(`error: ${r.error.code}: ${r.error.message}`);
    process.exit(1);
  }
  return r.result ?? {};
}

// Resolve the target pid via list_apps + pickTarget, printing a precise error
// and exiting when no target matches.
async function resolveTargetPid(client: ComputerClient, opts: { pid?: number; bundle?: string }): Promise<number> {
  // A directly-supplied pid skips the list_apps roundtrip — the daemon gates.
  if (opts.pid != null) return opts.pid;
  const apps = unwrap(await client.call('list_apps'));
  const list = (apps.apps as AppInfo[]) || [];
  const picked = pickTarget(list, opts);
  if (!picked.ok) {
    console.error(picked.error);
    process.exit(1);
  }
  return picked.app.pid;
}

function emit(result: Record<string, unknown>, json: boolean, human: () => string): void {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(human());
  }
}

// Add the shared --pid/--bundle target options to a verb.
function addTargetOpts(cmd: Command): Command {
  return cmd
    .option('--bundle <id>', 'Bundle id of the target app (default: frontmost allow-listed app)')
    .option('--pid <n>', 'Target pid directly (overrides --bundle)', (v) => parseInt(v, 10));
}

// Add the shared --id/--x/--y element-or-coords options to a verb.
function addElementOrCoordOpts(cmd: Command): Command {
  return cmd
    .option('--id <@eN>', 'Element id from `describe`')
    .option('--x <n>', 'X coordinate (global, points)', (v) => parseInt(v, 10))
    .option('--y <n>', 'Y coordinate (global, points)', (v) => parseInt(v, 10));
}

type TargetOpts = { pid?: number; bundle?: string; json?: boolean };
type ElemOpts = TargetOpts & { id?: string; x?: number; y?: number };

export function registerActionCommands(program: Command): void {
  // apps — list_apps
  addTargetOpts(
    program
      .command('apps')
      .description('List apps the daemon may drive (allow-listed + running)')
      .option('--json', 'Emit JSON'),
  ).action(async (opts: TargetOpts) => {
    await withClient(async (client) => {
      const res = unwrap(await client.call('list_apps'));
      const list = (res.apps as AppInfo[]) || [];
      emit(res, Boolean(opts.json), () =>
        list.length === 0
          ? '(no allow-listed apps running)'
          : list
              .map((a) => `${a.active ? '*' : ' '} ${String(a.pid).padStart(6)}  ${a.bundle_id}  ${a.name}`)
              .join('\n'),
      );
    });
  });

  // describe — AX tree
  addTargetOpts(
    program
      .command('describe')
      .description('Dump the accessibility tree (element ids feed click/type --id)')
      .option('--depth <n>', 'Max tree depth', (v) => parseInt(v, 10))
      .option('--json', 'Emit compact JSON (default: pretty)'),
  ).action(async (opts: TargetOpts & { depth?: number }) => {
    await withClient(async (client) => {
      const pid = await resolveTargetPid(client, opts);
      const params: Record<string, unknown> = { pid };
      if (opts.depth != null) params.max_depth = opts.depth;
      const res = unwrap(await client.call('describe', params));
      // The tree is inherently structured — always JSON, pretty unless --json.
      console.log(JSON.stringify(opts.json ? res : res.tree ?? res, null, 2));
    });
  });

  // click
  addElementOrCoordOpts(
    addTargetOpts(
      program
        .command('click')
        .description('Click an element (--id) or screen coordinate (--x --y)')
        .option('--count <n>', 'Click count (2 = double-click)', (v) => parseInt(v, 10))
        .option('--background', 'Focus-safe postToPid delivery (plain AppKit only; skips HID tap)')
        .option('--json', 'Emit JSON'),
    ),
  ).action(async (opts: ElemOpts & { count?: number; background?: boolean }) => {
    await withClient(async (client) => {
      const pid = await resolveTargetPid(client, opts);
      const spec = buildElementOrCoords(opts);
      if (!spec.ok) {
        console.error(spec.error);
        process.exit(1);
      }
      const params: Record<string, unknown> = { pid, ...spec.params };
      if (opts.count != null) params.count = opts.count;
      if (opts.background) params.background = true;
      const res = unwrap(await client.call('click', params));
      emit(res, Boolean(opts.json), () => `clicked (${res.action ?? 'ok'})`);
    });
  });

  // right-click
  addElementOrCoordOpts(
    addTargetOpts(
      program
        .command('right-click')
        .description('Right-click (context menu) an element or coordinate')
        .option('--json', 'Emit JSON'),
    ),
  ).action(async (opts: ElemOpts) => {
    await withClient(async (client) => {
      const pid = await resolveTargetPid(client, opts);
      const spec = buildElementOrCoords(opts);
      if (!spec.ok) {
        console.error(spec.error);
        process.exit(1);
      }
      const res = unwrap(await client.call('right_click', { pid, ...spec.params }));
      emit(res, Boolean(opts.json), () => `right-clicked (${res.method ?? 'ok'})`);
    });
  });

  // type — set value on a field (--id) or paste at coords, optional commit
  addElementOrCoordOpts(
    addTargetOpts(
      program
        .command('type')
        .description('Set a field value (--id) or paste at a coordinate (--x --y)')
        .requiredOption('--text <s>', 'Text to enter')
        .option('--commit', 'Commit after typing (AXConfirm / Return) so the value reaches the model')
        .option('--allow-secure-field', 'Permit typing into a password field')
        .option('--json', 'Emit JSON'),
    ),
  ).action(async (opts: ElemOpts & { text: string; commit?: boolean; allowSecureField?: boolean }) => {
    await withClient(async (client) => {
      const pid = await resolveTargetPid(client, opts);
      const spec = buildElementOrCoords(opts);
      if (!spec.ok) {
        console.error(spec.error);
        process.exit(1);
      }
      const params: Record<string, unknown> = { pid, ...spec.params, text: opts.text };
      if (opts.commit) params.commit = true;
      if (opts.allowSecureField) params.allow_secure_field = true;
      const res = unwrap(await client.call('type', params));
      emit(res, Boolean(opts.json), () => `typed ${opts.text.length} char(s)${res.committed ? ' (committed)' : ''}`);
    });
  });

  // type-text — stream an arbitrary unicode string into the focused field
  addTargetOpts(
    program
      .command('type-text')
      .description('Type an arbitrary unicode string into the focused field (focus first via click/focus)')
      .requiredOption('--text <s>', 'Text to type')
      .option('--commit', 'Press Return after typing')
      .option('--json', 'Emit JSON'),
  ).action(async (opts: TargetOpts & { text: string; commit?: boolean }) => {
    await withClient(async (client) => {
      const pid = await resolveTargetPid(client, opts);
      const params: Record<string, unknown> = { pid, text: opts.text };
      if (opts.commit) params.commit = true;
      const res = unwrap(await client.call('type_text', params));
      emit(res, Boolean(opts.json), () => `typed ${res.chars ?? opts.text.length} char(s)`);
    });
  });

  // key — single chord
  addTargetOpts(
    program
      .command('key')
      .description('Send a key chord, e.g. "cmd+shift+s", "enter", "esc"')
      .requiredOption('--keys <chord>', 'Key chord')
      .option('--json', 'Emit JSON'),
  ).action(async (opts: TargetOpts & { keys: string }) => {
    await withClient(async (client) => {
      const pid = await resolveTargetPid(client, opts);
      const res = unwrap(await client.call('key', { pid, keys: opts.keys }));
      emit(res, Boolean(opts.json), () => `sent ${opts.keys}`);
    });
  });

  // drag — from one point to another
  addTargetOpts(
    program
      .command('drag')
      .description('Drag from one coordinate to another')
      .requiredOption('--from <x,y>', 'Start coordinate "x,y"')
      .requiredOption('--to <x,y>', 'End coordinate "x,y"')
      .option('--button <left|right>', 'Mouse button', 'left')
      .option('--background', 'Focus-safe postToPid delivery (plain AppKit only)')
      .option('--json', 'Emit JSON'),
  ).action(async (opts: TargetOpts & { from: string; to: string; button: string; background?: boolean }) => {
    let from: { x: number; y: number };
    let to: { x: number; y: number };
    try {
      from = parseXY(opts.from, '--from');
      to = parseXY(opts.to, '--to');
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
    await withClient(async (client) => {
      const pid = await resolveTargetPid(client, opts);
      const params: Record<string, unknown> = {
        pid,
        from: [from.x, from.y],
        to: [to.x, to.y],
        button: opts.button,
      };
      if (opts.background) params.background = true;
      const res = unwrap(await client.call('drag', params));
      emit(res, Boolean(opts.json), () => `dragged ${opts.from} -> ${opts.to} (${res.method ?? 'ok'})`);
    });
  });

  // scroll — by delta at an element or coordinate
  addElementOrCoordOpts(
    addTargetOpts(
      program
        .command('scroll')
        .description('Scroll by a pixel delta at an element or coordinate')
        .option('--dy <n>', 'Vertical delta (negative = down)', (v) => parseInt(v, 10))
        .option('--dx <n>', 'Horizontal delta', (v) => parseInt(v, 10))
        .option('--json', 'Emit JSON'),
    ),
  ).action(async (opts: ElemOpts & { dy?: number; dx?: number }) => {
    await withClient(async (client) => {
      const pid = await resolveTargetPid(client, opts);
      const params: Record<string, unknown> = { pid };
      if (opts.id) params.element_id = opts.id;
      if (opts.x != null) params.x = opts.x;
      if (opts.y != null) params.y = opts.y;
      if (opts.dy != null) params.dy = opts.dy;
      if (opts.dx != null) params.dx = opts.dx;
      const res = unwrap(await client.call('scroll', params));
      emit(res, Boolean(opts.json), () => `scrolled (${res.method ?? 'ok'})`);
    });
  });

  // ax-action — perform any advertised AX action on an element
  addTargetOpts(
    program
      .command('ax-action')
      .description('Perform an arbitrary AX action (AXConfirm, AXCancel, AXRaise, ...) on an element')
      .requiredOption('--id <@eN>', 'Element id from `describe`')
      .requiredOption('--action <name>', 'AX action name')
      .option('--json', 'Emit JSON'),
  ).action(async (opts: TargetOpts & { id: string; action: string }) => {
    await withClient(async (client) => {
      const pid = await resolveTargetPid(client, opts);
      const res = unwrap(await client.call('ax_action', { pid, element_id: opts.id, action: opts.action }));
      emit(res, Boolean(opts.json), () => `performed ${opts.action}`);
    });
  });

  // focus — set keyboard focus to an element
  addTargetOpts(
    program
      .command('focus')
      .description('Set keyboard focus to an element (so type-text/key land there)')
      .requiredOption('--id <@eN>', 'Element id from `describe`')
      .option('--json', 'Emit JSON'),
  ).action(async (opts: TargetOpts & { id: string }) => {
    await withClient(async (client) => {
      const pid = await resolveTargetPid(client, opts);
      const res = unwrap(await client.call('set_focus', { pid, element_id: opts.id }));
      emit(res, Boolean(opts.json), () => `focused ${opts.id}`);
    });
  });
}
