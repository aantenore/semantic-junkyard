import type { Locator, Page } from "playwright/test";
import { expect } from "./fixtures";

export async function expectRenderedApp(page: Page, title: string, identity: Locator) {
  const response = await page.goto("/");

  expect(response, "The Vite document request should return a response").not.toBeNull();
  expect(response?.ok(), `Expected a successful document response, got ${response?.status()}`).toBe(true);
  await expect(page).toHaveTitle(title);
  await expect(page.locator("#root")).toBeVisible();
  await expect(page.locator("#root")).toContainText(/\S/);
  await expect(identity).toBeVisible();
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
}

export async function expectNoHorizontalOverflow(page: Page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
  });

  const report = await page.evaluate(() => {
    const viewportWidth = document.documentElement.clientWidth;
    const scrollWidth = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
    const offenders = Array.from(document.querySelectorAll("body *"))
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const className = typeof element.className === "string" ? element.className.trim().replace(/\s+/g, ".") : "";
        return {
          selector: `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ""}${className ? `.${className}` : ""}`,
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          width: Math.round(rect.width)
        };
      })
      .filter((element) => element.right > viewportWidth + 1 || element.left < -1)
      .slice(0, 10);

    return {
      overflow: scrollWidth - viewportWidth,
      scrollWidth,
      viewportWidth,
      offenders
    };
  });

  expect(report.overflow, `Horizontal overflow report: ${JSON.stringify(report)}`).toBeLessThanOrEqual(1);
}
