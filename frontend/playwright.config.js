import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests",
  timeout: 60000,
  workers: 1,
  use: {
    channel: "chromium",
    baseURL: process.env.PORTAL_URL || "http://127.0.0.1:8000",
    screenshot: "only-on-failure",
  },
  reporter: "list",
});
