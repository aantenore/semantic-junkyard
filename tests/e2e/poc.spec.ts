import { expectRenderedApp } from "./assertions";
import { expect, test } from "./fixtures";

test.describe("PoC app", () => {
  test("loads a meaningful conversational cockpit", async ({ page }) => {
    await expectRenderedApp(page, "Semantic Junkyard PoC", page.locator(".poc-header .brand"));

    await expect(page.locator(".header-status")).toContainText("ready");
    await expect(page.getByRole("heading", { name: "Business conversation" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Product read model" })).toBeVisible();
  });

  test("completes a read-only conversation without planning or executing", async ({ page }, testInfo) => {
    await expectRenderedApp(page, "Semantic Junkyard PoC", page.locator(".poc-header .brand"));
    await expect(page.locator(".header-status")).toContainText("ready");

    const actionRequests: string[] = [];
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (path === "/api/business/actions/plan" || path === "/api/business/actions/execute") {
        actionRequests.push(`${request.method()} ${path}`);
      }
    });

    const modeGroup = page.getByRole("group", { name: "Conversation execution mode" });
    const readOnlyButton = modeGroup.getByRole("button", { name: "read only", exact: true });
    await readOnlyButton.click();
    await expect(readOnlyButton).toHaveAttribute("aria-pressed", "true");

    const request = `Find governed evidence for Failed Payment Rate across Finance and Billing without changing source systems. E2E ${testInfo.retry}-${Date.now()}.`;
    await page.getByRole("textbox", { name: "Business request" }).fill(request);
    await page.getByRole("button", { name: "Ask product", exact: true }).click();

    const finalMessage = page.locator(".message.assistant").filter({ hasText: "Read-only discovery complete" });
    await expect(finalMessage).toBeVisible();
    await expect(finalMessage).toContainText("No business action was planned or executed.");
    await expect(page.getByRole("button", { name: "Ask product", exact: true })).toBeEnabled();

    expect(actionRequests).toEqual([]);
    await expect(page.locator(".tool-event").filter({ hasText: "business_action_plan" })).toHaveCount(0);
    await expect(page.locator(".tool-event").filter({ hasText: "business_action_execute" })).toHaveCount(0);
  });

  test("completes an autonomous writeback only after reflected readback", async ({ page }, testInfo) => {
    await expectRenderedApp(page, "Semantic Junkyard PoC", page.locator(".poc-header .brand"));
    await expect(page.locator(".header-status")).toContainText("ready");

    const actionRequests: string[] = [];
    const executeStatuses: number[] = [];
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (path === "/api/business/actions/plan" || path === "/api/business/actions/execute") actionRequests.push(path);
    });
    page.on("response", (response) => {
      if (new URL(response.url()).pathname === "/api/business/actions/execute") executeStatuses.push(response.status());
    });

    const modeGroup = page.getByRole("group", { name: "Conversation execution mode" });
    const autonomousButton = modeGroup.getByRole("button", { name: "autonomous", exact: true });
    await autonomousButton.click();
    await expect(autonomousButton).toHaveAttribute("aria-pressed", "true");

    const request = `Align Failed Payment Rate definition across Finance and Billing, then reflect it in source systems. E2E ${testInfo.retry}-${Date.now()}.`;
    await page.getByRole("textbox", { name: "Business request" }).fill(request);
    await page.getByRole("button", { name: "Ask product", exact: true }).click();

    const finalMessage = page.locator(".message.assistant").filter({ hasText: "Completed with reflected readback" });
    await expect(finalMessage).toBeVisible();
    await expect(finalMessage).toContainText(/verified run complete\. \d+ writes, \d+ verified reflections/);
    await expect(page.getByRole("button", { name: "Ask product", exact: true })).toBeEnabled();

    expect(actionRequests.filter((path) => path === "/api/business/actions/plan")).toHaveLength(1);
    expect(actionRequests.filter((path) => path === "/api/business/actions/execute")).toHaveLength(1);
    expect(executeStatuses).toEqual([201]);

    const actionCard = page.locator(".action-card");
    await expect(actionCard).toContainText("verified");
    expect(await actionCard.locator(".target-row").count()).toBeGreaterThan(0);

    const verifiedText = await actionCard.locator(".action-meter > div").filter({ hasText: "Verified" }).locator("strong").innerText();
    const [verified, total] = verifiedText.split("/").map(Number);
    expect(total).toBeGreaterThan(0);
    expect(verified).toBe(total);
    await expect(page.locator(".tool-event.completed").filter({ hasText: "business_action_execute" })).toBeVisible();
  });
});
