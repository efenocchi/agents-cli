/**
 * Thin compatibility shim over `better-sqlite3`.
 *
 * Keeps the rest of the codebase on the small better-sqlite3-shaped surface
 * area it already expects, so call sites don't need to know which SQLite
 * implementation sits underneath.
 */

import BetterSqlite3 from 'better-sqlite3';

export interface RunResult {
  changes: number | bigint;
  lastInsertRowid: number | bigint;
}

function bindArgs(params: unknown[]): unknown[] {
  // better-sqlite3 accepts both `stmt.run(a, b, c)` and `stmt.run({ a, b, c })`.
  // Pass the object through unchanged when the caller used named-parameter form.
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
  constructor(private readonly inner: any) {}

  run(...params: unknown[]): RunResult {
    return this.inner.run(...bindArgs(params));
  }

  get(...params: unknown[]): unknown {
    return this.inner.get(...bindArgs(params));
  }

  all(...params: unknown[]): unknown[] {
    return this.inner.all(...bindArgs(params));
  }
}

class Database {
  private readonly inner: any;

  constructor(filename: string) {
    this.inner = new BetterSqlite3(filename);
  }

  prepare<T = unknown>(sql: string): StatementImpl<T> {
    return new StatementImpl<T>(this.inner.prepare(sql));
  }

  exec(sql: string): void {
    this.inner.exec(sql);
  }

  pragma(stmt: string): void {
    this.inner.pragma(stmt);
  }

  transaction<Args extends unknown[], R>(fn: (...args: Args) => R): (...args: Args) => R {
    const txn = this.inner.transaction(fn);
    return (...args: Args): R => txn(...args);
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
