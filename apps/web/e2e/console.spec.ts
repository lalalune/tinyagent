import { test, expect } from "@playwright/test";

/**
 * Real-console smoke tests. There is no mock mode: the app talks to a live
 * control-plane. With no backend/wallet present, it correctly renders its real
 * unauthenticated surface — the landing and the SIWE sign-in gate. The
 * authenticated flow (deploy/backup/billing) is proven against the real backend
 * by the control-plane HTTP integration test and the orchestrator lifecycle test.
 */
test.describe("TinyAgent console (real, no mock)", () => {
  test("landing renders the hero with the wired Oswald font", async ({ page }) => {
    await page.goto("/");

    const hero = page.getByRole("heading", { name: /sovereign agents/i });
    await expect(hero).toBeVisible();
    await expect(page.getByText(/disposable confidential compute/i)).toBeVisible();

    // Font-regression guard: display headings use Oswald (tinycloud.xyz style),
    // not the browser serif fallback.
    const fontFamily = await hero.evaluate((el) => getComputedStyle(el).fontFamily.toLowerCase());
    expect(fontFamily).toContain("oswald");
    expect(fontFamily).not.toMatch(/^times|^serif/);

    // No mock/demo artifacts anywhere.
    await expect(page.getByText(/mock data/i)).toHaveCount(0);
    await expect(page.getByText(/sample data/i)).toHaveCount(0);

    // Real entry point: connect a wallet.
    await expect(page.getByRole("button", { name: /connect wallet/i }).first()).toBeVisible();
  });

  test("opening the console without a wallet shows the real SIWE sign-in gate", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page.getByRole("heading", { name: /sign in to your console/i })).toBeVisible();
    await expect(page.getByText(/sealed to this address/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /connect wallet/i }).first()).toBeVisible();
  });

  test("billing also gates on a real wallet sign-in", async ({ page }) => {
    await page.goto("/billing");
    await expect(page.getByRole("heading", { name: /sign in to your console/i })).toBeVisible();
  });
});
