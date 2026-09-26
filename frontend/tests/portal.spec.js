import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";
const fixtures = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../tests/fixtures",
);

test("real multi-file uploads, reports, refresh, keyboard dialog, and deletion", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(page.getByText("Local workspace")).toBeVisible();
  await page
    .locator("#files")
    .setInputFiles([
      path.join(fixtures, "ua-pass.pdf"),
      path.join(fixtures, "ua-fail.pdf"),
    ]);
  await expect(page.locator("#staged-body tr")).toHaveCount(2);
  await page.locator("#submit").click();
  await expect(
    page.getByText("2 files submitted.", { exact: false }),
  ).toBeVisible();
  await page.reload();
  const pass = page
    .locator("#results-body .document-row")
    .filter({ hasText: "ua-pass.pdf" })
    .first();
  const fail = page
    .locator("#results-body .document-row")
    .filter({ hasText: "ua-fail.pdf" })
    .first();
  await expect(pass).toContainText("Pass", { timeout: 45000 });
  await expect(pass).toContainText("1 page");
  await expect(pass.getByRole("link")).toHaveAttribute("target", "_blank");
  const pdfResponse = await page.request.get(
    await pass.getByRole("link").getAttribute("href"),
  );
  expect(pdfResponse.headers()["content-type"]).toContain("application/pdf");
  expect((await pdfResponse.body()).subarray(0, 5).toString()).toBe("%PDF-");
  const popupPromise = page.waitForEvent("popup");
  await pass.getByRole("link").click();
  const popup = await popupPromise;
  await expect(popup).toHaveURL(/\/api\/v1\/documents\/[^/]+\/pdf$/);
  await popup.close();
  await expect(fail).toContainText("Fail ·", { timeout: 45000 });
  await fail
    .getByRole("button", { name: "Validation details for ua-fail.pdf" })
    .click();
  const detail = page.locator(".detail-row:not([hidden])");
  await expect(detail).toContainText("Accessibility issues");
  await expect(detail).toContainText("Identification Schema");
  await expect(detail.locator(".grouped-issue")).toHaveCount(1);
  await detail.locator(".occurrences > summary").click();
  await expect(detail.locator(".issue-location").first()).toBeVisible();
  const download = page.waitForEvent("download");
  await fail
    .getByRole("button", { name: "Download report", exact: true })
    .click();
  expect((await download).suggestedFilename()).toMatch(/\.json$/);
  const toggle = fail.getByRole("button", {
    name: "Validation details for ua-fail.pdf",
  });
  await toggle.focus();
  await page.keyboard.press("Enter");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await page.locator("#refresh").click();
  await expect(page.locator(".detail-row:not([hidden])")).toContainText(
    "Accessibility issues",
  );
  await page.locator("#search").fill("ua-pass.pdf");
  await expect(page.locator("#results-body")).not.toContainText("ua-fail.pdf");
  await page.locator("#search").clear();
  const a11y = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(a11y.violations).toEqual([]);
  await page.screenshot({
    path: "test-results/desktop-details.png",
    fullPage: true,
  });
  await fail.locator(".action-dropdown > summary").click();
  await page.keyboard.press("Escape");
  await expect(fail.locator(".action-dropdown")).not.toHaveAttribute(
    "open",
    "",
  );
  await fail.locator(".action-dropdown > summary").press("Enter");
  await fail.getByRole("button", { name: "Delete file", exact: true }).click();
  await page.locator("#confirm-delete").click();
  await expect(page.locator("#confirm")).not.toBeVisible();
  expect(errors).toEqual([]);
});

test("mobile layout, dark theme, 200% text, keyboard upload, and upload validation", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.locator("#theme")).toBeVisible();
  while ((await page.locator("#theme").textContent()) !== "Theme: dark")
    await page.locator("#theme").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.locator("#files").focus();
  await expect(page.locator("#files")).toBeFocused();
  await page.locator("#files").setInputFiles({
    name: "wrong.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("no"),
  });
  await expect(page.locator("#notice")).toContainText("only PDFs");
  await page.locator(".expand-toggle").first().click();
  await expect(page.locator(".detail-row:not([hidden])")).toContainText(
    "Validation summary",
  );
  await page.evaluate(() => (document.documentElement.style.fontSize = "32px"));
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBeTruthy();
  await page.evaluate(() => (document.documentElement.style.fontSize = "16px"));
  const a11y = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(a11y.violations).toEqual([]);
  await page.screenshot({
    path: "test-results/mobile-dark.png",
    fullPage: true,
  });
});

test("Easy Auth server-directed sign-in, sign-out, and expired session redirects", async ({
  page,
}) => {
  await page.route("**/api/config", (route) =>
    route.fulfill({
      json: {
        local: false,
        authMode: "easyauth",
        maxFiles: 200,
        maxFileBytes: 209715200,
        maxSelectionBytes: 2147483648,
        disclaimer: "Manual review is required.",
      },
    }),
  );
  let signedIn = false,
    expired = false;
  await page.route("**/api/session", (route) =>
    route.fulfill(
      signedIn
        ? { json: { name: "Staff Member", kind: "user" } }
        : { status: 401, json: { detail: "Sign in required" } },
    ),
  );
  await page.route("**/api/v1/documents?*", (route) =>
    route.fulfill(
      expired
        ? { status: 401, json: { detail: "Session expired" } }
        : { json: { items: [], total: 0, processed: 0 } },
    ),
  );
  await page.route("**/.auth/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<h1>Azure authentication boundary</h1>",
    }),
  );
  await page.goto("/");
  await expect(page.locator("#signin")).toBeVisible();
  await page.locator("#signin").click();
  await expect(page).toHaveURL(
    /\/\.auth\/login\/aad\?post_login_redirect_uri=%2F$/,
  );
  signedIn = true;
  await page.goto("/");
  await expect(page.locator("#identity")).toHaveText("Staff Member");
  await page.locator("#signout").click();
  await expect(page).toHaveURL(
    /\/\.auth\/logout\?post_logout_redirect_uri=%2F$/,
  );
  const initialPoll = page.waitForResponse((response) =>
    response.url().includes("/api/v1/documents?"),
  );
  await page.goto("/");
  await initialPoll;
  expired = true;
  await page.locator("#refresh").click();
  await expect(page).toHaveURL(
    /\/\.auth\/login\/aad\?post_login_redirect_uri=%2F$/,
  );
});

test("unassigned Easy Auth user gets an actionable denial", async ({
  page,
}) => {
  await page.route("**/api/config", (route) =>
    route.fulfill({ json: { local: false, authMode: "easyauth" } }),
  );
  await page.route("**/api/session", (route) =>
    route.fulfill({ status: 403, json: { detail: "Missing role" } }),
  );
  await page.goto("/");
  await expect(page.locator("#notice")).toContainText("Validation.User role");
  await expect(
    page.locator("#notice").getByRole("link", { name: "Sign out" }),
  ).toHaveAttribute("href", "/.auth/logout?post_logout_redirect_uri=%2F");
});

test("one invalid upload does not block other documents or duplicate retries", async ({
  page,
}) => {
  let creates = 0;
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/api/v1/documents"
    )
      creates++;
  });
  await page.goto("/");
  const fs = await import("node:fs/promises");
  await page.locator("#files").setInputFiles([
    {
      name: "invalid.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("not-a-pdf"),
    },
    {
      name: "independent.pdf",
      mimeType: "application/pdf",
      buffer: await fs.readFile(path.join(fixtures, "ua-pass.pdf")),
    },
  ]);
  await page.locator("#submit").click();
  await expect(page.locator("#notice")).toContainText(
    "1 files submitted. 1 files need attention",
  );
  await expect(page.locator("#staged-body tr")).toHaveCount(1);
  expect(creates).toBe(2);
  await page.locator("#submit").click();
  await expect(page.locator("#notice")).toContainText(
    "0 files submitted. 1 files need attention",
  );
  expect(creates).toBe(2);
  await page.locator("#clear").click();
  await expect(page.locator("#staging")).toBeHidden();
  await page.locator("#refresh").click();
  await expect(page.locator("#results-body")).not.toContainText("invalid.pdf");
  await expect(page.locator("#results-body")).toContainText("independent.pdf");
});
