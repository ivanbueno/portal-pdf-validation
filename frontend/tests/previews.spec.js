import { test, expect } from "@playwright/test";
import { fileURLToPath } from "node:url";

test.beforeEach(async ({ page }) => {
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
  await page.route("**/api/v1/documents?*", (route) =>
    route.fulfill({
      json: {
        items: ["a", "b"].map((id) => ({
          id,
          name: `${id}.pdf`,
          status: "failed",
          created: 1700000000,
          expires: 2000000000,
          validation_profiles: ["wcag"],
          profiles: [],
        })),
        total: 2,
        matching: 2,
        processed: 2,
        passed_by_profile: {},
        pages: 2,
        activity: [],
      },
    }),
  );
  await page.route("**/api/v1/documents/*/issues?*", (route) =>
    route.fulfill({
      json: {
        items: [
          {
            message: "Example issue",
            count: 2,
            profiles: ["wcag-2.2"],
            occurrences: [1, 2].map((n) => ({
              profile: "wcag-2.2",
              page: 1,
              message: `Occurrence ${n}`,
              location: JSON.stringify({
                bbox: [{ p: 0, rect: [n * 10, 10, n * 10 + 20, 30] }],
              }),
            })),
          },
        ],
        total: 1,
        offset: 0,
        limit: 100,
      },
    }),
  );
});

for (const lateOutcome of ["resolve", "reject"]) {
  test(`dialog ignores an old ${lateOutcome} after reopening @source`, async ({
    page,
  }) => {
    // Deliberately ignores cancellation, so the dialog must also fence responses.
    await page.route("**/src/pdf-previews.js", (route) =>
      route.fulfill({
        contentType: "text/javascript",
        body: `
        window.previewRequests = [];
        export async function renderOccurrencePreview(id, occurrence, width, signal) {
          const image = { src: 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>'), page: occurrence.message.endsWith('1') ? 1 : 2, precise: true };
          if (width === 320) return image;
          return new Promise((resolve, reject) => window.previewRequests.push({ signal,
            resolve: () => resolve(image), reject: () => reject(new Error('late failure')) }));
        }
      `,
      }),
    );
    await page.goto("/");
    await page.locator("#toggle-a").click();
    await page.locator("#details-a .occurrences > summary").click();
    const thumbs = page.locator("#details-a .preview-thumb");
    await expect(thumbs).toHaveCount(2);
    await thumbs.nth(0).click();
    await expect
      .poll(() => page.evaluate(() => window.previewRequests.length))
      .toBe(1);
    await page.locator("#preview-close").click();
    await thumbs.nth(1).click();
    await expect
      .poll(() => page.evaluate(() => window.previewRequests.length))
      .toBe(2);
    expect(
      await page.evaluate(() => window.previewRequests[0].signal.aborted),
    ).toBe(true);
    await page.evaluate(() => window.previewRequests[1].resolve());
    await expect(page.locator("#preview-image")).toHaveAttribute(
      "alt",
      /page 2/,
    );
    await page.evaluate(
      (outcome) => window.previewRequests[0][outcome](),
      lateOutcome,
    );
    await expect(page.locator("#preview-image")).toHaveAttribute(
      "alt",
      /page 2/,
    );
    await expect(page.locator("#preview-note")).not.toContainText(
      "Could not load",
    );
    await page.keyboard.press("Escape");
    await expect(page.locator("#preview-image")).not.toHaveAttribute("src");
    await page.locator("#details-a .occurrences > summary").click();
    await expect(thumbs).toHaveCount(0);
  });
}

test("two expanded documents render real PDFs and reuse their sessions", async ({
  page,
}) => {
  const fetches = [];
  const libraries = [];
  page.on("request", (request) => {
    if (
      /pdf-previews|pdf-document|pdf-structure|pdfjs-dist|pdf-lib/.test(
        request.url(),
      )
    )
      libraries.push(request.url());
  });
  await page.route("**/api/v1/documents/*/pdf", (route) => {
    fetches.push(route.request().url());
    return route.fulfill({
      contentType: "application/pdf",
      path: fileURLToPath(
        new URL("../../tests/fixtures/ua-pass.pdf", import.meta.url),
      ),
    });
  });
  await page.goto("/");
  await expect(page.locator("#toggle-a")).toBeVisible();
  expect(libraries).toEqual([]);
  for (const id of ["a", "b"]) {
    await page.locator(`#toggle-${id}`).click();
    await page.locator(`#details-${id} .occurrences > summary`).click();
  }
  await expect(page.locator(".preview-thumb")).toHaveCount(4);
  expect(libraries.some((url) => url.includes("pdf-previews"))).toBe(true);
  expect(libraries.some((url) => /pdf-structure|pdf-lib/.test(url))).toBe(
    false,
  );
  expect(fetches.length).toBe(2);
  await page.locator("#details-a .preview-thumb").first().click();
  await expect(page.locator("#preview-note")).toContainText("Red box uses");
  expect(fetches.length).toBe(2);
  await page.locator("#preview-close").click();
  await page.locator("#toggle-a").click();
  await expect(page.locator("#details-a .preview-thumb")).toHaveCount(0);
  await expect(page.locator("#details-b .preview-thumb")).toHaveCount(2);
});

test("metadata checks do not load PDF libraries", async ({ page }) => {
  const libraries = [];
  page.on("request", (request) => {
    if (
      /pdf-previews|pdf-document|pdf-structure|pdfjs-dist|pdf-lib/.test(
        request.url(),
      )
    )
      libraries.push(request.url());
  });
  await page.route("**/api/v1/documents/a/issues?*", (route) =>
    route.fulfill({
      json: {
        items: [
          {
            message: "Metadata issue",
            count: 1,
            profiles: ["wcag-2.2"],
            occurrences: [
              {
                profile: "wcag-2.2",
                message: "Missing metadata",
                location: "root/metadata[0]",
              },
            ],
          },
        ],
        total: 1,
        offset: 0,
        limit: 100,
      },
    }),
  );
  await page.goto("/");
  await page.locator("#toggle-a").click();
  await page.locator("#details-a .occurrences > summary").click();
  await expect(page.locator("#details-a")).toContainText(
    "Document-level check; no page preview is available.",
  );
  expect(libraries).toEqual([]);
});

test("object locations load structure parsing on demand", async ({ page }) => {
  const libraries = [];
  page.on("request", (request) => {
    if (/pdf-structure|pdf-lib/.test(request.url()))
      libraries.push(request.url());
  });
  await page.route("**/api/v1/documents/a/pdf", (route) =>
    route.fulfill({
      contentType: "application/pdf",
      path: fileURLToPath(
        new URL("../../tests/fixtures/ua-pass.pdf", import.meta.url),
      ),
    }),
  );
  await page.route("**/api/v1/documents/a/issues?*", (route) =>
    route.fulfill({
      json: {
        items: [
          {
            message: "Structure issue",
            count: 1,
            profiles: ["wcag-2.2"],
            occurrences: [
              {
                profile: "wcag-2.2",
                page: 1,
                message: "Unknown object",
                location: "(999 0 obj)",
              },
            ],
          },
        ],
        total: 1,
        offset: 0,
        limit: 100,
      },
    }),
  );
  await page.goto("/");
  await page.locator("#toggle-a").click();
  expect(libraries).toEqual([]);
  await page.locator("#details-a .occurrences > summary").click();
  await expect(page.locator("#details-a .preview-thumb")).toHaveCount(1);
  expect(libraries.some((url) => url.includes("pdf-structure"))).toBe(true);
});

test("preview caches enforce count and byte limits @source", async ({
  page,
}) => {
  await page.route("**/api/v1/documents/a/pdf", (route) =>
    route.fulfill({
      contentType: "application/pdf",
      path: fileURLToPath(
        new URL("../../tests/fixtures/ua-pass.pdf", import.meta.url),
      ),
    }),
  );
  await page.goto("/");
  const sizes = await page.evaluate(async () => {
    const { withDocument, cached } = await import("/src/pdf-document.js");
    const { renderOccurrencePreview } = await import("/src/pdf-previews.js");
    const signal = new AbortController().signal;
    const occurrence = {
      page: 1,
      location: '{"bbox":[{"p":0,"rect":[10,10,20,20]}]}',
    };
    for (let index = 0; index < 26; index++) {
      await renderOccurrencePreview(
        "a",
        { ...occurrence, message: String(index) },
        20,
        signal,
      );
    }
    const count = await withDocument("a", signal, async (source) => {
      const count = source.previews.size;
      source.previews.set("oversized", { src: "x".repeat(9 * 1024 * 1024) });
      for (let index = 0; index < 40; index++)
        await cached(source.markedContent, index, async () => index);
      return count;
    });
    await renderOccurrencePreview(
      "a",
      { ...occurrence, message: "after oversized" },
      20,
      signal,
    );
    return withDocument("a", signal, (source) => ({
      count,
      pages: source.markedContent.size,
      oversized: source.previews.has("oversized"),
      bytes: [...source.previews.values()].reduce(
        (sum, image) => sum + image.src.length * 2,
        0,
      ),
    }));
  });
  expect(sizes.count).toBe(24);
  expect(sizes.pages).toBe(32);
  expect(sizes.oversized).toBe(false);
  expect(sizes.bytes).toBeLessThanOrEqual(16 * 1024 * 1024);
});

test("closing a report aborts its PDF download", async ({ page }) => {
  let release;
  await page.route("**/api/v1/documents/a/pdf", async (route) => {
    await new Promise((resolve) => {
      release = resolve;
    });
    await route.fulfill({ status: 503 });
  });
  await page.goto("/");
  await page.locator("#toggle-a").click();
  await page.locator("#details-a .occurrences > summary").click();
  await expect.poll(() => !!release).toBe(true);
  const aborted = page.waitForEvent("requestfailed", (request) =>
    request.url().endsWith("/a/pdf"),
  );
  await page.locator("#toggle-a").click();
  await aborted;
  release();
  await expect(page.locator("#details-a .preview-thumb")).toHaveCount(0);
});
