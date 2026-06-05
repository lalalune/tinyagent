import { describe, expect, it } from "vitest";
import { buildSnapshotPlan } from "./snapshot-plan.js";

describe("per-pack snapshot planning", () => {
  it("plans ordinary Lowkey state directories under the project state root", () => {
    const plan = buildSnapshotPlan(
      {
        name: "openclaw",
        dependencies: [],
        ports: [],
        stateDirs: ["~/.openclaw"],
        modelModes: [],
        secretTargets: [],
        headlessCaveats: [],
        brain: true,
      },
      { stateRoot: "/agent/state" },
    );

    expect(plan).toMatchObject({
      agent: "openclaw",
      items: [
        {
          kind: "directory",
          stateDir: "~/.openclaw",
          sourcePath: "/agent/state/.openclaw",
          archivePath: ".openclaw",
        },
      ],
    });
  });

  it("plans PostgreSQL state as an executable pg_dump strategy", () => {
    const plan = buildSnapshotPlan(
      {
        name: "ironclaw",
        dependencies: [],
        ports: [],
        stateDirs: ["postgres://ironclaw"],
        modelModes: [],
        secretTargets: [],
        headlessCaveats: ["requires PostgreSQL"],
        brain: true,
      },
      { stateRoot: "/agent/state" },
    );

    expect(plan.items[0]).toMatchObject({
      kind: "postgres",
      connectionString: "postgres://ironclaw",
      archivePath: "postgres",
    });
    const item = plan.items[0];
    if (!item || item.kind !== "postgres") {
      throw new Error("expected postgres item");
    }
    expect(item.kind).toBe("postgres");
    expect(item.strategy.name).toBe("postgres-online-v1");
  });

  it("plans nested Docker state as an executable container export strategy", () => {
    const plan = buildSnapshotPlan(
      {
        name: "nemoclaw",
        dependencies: [],
        ports: [],
        stateDirs: ["~/.nemoclaw", "docker:nemoclaw"],
        modelModes: [],
        secretTargets: [],
        headlessCaveats: ["requires nested Docker"],
        brain: true,
      },
      { stateRoot: "/agent/state" },
    );

    expect(plan.items).toHaveLength(2);
    expect(plan.items[0]).toMatchObject({
      kind: "directory",
      archivePath: ".nemoclaw",
    });
    expect(plan.items[1]).toMatchObject({
      kind: "nested-docker",
      container: "nemoclaw",
      archivePath: "docker/nemoclaw",
    });
    const item = plan.items[1];
    if (!item || item.kind !== "nested-docker") {
      throw new Error("expected nested-docker item");
    }
    expect(item.kind).toBe("nested-docker");
    expect(item.strategy.name).toBe("nested-docker-v1");
  });

  it("plans sqlite URIs with the online SQLite strategy", () => {
    const plan = buildSnapshotPlan(
      {
        name: "sqlite-agent",
        dependencies: [],
        ports: [],
        stateDirs: ["sqlite:/agent/state/live.db"],
        modelModes: [],
        secretTargets: [],
        headlessCaveats: [],
        brain: false,
      },
      { stateRoot: "/agent/state" },
    );

    expect(plan.items[0]).toMatchObject({
      kind: "sqlite",
      sourceDbPath: "/agent/state/live.db",
      archivePath: "agent/state/live.db",
    });
    const item = plan.items[0];
    if (!item || item.kind !== "sqlite") {
      throw new Error("expected sqlite item");
    }
    expect(item.kind).toBe("sqlite");
    expect(item.strategy.name).toBe("sqlite-online-v1");
  });
});
