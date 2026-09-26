import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";
const fixtures = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../tests/fixtures",
);

test("real multi-file uploads, reports, keyboard dialog, and deletion", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(page.getByText("Local workspace")).toBeVisible();
  await page.locator(".run-options > summary").click();
  await page.locator('input[name="profile"][value="pdfua1"]').check();
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
  await expect(fail.locator(".profile-line.failed .profile-state")).toHaveText(
    "Fail",
    { timeout: 45000 },
  );
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
  await expect(page.locator(".detail-row:not([hidden])")).toContainText(
    "Accessibility issues",
  );
  await expect(page.locator("#filter option")).toHaveText([
    "All outcomes",
    "In progress",
    "Passed checks",
    "Failed checks",
    "Processing error",
  ]);
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
  const layout = await page.evaluate(() => {
    const overflowing = [...document.body.querySelectorAll("*")]
      .map((element) => ({
        element,
        rect: element.getBoundingClientRect(),
      }))
      .filter(
        ({ rect }) => rect.left < -1 || rect.right > window.innerWidth + 1,
      );
    const overflowingElements = new Set(
      overflowing.map(({ element }) => element),
    );
    const offenders = overflowing
      .filter(
        ({ element }) =>
          ![...element.children].some((child) =>
            overflowingElements.has(child),
          ),
      )
      .slice(0, 10)
      .map(({ element, rect }) => ({
        tag: element.tagName,
        id: element.id,
        className: element.className,
        left: Math.round(rect.left),
        right: Math.round(rect.right),
        width: Math.round(rect.width),
      }));
    const overflowingContents = [...document.body.querySelectorAll("*")]
      .filter((element) => element.scrollWidth > element.clientWidth + 1)
      .map((element) => ({
        tag: element.tagName,
        id: element.id,
        className: element.className,
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
        overflowX: getComputedStyle(element).overflowX,
      }))
      .slice(0, 12);
    return {
      scrollWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
      offenders,
      overflowingContents,
    };
  });
  expect(
    layout.scrollWidth,
    JSON.stringify(layout, null, 2),
  ).toBeLessThanOrEqual(layout.viewportWidth);
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
        profiles: [
          { id: "wcag-2.2", alias: "wcag", label: "WCAG 2.2", default: true },
          { id: "pdfua-1", alias: "pdfua1", label: "PDF/UA-1", default: false },
        ],
        statuses: {
          active: ["uploading", "queued", "running"],
          terminal: ["passed", "failed", "error"],
        },
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
        : {
            json: {
              items: [],
              total: 0,
              matching: 0,
              processed: 0,
              passed_by_profile: { "pdfua-1": 0, "wcag-2.2": 0 },
              pages: 0,
              active_ids: [],
            },
          },
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
  await page.reload();
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

test("an unavailable session service is not reported as missing access", async ({
  page,
}) => {
  await page.route("**/api/config", (route) =>
    route.fulfill({ json: { local: false, authMode: "easyauth" } }),
  );
  await page.route("**/api/session", (route) =>
    route.fulfill({ status: 503, json: { detail: "Storage unavailable" } }),
  );
  await page.goto("/");
  await expect(page.locator("#notice")).toContainText(
    "The workspace could not start",
  );
  await expect(page.locator("#notice")).not.toContainText("Validation.User");
  await expect(page.locator("#notice").getByRole("link")).toHaveCount(0);
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
  await page.locator(".run-options > summary").click();
  await page.locator('input[name="profile"][value="wcag"]').check();
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
  await page.reload();
  await expect(page.locator("#results-body")).not.toContainText("invalid.pdf");
  await expect(page.locator("#results-body")).toContainText("independent.pdf");
});
