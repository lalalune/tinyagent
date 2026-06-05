import { join } from "node:path";
import type { AgentSpec } from "@tinyagent/core";
import {
  NestedDockerBackupStrategy,
  PostgresOnlineBackupStrategy,
} from "./external-strategies.js";
import { SqliteOnlineBackupStrategy } from "./sqlite-strategy.js";
import type { SnapshotStrategy } from "./sqlite-strategy.js";

export type SnapshotPlanItem =
  | {
      kind: "directory";
      stateDir: string;
      sourcePath: string;
      archivePath: string;
    }
  | {
      kind: "sqlite";
      stateDir: string;
      sourceDbPath: string;
      archivePath: string;
      strategy: SnapshotStrategy;
    }
  | {
      kind: "postgres";
      stateDir: string;
      connectionString: string;
      archivePath: string;
      strategy: SnapshotStrategy;
    }
  | {
      kind: "nested-docker";
      stateDir: string;
      container: string;
      archivePath: string;
      strategy: SnapshotStrategy;
    };

export interface SnapshotPlan {
  agent: string;
  items: SnapshotPlanItem[];
}

export interface SnapshotPlanOptions {
  stateRoot: string;
}

export function buildSnapshotPlan(
  agent: AgentSpec,
  options: SnapshotPlanOptions,
): SnapshotPlan {
  const stateDirs =
    agent.stateDirs.length > 0 ? agent.stateDirs : [defaultStateDir(agent)];
  return {
    agent: agent.name,
    items: stateDirs.map((stateDir) => planStateDir(stateDir, options)),
  };
}

function planStateDir(
  stateDir: string,
  options: SnapshotPlanOptions,
): SnapshotPlanItem {
  if (
    stateDir.startsWith("postgres://") ||
    stateDir.startsWith("postgresql://")
  ) {
    return {
      kind: "postgres",
      stateDir,
      connectionString: stateDir,
      archivePath: "postgres",
      strategy: new PostgresOnlineBackupStrategy({
        connectionString: stateDir,
        destFileName: "postgres/dump.pgcustom",
      }),
    };
  }

  if (stateDir.startsWith("docker:")) {
    const container = stateDir.slice("docker:".length);
    return {
      kind: "nested-docker",
      stateDir,
      container,
      archivePath: `docker/${container}`,
      strategy: new NestedDockerBackupStrategy({
        container,
        destFileName: `docker/${container}.tar`,
      }),
    };
  }

  if (stateDir.startsWith("sqlite:")) {
    const sourceDbPath = stateDir.slice("sqlite:".length);
    const archivePath = archivePathFor(sourceDbPath);
    return {
      kind: "sqlite",
      stateDir,
      sourceDbPath,
      archivePath,
      strategy: new SqliteOnlineBackupStrategy({
        sourceDbPath,
        destFileName: archivePath,
      }),
    };
  }

  return {
    kind: "directory",
    stateDir,
    sourcePath: join(options.stateRoot, archivePathFor(stateDir)),
    archivePath: archivePathFor(stateDir),
  };
}

function defaultStateDir(agent: AgentSpec): string {
  return `~/.${agent.name}`;
}

function archivePathFor(stateDir: string): string {
  return stateDir
    .replace(/^~\/?/, "")
    .replace(/^\/+/, "")
    .replace(/^[A-Za-z]:[\\/]/, "")
    .split(/[\\/]+/)
    .filter((part) => part.length > 0 && part !== "." && part !== "..")
    .join("/");
}
