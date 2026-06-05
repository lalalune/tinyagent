import { describe, expect, it } from "vitest";
import type { ProviderConformanceOptions } from "./provider.js";

export function providerConformanceSuite(
  name: string,
  options: ProviderConformanceOptions,
): void {
  describe(`${name} provider conformance`, () => {
    it("runs lifecycle, exec, file transfer, port forward, and attestation shape", async () => {
      const sandbox = await options.provider.provision(options.sandbox);
      let testError: unknown;
      const cleanupErrors: unknown[] = [];

      try {
        await options.provider.start(sandbox);

        const chunks = [];
        for await (const chunk of options.provider.exec(sandbox, {
          command: ["sh", "-lc", "printf tinyagent"],
          env: {},
        })) {
          chunks.push(chunk);
        }
        expect(chunks.length).toBeGreaterThan(0);

        await options.provider.putFiles(sandbox, [
          {
            path: "/tmp/tinyagent-conformance.txt",
            content: new TextEncoder().encode("ok"),
          },
        ]);
        const files = await options.provider.getFiles(sandbox, [
          "/tmp/tinyagent-conformance.txt",
        ]);
        expect(files[0]?.path).toBe("/tmp/tinyagent-conformance.txt");

        const tunnel = await options.provider.forwardPort(
          sandbox,
          options.remotePort,
          0,
        );
        expect(tunnel.remotePort).toBe(options.remotePort);
        await tunnel.close();

        const attestation = await options.provider.attest(
          sandbox,
          new Uint8Array([1, 2, 3]),
        );
        if (options.provider.kind === "local-docker") {
          expect(attestation).toBeNull();
        } else {
          expect(attestation?.composeHash).toBeTruthy();
        }
      } catch (error) {
        testError = error;
      } finally {
        try {
          await options.provider.stop(sandbox);
        } catch (error) {
          cleanupErrors.push(error);
        }
        try {
          await options.provider.destroy(sandbox);
        } catch (error) {
          cleanupErrors.push(error);
        }
      }

      if (testError !== undefined || cleanupErrors.length > 0) {
        throw new AggregateError(
          [...(testError !== undefined ? [testError] : []), ...cleanupErrors],
          "provider conformance failed",
        );
      }
    });
  });
}
