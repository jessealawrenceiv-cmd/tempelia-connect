import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright e2e config.
 *
 * Assumes the dev server is already running on http://localhost:8080
 * (set E2E_BASE_URL to point somewhere else).
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: process.env["E2E_BASE_URL"] ?? "http://localhost:8080",
    trace: "retain-on-failure",
    viewport: { width: 1280, height: 1800 },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
