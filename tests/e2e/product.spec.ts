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
    await page.route("**/api/business/actions/plan", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      await route.continue();
    }, { times: 1 });
    await router.getByRole("button", { name: "Plan", exact: true }).click();
    await expect(router.getByRole("button", { name: "dry run", exact: true })).toBeDisabled();
    await expect(router.getByRole("textbox", { name: "Business action request" })).toBeDisabled();
    const planResponse = await planResponsePromise;
    const plan = (await planResponse.json()) as { status: string; targets: unknown[] };

    expect(planResponse.status()).toBe(200);
    expect(plan.status).toBe("planned");
    expect(plan.targets).toHaveLength(1);
    const proof = router.getByRole("region", { name: "Current plan identity and evidence binding" });
    await expect(proof).toBeVisible();
    await expect(proof.locator("code")).toHaveText(/^[a-f0-9]{64}$/);
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
    await expect(proof).toContainText("executed fingerprint matches reviewed fingerprint");
  });

  test("requires an explicit rationale and attestation for an approval-bound plan", async ({ page }) => {
    await expectRenderedApp(page, "Semantic Junkyard", page.locator(".sidebar .brand"));
    const router = page.locator(".business-action-panel");
    await router.getByRole("button", { name: "Publish Git contract", exact: true }).click();

    const planResponsePromise = page.waitForResponse((response) =>
      new URL(response.url()).pathname === "/api/business/actions/plan" && response.request().method() === "POST"
    );
    await router.getByRole("button", { name: "Plan", exact: true }).click();
    const planResponse = await planResponsePromise;
    const plan = (await planResponse.json()) as { id: string; fingerprint: string; status: string };
    expect(plan.status).toBe("approval_required");

    const proof = router.getByRole("region", { name: "Current plan identity and evidence binding" });
    await expect(proof).toContainText(plan.id);
    await expect(proof.locator("code")).toHaveText(plan.fingerprint);
    const approvalReview = router.getByRole("region", { name: "Plan approval review" });
    const approve = approvalReview.getByRole("button", { name: "Approve exact plan", exact: true });
    await expect(approve).toBeDisabled();
    await approvalReview.getByRole("textbox", { name: "Approval rationale" }).fill("Reviewed the exact contract diff, source identity, and fingerprint.");
    await approvalReview.getByRole("checkbox").check();
    await expect(approve).toBeEnabled();

    const approvalResponsePromise = page.waitForResponse((response) =>
      new URL(response.url()).pathname === "/api/business/actions/approve" && response.request().method() === "POST"
    );
    await approve.click();
    const approvalResponse = await approvalResponsePromise;
    expect(approvalResponse.status()).toBe(201);
    await expect(approvalReview.getByRole("button", { name: "Approved", exact: true })).toBeDisabled();
    await expect(router.getByRole("button", { name: "Execute plan", exact: true })).toBeEnabled();
  });

  test("requires opening proposal evidence before a semantic decision", async ({ page }) => {
    await expectRenderedApp(page, "Semantic Junkyard", page.locator(".sidebar .brand"));
    await page.locator(".sidebar .nav-item").filter({ hasText: "Sources" }).click();

    const proposal = page.locator(".proposal-row.status-proposed").first();
    await expect(proposal).toBeVisible();
    await proposal.getByRole("textbox", { name: "Decision rationale" }).fill("Reviewed against the cited source evidence.");
    const accept = proposal.getByRole("button", { name: "Accept", exact: true });
    await expect(accept).toBeDisabled();
    await proposal.getByRole("button", { name: "Review evidence", exact: true }).click();
    await expect(proposal.locator(".proposal-evidence-review article").first()).toBeVisible();
    await expect(proposal.getByRole("button", { name: "Evidence reviewed", exact: true })).toBeVisible();
    await expect(accept).toBeEnabled();
  });
});
