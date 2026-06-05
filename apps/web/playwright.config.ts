import { defineConfig, devices } from "@playwright/test";

/**
 * E2E tests run against a production build in mock mode (NEXT_PUBLIC_MOCK=1,
 * baked from .env.local), so they're deterministic and need no backend.
 * Run: `npm run build && npm run test:e2e`.
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
    baseURL: "http://localhost:3100",
    trace: "retain-on-failure",
    colorScheme: "dark",
  },
  webServer: {
    command: "npm run start -- -p 3100",
    url: "http://localhost:3100",
    timeout: 120_000,
    reuseExistingServer: true,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
