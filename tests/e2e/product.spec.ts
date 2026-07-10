import { expectRenderedApp } from "./assertions";
import { expect, test } from "./fixtures";

test.describe("product app", () => {
  test("loads a meaningful product workbench", async ({ page }) => {
    await expectRenderedApp(page, "Semantic Junkyard", page.locator(".sidebar .brand"));

    await expect(page.locator(".status-pill")).toHaveText(/Active|Degraded/);
    await expect(page.getByRole("heading", { name: "Business action router" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Knowledge graph" })).toBeVisible();
  });

  test("navigates to Actions and creates an executable business plan", async ({ page }, testInfo) => {
    await expectRenderedApp(page, "Semantic Junkyard", page.locator(".sidebar .brand"));
    await expect(page.locator(".status-pill")).toHaveText(/Active|Degraded/);

    const actionsButton = page.locator(".sidebar .nav-item").filter({ hasText: "Actions" });
    await expect(actionsButton).toHaveCount(1);
    await actionsButton.click();
    await expect(actionsButton).toHaveClass(/active/);

    const router = page.locator(".business-action-panel");
    await expect(router.getByRole("heading", { name: "Business action router" })).toBeVisible();

    const intent = `Align Failed Payment Rate definition across Finance and Billing, then reflect it in source systems. E2E ${testInfo.retry}-${Date.now()}.`;
    await router.getByRole("textbox", { name: "Business action request" }).fill(intent);

    const planResponsePromise = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === "/api/business/actions/plan" && response.request().method() === "POST";
    });
    await router.getByRole("button", { name: "Plan", exact: true }).click();
    const planResponse = await planResponsePromise;
    const plan = (await planResponse.json()) as { status: string; targets: unknown[] };

    expect(planResponse.status()).toBe(200);
    expect(plan.status).toBe("planned");
    expect(plan.targets.length).toBeGreaterThan(0);
    await expect(router.locator(".action-feedback strong")).toHaveText("Plan ready");
    await expect(router.locator(".action-target")).toHaveCount(plan.targets.length);
    await expect(router.getByRole("button", { name: "Execute plan", exact: true })).toBeEnabled();
  });
});
