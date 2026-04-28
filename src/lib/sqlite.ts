/**
 * Thin compatibility shim over Node's built-in `node:sqlite`.
 *
 * Mirrors the subset of better-sqlite3's API this codebase uses so call sites
 * don't need to change. Replaces the better-sqlite3 native addon, eliminating
 * the prebuild-install deprecation chain and the postinstall compile.
 *
 * Requires Node >= 22.5.0 for `node:sqlite`.
 */

import './_silence-sqlite-warning.js';
import { DatabaseSync, type StatementSync } from 'node:sqlite';

export interface RunResult {
  changes: number | bigint;
  lastInsertRowid: number | bigint;
}

function bindArgs(params: unknown[]): unknown[] {
  // better-sqlite3 accepts both `stmt.run(a, b, c)` and `stmt.run({ a, b, c })`.
  // node:sqlite has the same dual signature; pass the object through unchanged
  // when the caller used named-parameter form.
  if (
    params.length === 1 &&
    params[0] !== null &&
    typeof params[0] === 'object' &&
    !Array.isArray(params[0])
  ) {
    return [params[0]];
  }
  return params;
}

// The generic `T` is preserved for source compatibility with better-sqlite3's
// `Statement<BindParams>` type signature at call sites; it isn't enforced.
// All call sites in this codebase cast results explicitly, so untyped returns
// match the existing pattern.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
class StatementImpl<_T = unknown> {
  constructor(private readonly inner: StatementSync) {}

  run(...params: unknown[]): RunResult {
    return this.inner.run(...(bindArgs(params) as Parameters<StatementSync['run']>));
  }

  get(...params: unknown[]): unknown {
    return this.inner.get(...(bindArgs(params) as Parameters<StatementSync['get']>));
  }

  all(...params: unknown[]): unknown[] {
    return this.inner.all(...(bindArgs(params) as Parameters<StatementSync['all']>));
  }
}

class Database {
  private readonly inner: DatabaseSync;

  constructor(filename: string) {
    this.inner = new DatabaseSync(filename);
  }

  prepare<T = unknown>(sql: string): StatementImpl<T> {
    return new StatementImpl<T>(this.inner.prepare(sql));
  }

  exec(sql: string): void {
    this.inner.exec(sql);
  }

  // better-sqlite3 has a dedicated `pragma()` method; node:sqlite doesn't.
  // For setter pragmas (`journal_mode = WAL`) `exec` is enough; reader pragmas
  // (`PRAGMA table_info(...)`) in this codebase use `db.prepare(...).all()`.
  pragma(stmt: string): void {
    this.inner.exec(`PRAGMA ${stmt}`);
  }

  // Wraps a function in BEGIN/COMMIT, with ROLLBACK on throw. Mirrors
  // better-sqlite3's `db.transaction(fn)` shape — returns a callable that
  // forwards arguments through and propagates errors.
  transaction<Args extends unknown[], R>(fn: (...args: Args) => R): (...args: Args) => R {
    return (...args: Args): R => {
      this.inner.exec('BEGIN');
      try {
        const result = fn(...args);
        this.inner.exec('COMMIT');
        return result;
      } catch (err) {
        try { this.inner.exec('ROLLBACK'); } catch { /* original error wins */ }
        throw err;
      }
    };
  }

  close(): void {
    this.inner.close();
  }
}

// Declaration merging keeps the existing `Database.Database` and
// `Database.Statement<T>` type references working without rewrites.
// eslint-disable-next-line @typescript-eslint/no-namespace
namespace Database {
  export type Database = InstanceType<typeof DatabaseConstructor>;
  export type Statement<T = unknown> = StatementImpl<T>;
}

const DatabaseConstructor = Database;

export default Database;
