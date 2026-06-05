import { test, expect } from "@playwright/test";

/**
 * Real-console smoke tests. There is no mock mode: the app talks to an HTTP
 * control-plane. Playwright starts a test control-plane plus Anvil. The default
 * tests stop before SIWE; the authenticated test signs a genuine SIWE message
 * with Anvil's dev key.
 */
test.describe("TinyAgent console (real, no mock)", () => {
  test("landing renders the hero with the wired Oswald font", async ({
    page,
  }) => {
    await page.goto("/");

    const hero = page.getByRole("heading", { name: /sovereign agents/i });
    await expect(hero).toBeVisible();
    await expect(
      page.getByText(/disposable confidential compute/i),
    ).toBeVisible();

    // Font-regression guard: display headings use Oswald (tinycloud.xyz style),
    // not the browser serif fallback.
    const fontFamily = await hero.evaluate((el) =>
      getComputedStyle(el).fontFamily.toLowerCase(),
    );
    expect(fontFamily).toContain("oswald");
    expect(fontFamily).not.toMatch(/^times|^serif/);

    // No mock/demo artifacts anywhere.
    await expect(page.getByText(/mock data/i)).toHaveCount(0);
    await expect(page.getByText(/sample data/i)).toHaveCount(0);

    // In E2E mode the Anvil connector is available, so the real entry point is SIWE.
    await expect(
      page.getByRole("button", { name: /sign in/i }).first(),
    ).toBeVisible();
  });

  test("opening the console before SIWE shows the real sign-in gate", async ({
    page,
  }) => {
    await page.goto("/dashboard");
    await expect(
      page.getByRole("heading", { name: /sign in to your console/i }),
    ).toBeVisible();
    await expect(page.getByText(/sealed to this address/i)).toBeVisible();
    await expect(
      page.getByRole("button", { name: /sign in/i }).first(),
    ).toBeVisible();
  });

  test("billing also gates on a real wallet sign-in", async ({ page }) => {
    await page.goto("/billing");
    await expect(
      page.getByRole("heading", { name: /sign in to your console/i }),
    ).toBeVisible();
  });

  test("e2e mode signs in with Ethereum and renders agents plus Lightning", async ({
    page,
  }) => {
    await page.goto("/dashboard?e2eAutoLogin=1");

    await expect(
      page.getByRole("heading", { name: /your agents/i }),
    ).toBeVisible();
    await expect(
      page.getByText(/1 agent · wallet-owned lifecycle/i),
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: "scribe" })).toBeVisible();
    await expect(page.getByText("dstack-cvm")).toBeVisible();

    await page.getByRole("button", { name: "Lightning" }).click();
    await expect(
      page.getByRole("heading", { name: /lightning sandboxes/i }),
    ).toBeVisible();
    await expect(
      page.getByText(/1 sandbox · wallet-owned lifecycle/i),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "workspace" }),
    ).toBeVisible();
    await expect(page.getByText("lightning", { exact: true })).toBeVisible();
  });
});
