import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { err, ok, TinyAgentError, type Result } from "@tinyagent/core";
import type { SnapshotStrategy } from "./sqlite-strategy.js";

const execFileAsync = promisify(execFile);

export interface PostgresSnapshotInput {
  connectionString: string;
  destFileName?: string;
  command?: string;
}

export class PostgresOnlineBackupStrategy implements SnapshotStrategy {
  readonly name = "postgres-online-v1";

  constructor(private readonly input: PostgresSnapshotInput) {}

  async snapshot(stateDir: string): Promise<Result<string[]>> {
    const destName =
      this.input.destFileName ??
      `postgres-${safeFileComponent(connectionName(this.input.connectionString))}.dump`;
    const destPath = join(stateDir, destName);
    try {
      await mkdir(dirname(destPath), { recursive: true });
      await execFileAsync(this.input.command ?? "pg_dump", [
        "--dbname",
        this.input.connectionString,
        "--file",
        destPath,
        "--format",
        "custom",
        "--no-owner",
        "--no-privileges",
      ]);
      return ok([destName]);
    } catch (error) {
      if (isMissingCommand(error)) {
        return err(
          new TinyAgentError(
            "PG_BACKUP_UNSUPPORTED",
            "PostgreSQL online backup requires pg_dump to be available",
          ),
        );
      }
      return err(
        new TinyAgentError(
          "PG_BACKUP_FAILED",
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  }
}

export interface NestedDockerSnapshotInput {
  container: string;
  volumes?: string[];
  destFileName?: string;
}

export class NestedDockerBackupStrategy implements SnapshotStrategy {
  readonly name = "nested-docker-v1";

  constructor(private readonly input: NestedDockerSnapshotInput) {}

  async snapshot(stateDir: string): Promise<Result<string[]>> {
    const destName =
      this.input.destFileName ??
      `docker-${safeFileComponent(this.input.container)}.tar`;
    const destPath = join(stateDir, destName);
    try {
      await mkdir(dirname(destPath), { recursive: true });
      await execFileAsync("docker", [
        "export",
        "--output",
        destPath,
        this.input.container,
      ]);
      return ok([destName]);
    } catch (error) {
      if (isMissingCommand(error)) {
        return err(
          new TinyAgentError(
            "DOCKER_BACKUP_UNSUPPORTED",
            "Nested-Docker backup requires the docker CLI to be available",
          ),
        );
      }
      return err(
        new TinyAgentError(
          "DOCKER_BACKUP_FAILED",
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  }
}

function safeFileComponent(value: string): string {
  return (
    value.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") ||
    "snapshot"
  );
}

function connectionName(connectionString: string): string {
  try {
    const parsed = new URL(connectionString);
    const database = parsed.pathname.replace(/^\/+/, "");
    return database.length > 0 ? database : parsed.hostname;
  } catch {
    return connectionString;
  }
}

function isMissingCommand(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
