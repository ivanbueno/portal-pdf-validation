import { test, expect } from "@playwright/test";
import { createServer } from "node:http";

test("portal CSP blocks inline scripts and unrelated connections", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.cspViolations = [];
    document.addEventListener("securitypolicyviolation", (event) =>
      window.cspViolations.push(event.effectiveDirective),
    );
  });
  const response = await page.goto("/");
  expect(response.headers()["content-security-policy"]).toContain(
    "default-src 'self'",
  );
  const result = await page.evaluate(async () => {
    const script = document.createElement("script");
    script.textContent = "window.injectedScriptRan = true";
    document.body.append(script);
    let blocked = false;
    try {
      await fetch("https://unrelated.invalid/exfiltrate");
    } catch {
      blocked = true;
    }
    return { executed: !!window.injectedScriptRan, blocked };
  });
  expect(result).toEqual({ executed: false, blocked: true });
  await expect
    .poll(() => page.evaluate(() => window.cspViolations))
    .toEqual(expect.arrayContaining(["script-src-elem", "connect-src"]));
});

test("another origin cannot frame the portal", async ({ page, baseURL }) => {
  const failures = [];
  page.on("requestfailed", (request) => {
    if (request.url() === `${baseURL}/`)
      failures.push(request.failure().errorText);
  });
  // A real loopback server gives Chromium the correct address space. Route-fulfilled
  // pages trigger local-network blocking before the child frame's headers are checked.
  const parent = createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end(`<iframe src="${baseURL}/"></iframe>`);
  });
  await new Promise((resolve) => parent.listen(0, "127.0.0.1", resolve));
  try {
    await page.goto(`http://127.0.0.1:${parent.address().port}/`);
    await expect.poll(() => failures).toContain("net::ERR_BLOCKED_BY_RESPONSE");
    await expect(page.frameLocator("iframe").locator("#files")).toHaveCount(0);
  } finally {
    parent.closeAllConnections();
    await new Promise((resolve) => parent.close(resolve));
  }
});

test("configured direct-upload origin remains reachable under CSP", async ({
  page,
}) => {
  const response = await page.goto("/");
  const connect = response
    .headers()
    ["content-security-policy"].split(";")
    .find((directive) => directive.trim().startsWith("connect-src "));
  const origin = connect.trim().split(/\s+/)[2];
  expect(origin).toBeTruthy();
  await page.route(`${origin}/csp-upload-check`, (route) =>
    route.fulfill({
      status: 201,
      headers: { "Access-Control-Allow-Origin": "*" },
    }),
  );
  const status = await page.evaluate(async (url) => {
    const response = await fetch(url, { method: "PUT", body: "synthetic PDF" });
    return response.status;
  }, `${origin}/csp-upload-check`);
  expect(status).toBe(201);
});
