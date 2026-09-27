import { test, expect } from "@playwright/test";

const doc = {
  id: "tracked",
  name: "tracked.pdf",
  status: "running",
  created: 1700000000,
  expires: 2000000000,
  attempts: 1,
  validation_profiles: ["wcag"],
  profiles: [],
};
const activity = (item = doc) =>
  ["queued", "running"].includes(item.status)
    ? [
        {
          id: item.id,
          status: item.status,
          attempts: item.attempts,
          expires: item.expires,
        },
      ]
    : [];
const listing = (item = doc) => ({
  items: [item],
  total: 1,
  matching: 1,
  processed: 0,
  passed_by_profile: {},
  pages: 0,
  activity: activity(item),
});
const groups = (offset = 0) => ({
  items: [],
  total: 0,
  offset,
  limit: 100,
});

test.beforeEach(async ({ page }) => {
  await page.clock.install();
  await page.route("**/api/v1/documents/activity", (route) =>
    route.fulfill({ json: { items: activity() } }),
  );
  await page.route("**/api/config", (route) =>
    route.fulfill({
      json: {
        local: true,
        maxFiles: 200,
        maxFileBytes: 209715200,
        maxSelectionBytes: 2147483648,
        disclaimer: "Manual review required.",
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
});

test("reconnect cancels the pending poll and leaves one scheduler", async ({
  page,
}) => {
  const requests = [];
  let held;
  page.on("requestfailed", (request) => {
    if (request.url().includes("/documents")) requests.push("cancelled");
  });
  let calls = 0;
  await page.route("**/api/v1/documents?*", async (route) => {
    calls++;
    await route.fulfill({ json: listing() });
  });
  await page.route("**/api/v1/documents/activity", async (route) => {
    calls++;
    if (calls === 2)
      await new Promise((resolve) => {
        held = resolve;
      });
    await route.fulfill({ json: { items: activity() } });
  });
  await page.goto("/");
  await expect(page.locator("#row-tracked")).toBeVisible();
  await page.clock.runFor(2500);
  await expect.poll(() => calls).toBe(2);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect.poll(() => calls).toBe(3);
  await expect.poll(() => requests.length).toBe(1);
  held();
  await page.clock.runFor(2500);
  await expect.poll(() => calls).toBe(4);
  await page.clock.runFor(2500);
  await expect.poll(() => calls).toBe(5);
});

test("search cancels obsolete pagination without showing an error", async ({
  page,
}) => {
  let held;
  const offsets = [];
  await page.route("**/api/v1/documents?*", async (route) => {
    const params = new URL(route.request().url()).searchParams;
    offsets.push([params.get("q"), params.get("cursor")]);
    if (!params.get("q")) {
      await new Promise((resolve) => {
        held = resolve;
      });
      return route.fulfill({ json: { ...listing(), matching: 40 } });
    }
    return route.fulfill({ json: listing({ ...doc, name: "new.pdf" }) });
  });
  await page.goto("/");
  await expect.poll(() => offsets.length).toBe(1);
  const aborted = page.waitForEvent("requestfailed", (request) =>
    request.url().includes("/documents?"),
  );
  await page.locator("#search").fill("new");
  await aborted;
  await page.clock.runFor(250);
  await expect(page.locator("#row-tracked")).toContainText("new.pdf");
  held();
  await expect(page.locator("#notice")).not.toContainText("abort");
  expect(offsets).toEqual([
    ["", null],
    ["new", null],
  ]);
});

test("expanded reports refresh on completion and retain their issues page", async ({
  page,
}) => {
  let current = { ...doc };
  await page.route("**/api/v1/documents/activity", (route) =>
    route.fulfill({ json: { items: activity(current) } }),
  );
  const offsets = [];
  await page.route("**/api/v1/documents?*", (route) =>
    route.fulfill({ json: listing(current) }),
  );
  await page.route("**/api/v1/documents/tracked/issues?*", (route) => {
    const offset = Number(
      new URL(route.request().url()).searchParams.get("offset"),
    );
    offsets.push(offset);
    return route.fulfill({
      json:
        current.status === "running"
          ? groups(offset)
          : {
              ...groups(offset),
              total: 101,
              items: [
                {
                  message: `Issue page ${offset}`,
                  count: 1,
                  profiles: ["wcag-2.2"],
                  occurrences: [],
                },
              ],
            },
    });
  });
  await page.goto("/");
  await page.locator("#toggle-tracked").click();
  await expect(page.locator("#details-tracked")).toContainText(
    "Results will appear",
  );
  current = {
    ...current,
    status: "failed",
    profiles: [
      {
        profile: "wcag-2.2",
        status: "failed",
        summary: { errors: 101, failed_rules: 101 },
      },
    ],
  };
  await page.clock.runFor(2500);
  await expect(page.locator("#details-tracked")).toContainText("Issue page 0");
  await page.getByRole("button", { name: "More issues" }).click();
  await expect(page.locator("#details-tracked")).toContainText(
    "Issue page 100",
  );
  await page.clock.runFor(2500);
  expect(offsets).toEqual([0, 0, 100]);
  current = { ...current, error: "Updated result" };
  await page.clock.fastForward(30000);
  await expect(page.locator("#details-tracked")).toContainText(
    "Updated result",
  );
  expect(offsets).toEqual([0, 0, 100, 100]);
  await expect(page.locator("#toggle-tracked")).toHaveAttribute(
    "aria-expanded",
    "true",
  );
});

test("completion cancels an obsolete detail request", async ({ page }) => {
  let current = { ...doc },
    held,
    calls = 0;
  await page.route("**/api/v1/documents/activity", (route) =>
    route.fulfill({ json: { items: activity(current) } }),
  );
  await page.route("**/api/v1/documents?*", (route) =>
    route.fulfill({ json: listing(current) }),
  );
  await page.route("**/api/v1/documents/tracked/issues?*", async (route) => {
    calls++;
    if (calls === 1)
      await new Promise((resolve) => {
        held = resolve;
      });
    await route.fulfill({ json: groups() });
  });
  await page.goto("/");
  await page.locator("#toggle-tracked").click();
  await expect.poll(() => !!held).toBe(true);
  const aborted = page.waitForEvent("requestfailed", (request) =>
    request.url().includes("/issues?"),
  );
  current = { ...current, status: "passed" };
  await page.clock.runFor(2500);
  await aborted;
  await expect(page.locator("#details-tracked")).toContainText(
    "No automated rule failures found.",
  );
  held();
  await expect(page.locator("#details-tracked")).not.toContainText(
    "Results will appear",
  );
  expect(calls).toBe(2);
});

test("unchanged activity avoids list reads until periodic reconciliation", async ({
  page,
}) => {
  let lists = 0,
    checks = 0;
  await page.route("**/api/v1/documents?*", (route) => {
    lists++;
    return route.fulfill({ json: listing() });
  });
  await page.route("**/api/v1/documents/activity", (route) => {
    checks++;
    return route.fulfill({ json: { items: activity() } });
  });
  await page.goto("/");
  await expect(page.locator("#row-tracked")).toBeVisible();
  for (let i = 1; i <= 3; i++) {
    await page.clock.runFor(2500);
    await expect.poll(() => checks).toBe(i);
  }
  expect(lists).toBe(1);
  await page.clock.fastForward(30000);
  await expect.poll(() => lists).toBe(2);
});

test("load more requests only the next cursor page", async ({ page }) => {
  const cursors = [];
  await page.route("**/api/v1/documents?*", (route) => {
    const cursor = new URL(route.request().url()).searchParams.get("cursor");
    cursors.push(cursor);
    return route.fulfill({
      json: {
        ...listing(),
        total: 21,
        matching: 21,
        items: cursor
          ? [{ ...doc, id: "last", name: "last.pdf" }]
          : Array.from({ length: 20 }, (_, i) => ({ ...doc, id: `doc-${i}` })),
        next_cursor: cursor ? null : "next-page",
      },
    });
  });
  await page.goto("/");
  await expect(page.locator(".document-row")).toHaveCount(20);
  await page.locator("#load-more").click();
  await expect(page.locator(".document-row")).toHaveCount(21);
  expect(cursors).toEqual([null, "next-page"]);
  await expect(page.locator("#load-more")).toBeHidden();
});

test("closing a report cancels its pending detail request", async ({
  page,
}) => {
  let held;
  await page.route("**/api/v1/documents?*", (route) =>
    route.fulfill({ json: listing() }),
  );
  await page.route("**/api/v1/documents/tracked/issues?*", async (route) => {
    await new Promise((resolve) => {
      held = resolve;
    });
    await route.fulfill({ json: groups() });
  });
  await page.goto("/");
  await page.locator("#toggle-tracked").click();
  await expect.poll(() => !!held).toBe(true);
  const aborted = page.waitForEvent("requestfailed", (request) =>
    request.url().includes("/issues?"),
  );
  await page.locator("#toggle-tracked").click();
  await aborted;
  held();
  await expect(page.locator("#toggle-tracked")).toHaveAttribute(
    "aria-expanded",
    "false",
  );
});
