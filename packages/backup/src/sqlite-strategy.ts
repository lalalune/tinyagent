import { createRequire } from "node:module";
import { join } from "node:path";
import { err, ok, TinyAgentError, type Result } from "@tinyagent/core";

export interface SnapshotStrategy {
  readonly name: string;
  snapshot(stateDir: string): Promise<Result<string[]>>;
}

export interface SqliteStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): unknown;
}

export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

export interface NodeSqliteModule {
  DatabaseSync: new (
    path: string,
    options?: { readOnly?: boolean },
  ) => SqliteDatabase;
  backup?: (
    source: unknown,
    destination: string,
    options?: { rate?: number },
  ) => Promise<number>;
}

export function loadNodeSqlite(): NodeSqliteModule | null {
  try {
    const require = createRequire(import.meta.url);
    const mod = require("node:sqlite") as NodeSqliteModule;
    if (typeof mod?.DatabaseSync !== "function") return null;
    return mod;
  } catch {
    return null;
  }
}

export interface SqliteSnapshotInput {
  sourceDbPath: string;
  destFileName?: string;
}

export class SqliteOnlineBackupStrategy implements SnapshotStrategy {
  readonly name = "sqlite-online-v1";

  constructor(private readonly input: SqliteSnapshotInput) {}

  async snapshot(stateDir: string): Promise<Result<string[]>> {
    const sqlite = loadNodeSqlite();
    if (!sqlite) {
      return err(
        new TinyAgentError(
          "SQLITE_BACKUP_UNSUPPORTED",
          "node:sqlite is not available in this runtime; online SQLite backup is unsupported here",
        ),
      );
    }
    try {
      const destName = this.input.destFileName ?? "snapshot.sqlite";
      const destPath = join(stateDir, destName);

      const source = new sqlite.DatabaseSync(this.input.sourceDbPath);
      try {
        if (typeof sqlite.backup === "function") {
          await sqlite.backup(source, destPath);
        } else {
          source.exec(`VACUUM INTO '${destPath.replace(/'/g, "''")}'`);
        }
      } finally {
        source.close();
      }
      return ok([destName]);
    } catch (error) {
      return err(
        error instanceof Error
          ? error
          : new TinyAgentError("SQLITE_BACKUP_FAILED", String(error)),
      );
    }
  }
}
