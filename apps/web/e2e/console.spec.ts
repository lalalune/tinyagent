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

    const hero = page.getByRole("heading", { name: /^tinyagent$/i });
    await expect(hero).toBeVisible();
    await expect(
      page.getByText(/recover it later from the same wallet/i),
    ).toBeVisible();

    // Font-regression guard: display headings use Oswald (tinycloud.xyz style),
    // not the browser serif fallback.
    const fontFamily = await hero.evaluate((el) =>
      getComputedStyle(el).fontFamily.toLowerCase(),
    );
    expect(fontFamily).toContain("oswald");
    expect(fontFamily).not.toMatch(/^times|^serif/);

    // No mock/demo/default artifacts anywhere in the visible product surface.
    await expect(page.getByText(/mock data/i)).toHaveCount(0);
    await expect(page.getByText(/sample data/i)).toHaveCount(0);
    await expect(page.getByText(/placeholder/i)).toHaveCount(0);
    await expect(page.getByText(/dev preview/i)).toHaveCount(0);

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
      page.getByRole("heading", { name: /sign in with your wallet/i }),
    ).toBeVisible();
    await expect(page.getByText(/Sign once to create/i)).toBeVisible();
    await expect(
      page.getByRole("button", { name: /sign in/i }).first(),
    ).toBeVisible();
  });

  test("billing also gates on a real wallet sign-in", async ({ page }) => {
    await page.goto("/billing");
    await expect(
      page.getByRole("heading", { name: /sign in to your console/i }),
    ).not.toBeVisible();
    await expect(
      page.getByRole("heading", { name: /sign in with your wallet/i }),
    ).toBeVisible();
  });

  test("e2e mode signs in with Ethereum and renders the dashboard flow", async ({
    page,
  }) => {
    await page.goto("/dashboard?e2eAutoLogin=1");

    await expect(
      page.getByRole("heading", { name: /agent console/i }),
    ).toBeVisible();
    await expect(
      page.getByText(/1 agent ready for backup/i),
    ).toBeVisible();
    await expect(page.getByText("Next action")).toBeVisible();
    await expect(page.getByRole("heading", { name: "scribe" })).toBeVisible();
    await expect(page.getByText("dstack-cvm")).toBeVisible();
    await expect(page.getByText(/dev preview/i)).toHaveCount(0);

    await page.getByRole("button", { name: "Lightning" }).click();
    await expect(
      page.getByRole("heading", { name: /lightning sandboxes/i }),
    ).toBeVisible();
    await expect(
      page.getByText(/1 sandbox · wallet-owned lifecycle/i),
    ).not.toBeVisible();
    await expect(
      page.getByText(/1 sandbox ready for backup/i),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "workspace" }),
    ).toBeVisible();
    await expect(page.getByText("lightning", { exact: true })).toBeVisible();
  });

  test("authenticated user can deploy, backup, recover, and tear down", async ({
    page,
  }) => {
    await page.goto("/dashboard?e2eAutoLogin=1");
    await expect(
      page.getByRole("heading", { name: /agent console/i }),
    ).toBeVisible();

    await page.getByRole("button", { name: /deploy agent/i }).click();
    await expect(
      page.getByRole("heading", { name: /deploy an agent/i }),
    ).toBeVisible();
    await expect(page.locator("input[placeholder]")).toHaveCount(0);
    await page.getByRole("button", { name: /use openclaw/i }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: /^deploy agent$/i })
      .click();

    await expect(
      page.getByRole("heading", { name: "openclaw" }),
    ).toBeVisible();
    await expect(
      page.getByText(/2 agents ready for backup/i),
    ).toBeVisible();

    await page.getByRole("button", { name: "Backup" }).first().click();
    await expect(page.getByText(/Backup complete/i)).toBeVisible();
    await expect(page.getByText(/just now/i).first()).toBeVisible();

    await page.getByRole("button", { name: "Recover" }).first().click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: /^Recover$/ })
      .click();
    await expect(page.getByText(/Recovered/i)).toBeVisible();

    await page.getByRole("button", { name: "Down" }).first().click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: /tear down/i })
      .click();
    await expect(page.getByText(/is down/i)).toBeVisible();
    await expect(page.getByText("down").first()).toBeVisible();
  });
});
