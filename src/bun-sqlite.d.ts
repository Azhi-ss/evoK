/**
 * The subset of Bun's built-in SQLite module this repository uses. Bun ships the
 * types with its runtime rather than with `@types`, and this project typechecks
 * with plain `tsc`, so the surface is declared here (same reason `bun:test` is).
 */
declare module "bun:sqlite" {
  export interface Statement {
    run(...params: readonly unknown[]): unknown;
    get(...params: readonly unknown[]): unknown;
    all(...params: readonly unknown[]): unknown[];
  }

  export class Database {
    constructor(filename?: string, options?: { readonly?: boolean; create?: boolean; readwrite?: boolean });
    exec(sql: string): void;
    query(sql: string): Statement;
    prepare(sql: string): Statement;
    run(sql: string, ...params: readonly unknown[]): unknown;
    transaction<F extends (...args: any[]) => any>(fn: F): F;
    close(): void;
  }
}
