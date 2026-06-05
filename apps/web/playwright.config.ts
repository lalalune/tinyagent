import { defineConfig, devices } from "@playwright/test";

/**
 * E2E tests run against a test-only control-plane and Anvil. The app signs a
 * real SIWE message with Anvil's dev key; only the wallet UI is automated.
 * Run: `npm run test:e2e`.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: "http://127.0.0.1:3100",
    trace: "retain-on-failure",
    colorScheme: "dark",
  },
  webServer: [
    {
      command: "node e2e/test-control-plane.mjs",
      url: "http://127.0.0.1:8088/health",
      timeout: 120_000,
      reuseExistingServer: false,
    },
    {
      command: "npx next start -H 127.0.0.1 -p 3100",
      url: "http://127.0.0.1:3100",
      timeout: 240_000,
      reuseExistingServer: true,
    },
  ],
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
