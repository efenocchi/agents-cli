/**
 * Side-effect module: silences the `ExperimentalWarning: SQLite is an
 * experimental feature` notice that `node:sqlite` emits on first load.
 *
 * Imported from `./sqlite.ts` BEFORE `node:sqlite` so the patch is in place
 * when the warning fires. ESM evaluates a single file's imports top-down in
 * declaration order, so this runs first.
 *
 * Other warnings (deprecation, runtime, etc.) pass through untouched.
 */

const originalEmit = process.emit.bind(process);

// Patching process.emit to swallow only the SQLite ExperimentalWarning is
// narrower than --no-warnings or NODE_NO_WARNINGS, both of which would mute
// every warning class (deprecations included).
process.emit = function (event: string | symbol, ...args: unknown[]): boolean {
  if (event === 'warning') {
    const arg = args[0] as { name?: string; message?: string } | undefined;
    if (arg && arg.name === 'ExperimentalWarning' && typeof arg.message === 'string' && /sqlite/i.test(arg.message)) {
      return false;
    }
  }
  return (originalEmit as (event: string | symbol, ...args: unknown[]) => boolean)(event, ...args);
} as typeof process.emit;
