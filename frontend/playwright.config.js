import { defineConfig } from "@playwright/test";
// Tests tagged @source stub or import modules by their source path, which only
// the Vite dev server serves: built chunks are hashed and minify export names.
const SOURCE_URL = "http://127.0.0.1:5173";
export default defineConfig({
  testDir: "tests",
  timeout: 60000,
  workers: 1,
  use: {
    channel: "chromium",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "app",
      grepInvert: /@source/,
      use: { baseURL: process.env.PORTAL_URL || "http://127.0.0.1:8000" },
    },
    { name: "source", grep: /@source/, use: { baseURL: SOURCE_URL } },
  ],
  webServer: {
    command: "npm run dev -- --port 5173 --strictPort",
    url: SOURCE_URL,
    reuseExistingServer: true,
  },
  reporter: "list",
});
