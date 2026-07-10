import { defineConfig } from "playwright/test";

const productUrl = "http://127.0.0.1:5173";
const pocUrl = "http://127.0.0.1:5174";

const sharedUse = {
  actionTimeout: 10_000,
  colorScheme: "light" as const,
  navigationTimeout: 20_000,
  reducedMotion: "reduce" as const,
  screenshot: "only-on-failure" as const,
  trace: "retain-on-failure" as const
};

export default defineConfig({
  testDir: "./tests/e2e",
  outputDir: "./test-results",
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  timeout: 90_000,
  expect: {
    timeout: 30_000
  },
  reporter: [["list"]],
  use: sharedUse,
  projects: [
    {
      name: "product-desktop",
      testMatch: "**/product.spec.ts",
      use: {
        baseURL: productUrl,
        viewport: { width: 1440, height: 900 }
      }
    },
    {
      name: "poc-desktop",
      testMatch: "**/poc.spec.ts",
      use: {
        baseURL: pocUrl,
        viewport: { width: 1440, height: 900 }
      }
    },
    {
      name: "product-mobile",
      testMatch: "**/product.mobile.spec.ts",
      use: {
        baseURL: productUrl,
        hasTouch: true,
        isMobile: true,
        viewport: { width: 390, height: 844 }
      }
    },
    {
      name: "poc-mobile",
      testMatch: "**/poc.mobile.spec.ts",
      use: {
        baseURL: pocUrl,
        hasTouch: true,
        isMobile: true,
        viewport: { width: 390, height: 844 }
      }
    }
  ],
  webServer: {
    command: "npm run dev",
    url: productUrl,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: {
      SEMANTIC_JUNKYARD_DB: "test-results/semantic-junkyard-e2e.sqlite",
      SEMANTIC_JUNKYARD_MODEL_PROVIDER: "deterministic"
    },
    stdout: "pipe",
    stderr: "pipe"
  }
});
