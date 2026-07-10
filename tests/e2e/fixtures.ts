import { expect, test as base } from "playwright/test";

type E2EFixtures = {
  e2eSafety: void;
};

export const test = base.extend<E2EFixtures>({
  e2eSafety: [
    async ({ page, request }, use, testInfo) => {
      await expect
        .poll(
          async () => {
            try {
              const response = await request.get("/api/status", { failOnStatusCode: false });
              const status = response.status();
              await response.dispose();
              return status;
            } catch {
              return 0;
            }
          },
          {
            message: `${testInfo.project.name} frontend and API should be ready`,
            timeout: 60_000
          }
        )
        .toBe(200);
      await expect
        .poll(
          async () => {
            const response = await request.get("/api/source-resources", { failOnStatusCode: false });
            if (!response.ok()) {
              await response.dispose();
              return 0;
            }
            const resources = (await response.json()) as unknown[];
            await response.dispose();
            return resources.length;
          },
          { message: "The real reference connectors should finish their initial synchronization", timeout: 60_000 }
        )
        .toBeGreaterThanOrEqual(4);

      const browserErrors: string[] = [];
      const blockedModelRequests: string[] = [];

      page.on("console", (message) => {
        if (message.type() === "error") browserErrors.push(`console.error: ${message.text()}`);
      });
      page.on("pageerror", (error) => {
        browserErrors.push(`pageerror: ${error.message}`);
      });

      await page.route(/\/api\/(?:poc\/local-agent|agent\/interpret)(?:\?.*)?$/, async (route) => {
        let provider: unknown;
        try {
          provider = route.request().postDataJSON()?.provider;
        } catch {
          provider = undefined;
        }

        if (provider === "local-huggingface") {
          blockedModelRequests.push(`${route.request().method()} ${route.request().url()}`);
          await route.abort("blockedbyclient");
          return;
        }
        await route.continue();
      });

      await use();

      const violations = [
        ...browserErrors,
        ...blockedModelRequests.map((requestUrl) => `blocked local Hugging Face request: ${requestUrl}`)
      ];
      if (violations.length > 0) {
        await testInfo.attach("browser-health.txt", {
          body: violations.join("\n"),
          contentType: "text/plain"
        });
      }
      expect(violations, "The page should have no browser errors or local Hugging Face requests").toEqual([]);
    },
    { auto: true }
  ]
});

export { expect };
