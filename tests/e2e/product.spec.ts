import { expectRenderedApp } from "./assertions";
import { expect, test } from "./fixtures";

test.describe("product app", () => {
  test("loads a meaningful product workbench", async ({ page }) => {
    await expectRenderedApp(page, "Semantic Junkyard", page.locator(".sidebar .brand"));

    await expect(page.locator(".status-pill")).toHaveText(/Active|Degraded/);
    await expect(page.getByRole("heading", { name: "Source registry" })).toBeVisible();
    await expect(page.getByRole("table", { name: "Source connections" }).getByRole("row")).toHaveCount(4);
    await expect(page.getByRole("table", { name: "Source connections" })).toContainText("Operations Database");
    await expect(page.getByRole("heading", { name: "Business action router" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Knowledge graph" })).toBeVisible();
  });

  test("navigates to Actions and creates an executable business plan", async ({ page }) => {
    await expectRenderedApp(page, "Semantic Junkyard", page.locator(".sidebar .brand"));
    await expect(page.locator(".status-pill")).toHaveText(/Active|Degraded/);

    const actionsButton = page.locator(".sidebar .nav-item").filter({ hasText: "Actions" });
    await expect(actionsButton).toHaveCount(1);
    await actionsButton.click();
    await expect(actionsButton).toHaveClass(/active/);

    const router = page.locator(".business-action-panel");
    await expect(router.getByRole("heading", { name: "Business action router" })).toBeVisible();

    const intent = "Set order ORD-1001 status to dispatched";
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
    expect(plan.targets).toHaveLength(1);
    await expect(router.locator(".action-feedback strong")).toHaveText("Plan ready");
    await expect(router.locator(".action-target")).toHaveCount(plan.targets.length);
    await expect(router.locator(".action-target")).toContainText("Real connector / SQLite");
    await expect(router.getByRole("button", { name: "Execute plan", exact: true })).toBeEnabled();

    const executeResponsePromise = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === "/api/business/actions/execute" && response.request().method() === "POST";
    });
    await router.getByRole("button", { name: "Execute plan", exact: true }).click();
    const executeResponse = await executeResponsePromise;
    const run = (await executeResponse.json()) as { status: string; writes: unknown[]; reflections: Array<{ status: string }> };

    expect(executeResponse.status()).toBe(201);
    expect(run.status).toBe("verified");
    expect(run.writes).toHaveLength(1);
    expect(run.reflections.every((reflection) => reflection.status === "verified")).toBe(true);
    await expect(router.locator(".action-feedback strong")).toHaveText("Completed");
    await expect(router.locator(".action-target")).toContainText("External postcondition passed");
  });
});
