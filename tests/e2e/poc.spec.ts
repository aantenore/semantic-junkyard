import { expectRenderedApp } from "./assertions";
import { expect, test } from "./fixtures";

test.describe("PoC app", () => {
  test("loads a meaningful conversational cockpit", async ({ page }) => {
    await expectRenderedApp(page, "Semantic Junkyard PoC", page.locator(".poc-header .brand"));

    await expect(page.locator(".header-status")).toContainText("Product API connected");
    await expect(page.getByRole("heading", { name: "Product conversation" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Product read model" })).toBeVisible();
  });

  test("completes a read-only conversation without planning or executing", async ({ page }, testInfo) => {
    await expectRenderedApp(page, "Semantic Junkyard PoC", page.locator(".poc-header .brand"));
    await expect(page.locator(".header-status")).toContainText("Product API connected");

    const actionRequests: string[] = [];
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (path === "/api/business/actions/plan" || path === "/api/business/actions/execute") {
        actionRequests.push(`${request.method()} ${path}`);
      }
    });

    await page.getByRole("group", { name: "Intent interpreter" }).getByRole("button", { name: "Deterministic rules" }).click();
    const modeGroup = page.getByRole("group", { name: "Execution boundary" });
    const readOnlyButton = modeGroup.getByRole("button", { name: "read only", exact: true });
    await readOnlyButton.click();
    await expect(readOnlyButton).toHaveAttribute("aria-pressed", "true");

    const request = `Explain which governed source defines dispatch eligibility for order ORD-1001. E2E ${testInfo.retry}-${Date.now()}.`;
    await page.getByRole("textbox", { name: "Product request" }).fill(request);
    await page.getByRole("button", { name: "Ask product", exact: true }).click();

    const finalMessage = page.locator(".message.assistant").filter({ hasText: "Grounded read-only result" });
    await expect(finalMessage).toBeVisible();
    await expect(finalMessage).toContainText("No business-action plan was created.");
    await expect(page.getByRole("button", { name: "Ask product", exact: true })).toBeEnabled();

    expect(actionRequests).toEqual([]);
    await expect(page.locator(".tool-event").filter({ hasText: "business_action_plan" })).toHaveCount(0);
    await expect(page.locator(".tool-event").filter({ hasText: "business_action_execute" })).toHaveCount(0);
  });

  test("completes an autonomous writeback only after reflected readback", async ({ page }) => {
    await expectRenderedApp(page, "Semantic Junkyard PoC", page.locator(".poc-header .brand"));
    await expect(page.locator(".header-status")).toContainText("Product API connected");

    const actionRequests: string[] = [];
    const executeStatuses: number[] = [];
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (path === "/api/business/actions/plan" || path === "/api/business/actions/execute") actionRequests.push(path);
    });
    page.on("response", (response) => {
      if (new URL(response.url()).pathname === "/api/business/actions/execute") executeStatuses.push(response.status());
    });

    await page.getByRole("group", { name: "Intent interpreter" }).getByRole("button", { name: "Deterministic rules" }).click();
    const modeGroup = page.getByRole("group", { name: "Execution boundary" });
    const autonomousButton = modeGroup.getByRole("button", { name: "autonomous", exact: true });
    await autonomousButton.click();
    await expect(autonomousButton).toHaveAttribute("aria-pressed", "true");

    const request = "Set order ORD-1001 status to dispatched";
    await page.getByRole("textbox", { name: "Product request" }).fill(request);
    await page.getByRole("button", { name: "Ask product", exact: true }).click();

    const finalMessage = page.locator(".message.write").filter({ hasText: "Verified with reflected readback" });
    await expect(finalMessage).toBeVisible();
    await expect(finalMessage).toContainText("postcondition passed");
    await expect(page.getByRole("button", { name: "Ask product", exact: true })).toBeEnabled();

    expect(actionRequests.filter((path) => path === "/api/business/actions/plan")).toHaveLength(1);
    expect(actionRequests.filter((path) => path === "/api/business/actions/execute")).toHaveLength(1);
    expect(executeStatuses).toEqual([201]);

    const actionCard = page.locator(".action-panel");
    await expect(actionCard).toContainText("verified");
    expect(await actionCard.locator(".target-row").count()).toBeGreaterThan(0);

    const verifiedText = await actionCard.locator(".action-meter > div").filter({ hasText: "Verified" }).locator("strong").innerText();
    const [verified, total] = verifiedText.split("/").map(Number);
    expect(total).toBeGreaterThan(0);
    expect(verified).toBe(total);
    await expect(page.locator('.tool-event.completed[data-tool-name="business_action_execute"]')).toBeVisible();
  });
});
