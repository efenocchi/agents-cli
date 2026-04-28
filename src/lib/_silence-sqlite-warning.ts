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
const originalEmitWarning = process.emitWarning.bind(process);

function isSqliteExperimentalWarning(arg: unknown): boolean {
  const warning = arg as { name?: string; message?: string } | undefined;
  return Boolean(
    warning &&
    warning.name === 'ExperimentalWarning' &&
    typeof warning.message === 'string' &&
    /sqlite/i.test(warning.message)
  );
}

// Patching process.emit to swallow only the SQLite ExperimentalWarning is
// narrower than --no-warnings or NODE_NO_WARNINGS, both of which would mute
// every warning class (deprecations included).
process.emit = function (event: string | symbol, ...args: unknown[]): boolean {
  if (event === 'warning') {
    if (isSqliteExperimentalWarning(args[0])) {
      return false;
    }
  }
  return (originalEmit as (event: string | symbol, ...args: unknown[]) => boolean)(event, ...args);
} as typeof process.emit;

process.emitWarning = function (warning: string | Error, ...args: unknown[]): void {
  if (isSqliteExperimentalWarning(warning)) {
    return;
  }

  if (
    typeof warning === 'string' &&
    args[0] === 'ExperimentalWarning' &&
    /sqlite/i.test(warning)
  ) {
    return;
  }

  return (originalEmitWarning as (warning: string | Error, ...args: unknown[]) => void)(warning, ...args);
} as typeof process.emitWarning;
