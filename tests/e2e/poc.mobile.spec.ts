import { expectNoHorizontalOverflow, expectRenderedApp } from "./assertions";
import { expect, test } from "./fixtures";

test("PoC app has no horizontal overflow on mobile", async ({ page }) => {
  await expectRenderedApp(page, "Semantic Junkyard PoC", page.locator(".poc-header .brand"));
  await expect(page.locator(".header-status")).toContainText("ready");
  await expect(page.getByRole("group", { name: "Conversation execution mode" })).toBeVisible();
  await expectNoHorizontalOverflow(page);
});
