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
    .getByRole("button", { name: "Download report for ua-fail.pdf" })
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
  // Deleting hides the file at once and offers an undo before anything is sent.
  const row = page.locator(`#${await fail.getAttribute("id")}`);
  await row.getByRole("button", { name: "Delete file", exact: true }).click();
  await expect(row).toHaveCount(0);
  const notices = page.locator("#notice");
  await notices.getByRole("button", { name: "Undo" }).click();
  await expect(row).toBeVisible();
  await expect(notices).toContainText("Restored “ua-fail.pdf”.");
  await row.locator(".action-dropdown > summary").click();
  await row.getByRole("button", { name: "Delete file", exact: true }).click();
  const deleted = page.waitForRequest(
    (request) =>
      request.method() === "DELETE" && request.url().includes("/documents/"),
  );
  await notices
    .locator(".notice-item", { hasText: "Deleted “ua-fail.pdf”." })
    .getByRole("button", { name: "Dismiss notification" })
    .click();
  await deleted;
  await expect(row).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("mobile layout, dark theme, 200% text, keyboard upload, and upload validation", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "Account settings" }).click();
  await page.getByRole("button", { name: "Theme: dark" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(
    page.getByRole("button", { name: "Theme: dark" }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  await expect(page.locator("#account-settings-menu")).toBeHidden();
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

test("Easy Auth sign-in card, sign-out, and expired session redirects", async ({
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
              activity: [],
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
  await expect(page.locator("#signin-screen")).toBeVisible();
  await expect(page.locator("body")).toHaveClass(/gated/);
  await expect(page.locator("main")).toHaveAttribute("inert", "");
  await expect(page.locator("#identity")).toHaveText("");
  await page.locator("#signin").click();
  await expect(page).toHaveURL(
    /\/\.auth\/login\/aad\?post_login_redirect_uri=%2F$/,
  );
  signedIn = true;
  await page.goto("/");
  await expect(page.locator("#identity")).toHaveText("Staff Member");
  await expect(page.locator("#gate")).toBeHidden();
  await expect(page.locator("body")).not.toHaveClass(/gated/);
  await expect(page.locator("main")).not.toHaveAttribute("inert");
  await page.getByRole("button", { name: "Account settings" }).click();
  await page.locator("#signout").click();
  await expect(page).toHaveURL(
    /\/\.auth\/logout\?post_logout_redirect_uri=%2F%3Fsigned-out$/,
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
  await expect(page).toHaveURL(/\/$/);
  await expect(
    page.getByRole("heading", { name: "Your account doesn't have access" }),
  ).toBeVisible();
  await expect(page.locator("#denied-screen")).toContainText(
    "Validation.User role",
  );
  await expect(page.locator("#signin-screen")).toBeHidden();
  await expect(
    page.locator("#denied-screen").getByRole("link", { name: "Sign out" }),
  ).toHaveAttribute(
    "href",
    "/.auth/logout?post_logout_redirect_uri=%2F%3Fsigned-out",
  );
});

test("sign-in card covers the workspace and is accessible in light and dark", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/session", (route) =>
    route.fulfill({ status: 401, json: { detail: "Sign in required" } }),
  );
  await page.route("**/api/config", (route) =>
    route.fulfill({ json: { local: false, authMode: "easyauth" } }),
  );
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Sign in to your workspace" }),
  ).toBeVisible();
  await expect(page.locator("#signin")).toBeFocused();
  // The blurred workspace is inert: out of the accessibility tree and unclickable.
  await expect(page.locator("main")).toHaveAttribute("inert", "");
  const light = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(light.violations).toEqual([]);
  await page.screenshot({ path: "test-results/login-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?signed-out");
  await expect(
    page.getByRole("heading", { name: "You're signed out" }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator("#signin-screen")).toBeHidden();
  while (
    (await page.locator("#gate-theme").getAttribute("aria-label")) !==
    "Theme: dark"
  )
    await page.locator("#gate-theme").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.evaluate(() => (document.documentElement.style.fontSize = "32px"));
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.evaluate(() => (document.documentElement.style.fontSize = "16px"));
  const dark = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(dark.violations).toEqual([]);
  await page.screenshot({ path: "test-results/login-mobile-dark.png" });
  expect(errors).toEqual([]);
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
  await expect(page.locator("#gate")).toBeHidden();
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
    "1 file submitted. 1 file needs attention; retry the remaining file.",
  );
  await expect(page.locator("#staged-body tr")).toHaveCount(1);
  await expect(page.locator("#submit")).toHaveText("Retry remaining file");
  expect(creates).toBe(2);
  await page.locator("#submit").click();
  await expect(page.locator("#notice")).toContainText(
    "0 files submitted. 1 file needs attention",
  );
  expect(creates).toBe(2);
  await page.locator("#clear").click();
  await expect(page.locator("#staging")).toBeHidden();
  await page.reload();
  await expect(page.locator("#results-body")).not.toContainText("invalid.pdf");
  await expect(page.locator("#results-body")).toContainText("independent.pdf");
});

test("retry reuses the reservation when its create response is lost", async ({
  page,
}) => {
  await page.route("**/api/config", (route) =>
    route.fulfill({
      json: {
        local: true,
        maxFiles: 200,
        maxFileBytes: 200 * 1024 * 1024,
        maxSelectionBytes: 2 * 1024 * 1024 * 1024,
        disclaimer: "Manual review is required.",
        profiles: [
          { id: "wcag-2.2", alias: "wcag", label: "WCAG 2.2", default: true },
        ],
        statuses: {
          active: ["uploading", "queued", "running"],
          terminal: ["passed", "failed", "error"],
        },
      },
    }),
  );
  await page.route("**/api/v1/documents?*", (route) =>
    route.fulfill({
      json: {
        items: [],
        total: 0,
        matching: 0,
        processed: 0,
        passed_by_profile: {},
        pages: 0,
        activity: [],
      },
    }),
  );
  const reservations = new Map();
  const keys = [];
  await page.route("**/api/v1/documents", async (route) => {
    const key = route.request().headers()["idempotency-key"];
    keys.push(key);
    if (!reservations.has(key)) {
      const body = route.request().postDataJSON();
      reservations.set(key, {
        id: `reservation-${reservations.size}`,
        idempotency_key: key,
        ...body,
        status: "uploading",
        upload_url: `${new URL(route.request().url()).origin}/mock-upload`,
      });
    }
    // The reservation committed, but the browser never received its key or ID.
    if (keys.length === 1) return route.abort("failed");
    return route.fulfill({ status: 201, json: reservations.get(key) });
  });
  let uploads = 0,
    submissions = 0;
  await page.route("**/mock-upload", (route) => {
    uploads++;
    return route.fulfill({ status: 201 });
  });
  await page.route("**/api/v1/documents/*/submit", (route) => {
    submissions++;
    return route.fulfill({ status: 202, json: {} });
  });
  await page.goto("/");
  await expect(page.getByText("Local workspace")).toBeVisible();
  await page.locator("#files").setInputFiles({
    name: "lost-response.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.7\n"),
  });
  await page.locator("#submit").click();
  await expect(page.locator("#notice")).toContainText(
    "0 files submitted. 1 file needs attention",
  );
  expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/);
  await page.locator("#submit").click();
  await expect(page.locator("#notice")).toContainText("1 file submitted.");
  expect(keys).toEqual([keys[0], keys[0]]);
  expect(reservations.size).toBe(1);
  expect(uploads).toBe(1);
  expect(submissions).toBe(1);
  await expect(page.locator("#staging")).toBeHidden();
});

test("removing staged files that finish out of order removes only those files", async ({
  page,
}) => {
  // Mocked documents whose uploads fail, so each stays staged with a server
  // document that Remove must check before deleting.
  const created = new Map(),
    held = new Map();
  await page.route("**/api/v1/documents", (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const { name, size, profiles } = route.request().postDataJSON();
    const id = `mock-${name}`;
    const origin = new URL(route.request().url()).origin;
    const doc = {
      id,
      name,
      size,
      status: "uploading",
      created: Date.now() / 1000,
      expires: Date.now() / 1000 + 3600,
      idempotency_key: id,
      validation_profiles: profiles,
      upload_url: `${origin}/mock-upload/${id}`,
    };
    created.set(id, doc);
    return route.fulfill({ status: 201, json: doc });
  });
  await page.route("**/mock-upload/*", (route) =>
    route.fulfill({ status: 500 }),
  );
  // Status checks wait until the test releases them, one document at a time.
  await page.route("**/api/v1/documents/mock-*", async (route) => {
    const id = new URL(route.request().url()).pathname.split("/").pop();
    if (route.request().method() === "DELETE")
      return route.fulfill({ status: 204 });
    await new Promise((release) => held.set(id, release));
    return route.fulfill({ json: created.get(id) });
  });
  await page.goto("/");
  await expect(page.getByText("Local workspace")).toBeVisible();
  await page.locator("#files").setInputFiles(
    ["a.pdf", "b.pdf", "c.pdf"].map((name) => ({
      name,
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.7\n"),
    })),
  );
  await page.locator("#submit").click();
  await expect(page.locator("#notice")).toContainText(
    "0 files submitted. 3 files need attention",
  );
  const rows = page.locator("#staged-body tr");
  await expect(rows).toHaveCount(3);
  await expect(rows.first()).toContainText("Upload failed (500)");
  await page.getByRole("button", { name: "Remove a.pdf" }).click();
  await page.getByRole("button", { name: "Remove b.pdf" }).click();
  await expect.poll(() => held.size).toBe(2);
  held.get("mock-a.pdf")();
  await expect(rows).toHaveCount(2);
  held.get("mock-b.pdf")();
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText("c.pdf");
});

test("delete all documents asks for confirmation first", async ({ page }) => {
  // Mocked so running the suite never empties a real workspace.
  let total = 3,
    deletes = 0;
  await page.route("**/api/v1/documents?*", (route) =>
    route.fulfill({
      json: {
        items: [],
        total,
        matching: total ? 25 : 0,
        processed: total,
        passed_by_profile: { "wcag-2.2": 0, "pdfua-1": 0 },
        pages: 0,
        activity: [],
        // Older pages exist until everything is deleted.
        next_cursor: total ? "older" : null,
      },
    }),
  );
  await page.route("**/api/v1/documents", (route) => {
    if (route.request().method() !== "DELETE") return route.fallback();
    deletes++;
    total = 0;
    return route.fulfill({ json: { deleted: 3 } });
  });
  await page.goto("/");
  const deleteAll = page.getByRole("button", { name: "Delete all documents" });
  const loadMore = page.getByRole("button", { name: "Load older files" });
  await expect(deleteAll).toBeVisible();
  await expect(loadMore).toBeVisible();
  // One line: load more on the left, delete all against the right edge.
  const [loadBox, deleteBox, rowBox] = await Promise.all([
    loadMore.boundingBox(),
    deleteAll.boundingBox(),
    page.locator(".table-actions").boundingBox(),
  ]);
  expect(Math.abs(loadBox.y - deleteBox.y)).toBeLessThan(2);
  expect(deleteBox.x).toBeGreaterThan(loadBox.x);
  expect(
    Math.abs(deleteBox.x + deleteBox.width - (rowBox.x + rowBox.width)),
  ).toBeLessThan(2);

  await deleteAll.click();
  const dialog = page.locator("#confirm");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("h2")).toHaveText("Delete all documents?");
  await expect(dialog).toContainText("permanently removes 3 files");
  await expect(page.locator("#confirm-cancel")).toBeFocused();
  // Contrast is measured once the dialog has finished fading in.
  await dialog.evaluate((el) =>
    Promise.all(el.getAnimations().map((a) => a.finished)),
  );
  const a11y = await new AxeBuilder({ page })
    .include("#confirm")
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(a11y.violations).toEqual([]);
  await page.getByRole("button", { name: "Keep files" }).click();
  await expect(dialog).not.toBeVisible();
  expect(deletes).toBe(0);

  await deleteAll.click();
  await dialog.getByRole("button", { name: "Delete all documents" }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.locator("#notice")).toContainText("3 files deleted.");
  await expect(deleteAll).toBeHidden();
  expect(deletes).toBe(1);
});

test("the workspace starts when site storage is blocked", async ({ page }) => {
  // Browsers that block site data throw on any localStorage access.
  await page.addInitScript(() =>
    Object.defineProperty(window, "localStorage", {
      get() {
        throw new DOMException("Site data is blocked", "SecurityError");
      },
    }),
  );
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(page.getByText("Local workspace")).toBeVisible();
  await page.getByRole("button", { name: "Account settings" }).click();
  await page.getByRole("button", { name: "Theme: light" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  // The choice is not remembered, so the next visit starts from the system theme.
  await page.reload();
  await page.getByRole("button", { name: "Account settings" }).click();
  await expect(
    page.getByRole("button", { name: "Theme: system" }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Theme: light" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  expect(errors).toEqual([]);
});

test("a document reserved without its size says so", async ({ page }) => {
  const now = Date.now() / 1000;
  await page.route("**/api/v1/documents?*", (route) =>
    route.fulfill({
      json: {
        items: [
          {
            id: "unsized",
            name: "api-client.pdf",
            status: "uploading",
            created: now,
            expires: now + 3600,
            validation_profiles: ["wcag"],
            profiles: [],
            pdf_available: false,
            attempts: 0,
          },
        ],
        total: 1,
        matching: 1,
        processed: 0,
        passed_by_profile: { "wcag-2.2": 0, "pdfua-1": 0 },
        pages: 0,
        activity: [],
      },
    }),
  );
  await page.goto("/");
  const row = page.locator("#results-body .document-row");
  await expect(row).toContainText("Page count unavailable · Size unavailable");
  await expect(row).not.toContainText("NaN");
});

test("the last row's action menu is not clipped by the table", async ({
  page,
}) => {
  const now = Date.now() / 1000;
  const summary = {
    errors: 0,
    failed_rules: 0,
    checked_rules: 2,
    duration_ms: 1,
  };
  await page.route("**/api/v1/documents?*", (route) =>
    route.fulfill({
      json: {
        items: [
          {
            id: "only",
            name: "only.pdf",
            size: 9,
            status: "passed",
            created: now,
            expires: now + 3600,
            validation_profiles: ["wcag", "pdfua1"],
            profiles: [
              { profile: "wcag-2.2", status: "passed", passed: true, summary },
              { profile: "pdfua-1", status: "passed", passed: true, summary },
            ],
            pdf_available: true,
            attempts: 1,
          },
        ],
        total: 1,
        matching: 1,
        processed: 1,
        passed_by_profile: { "wcag-2.2": 1, "pdfua-1": 1 },
        pages: 0,
        activity: [],
      },
    }),
  );
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto("/");
  await page.getByLabel("More actions for only.pdf").click();
  const options = page.locator(".action-options");
  await expect(
    options.getByRole("button", { name: "Delete file" }),
  ).toBeVisible();
  // Hit-test where the last item is laid out: a clipping wrapper hides it
  // without moving it, so something else is drawn there.
  const hidden = await options.evaluate((menu) => {
    const box = menu.lastElementChild.getBoundingClientRect();
    const hit = document.elementFromPoint(
      box.left + box.width / 2,
      box.bottom - 2,
    );
    return !menu.contains(hit);
  });
  expect(hidden).toBe(false);
});

test("details open and close once their animations end, even when interrupted", async ({
  page,
}) => {
  const now = Date.now() / 1000;
  await page.route("**/api/v1/documents?*", (route) =>
    route.fulfill({
      json: {
        items: [
          {
            id: "animated",
            name: "animated.pdf",
            size: 9,
            status: "passed",
            created: now,
            expires: now + 3600,
            validation_profiles: ["wcag"],
            profiles: [],
            pdf_available: false,
            attempts: 1,
          },
        ],
        total: 1,
        matching: 1,
        processed: 1,
        passed_by_profile: { "wcag-2.2": 0, "pdfua-1": 0 },
        pages: 0,
        activity: [],
      },
    }),
  );
  await page.route("**/api/v1/documents/animated/issues?*", (route) =>
    route.fulfill({ json: { items: [], total: 0, offset: 0, limit: 100 } }),
  );
  await page.goto("/");
  const toggle = page.getByRole("button", {
    name: "Validation details for animated.pdf",
  });
  const detail = page.locator("#details-animated");
  await toggle.click();
  await expect(detail).toContainText("No automated rule failures found.");
  await expect(detail).not.toHaveClass(/detail-enter/);
  await toggle.click();
  await expect(detail).toBeHidden();
  await expect(detail).not.toHaveClass(/detail-closing/);
  // Reopening mid-close cancels the exit animation; the row must stay open.
  await toggle.click();
  await toggle.click();
  await toggle.click();
  await expect(detail).toBeVisible();
  await expect(detail).not.toHaveClass(/detail-closing|detail-enter/);
  await page.waitForTimeout(400);
  await expect(detail).toBeVisible();
});
