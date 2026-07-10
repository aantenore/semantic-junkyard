import { expectNoHorizontalOverflow, expectRenderedApp } from "./assertions";
import { expect, test } from "./fixtures";

test("product app has no horizontal overflow on mobile", async ({ page }) => {
  await expectRenderedApp(page, "Semantic Junkyard", page.locator(".mobile-product-name"));
  await expect(page.locator(".status-pill")).toHaveText(/Active|Degraded/);

  const actionsButton = page.locator(".mobile-section-nav").getByRole("button", { name: "Actions", exact: true });
  await actionsButton.click();
  await expect(actionsButton).toHaveClass(/active/);
  await expectNoHorizontalOverflow(page);
});
