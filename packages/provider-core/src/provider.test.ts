import { describe, expect, it } from "vitest";
import type { ComputeProvider } from "./provider.js";

describe("ComputeProvider contract", () => {
  it("requires local providers to expose local-docker kind", () => {
    const provider = { kind: "local-docker" } satisfies Pick<
      ComputeProvider,
      "kind"
    >;
    expect(provider.kind).toBe("local-docker");
  });
});
