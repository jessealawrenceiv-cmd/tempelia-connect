import { expect, test, type Page } from "@playwright/test";
import { restoreSession } from "./support/session";

const SETTINGS_PATH = "/dashboard/settings";
const STATUS_REFRESH_FN = "c3RhdHVzLXJlZnJlc2g";

/**
 * Enter/Space on "Refresh now" while it is BUSY or in a failure COOLDOWN must be
 * ignored: no extra refresh run is started, and focus never leaves the button.
 *
 * The button exposes two counters as data attributes:
 *  - data-refresh-runs   -> how many refresh runs actually started
 *  - data-ignored-keys   -> how many activations were swallowed
 */
async function openTooltip(page: Page) {
  const panel = page
    .getByRole("heading", { name: "Automations in Advanced" })
    .locator("..")
    .locator("..");
  await expect(panel).toBeVisible();
  const trigger = panel.locator('button[aria-haspopup="true"][aria-controls]').first();
  const tooltipId = await trigger.getAttribute("aria-controls");
  expect(tooltipId).toBeTruthy();
  const tooltip = page.locator(`#${tooltipId}`);

  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(tooltip).toBeVisible();

  return {
    trigger,
    tooltip,
    tooltipId: tooltipId!,
    refresh: tooltip.getByTestId("refresh-now-btn"),
  };
}

async function counters(page: Page) {
  const btn = page.getByTestId("refresh-now-btn").first();
  return {
    runs: Number((await btn.getAttribute("data-refresh-runs")) ?? "-1"),
    ignored: Number((await btn.getAttribute("data-ignored-keys")) ?? "-1"),
  };
}

/** Hold the refresh server function open so the button stays busy. */
async function stallRefresh(page: Page, ms = 4_000) {
  await page.route("**/_serverFn/**", async (route) => {
    if (route.request().url().includes(STATUS_REFRESH_FN)) {
      await new Promise((r) => setTimeout(r, ms));
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ result: { ran: true, evaluatedAt: new Date().toISOString() } }),
      });
      return;
    }
    await route.fallback();
  });
}

/** Always fail the refresh, so 3 attempts push the button into cooldown. */
async function failRefresh(page: Page) {
  await page.route("**/_serverFn/**", async (route) => {
    if (route.request().url().includes(STATUS_REFRESH_FN)) {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ message: "Simulated refresh failure" }),
      });
      return;
    }
    await route.fallback();
  });
}

test.describe("Settings · Refresh now · keys ignored while busy or cooling down", () => {
  test.beforeEach(async ({ context, page, baseURL }) => {
    const restored = await restoreSession(context, page, baseURL!);
    test.skip(!restored, "No Supabase session available for authenticated e2e tests.");
    await page.goto(SETTINGS_PATH, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Settings" }).first()).toBeVisible();
  });

  test("Enter/Space during a busy refresh queue nothing and keep focus pinned", async ({ page }) => {
    const { tooltip, refresh } = await openTooltip(page);
    await stallRefresh(page);

    await refresh.focus();
    await expect(refresh).toBeFocused();
    await refresh.press("Enter");

    await expect(refresh).toHaveAttribute("aria-busy", "true");
    const started = await counters(page);
    expect(started.runs, "the first Enter must start exactly one run").toBe(1);

    // Hammer Enter and Space while the refresh is still in flight.
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press(i % 2 === 0 ? "Enter" : "Space");
      await expect(refresh, "focus must stay on the same button").toBeFocused();
      await expect(tooltip, "an ignored key must not close the tooltip").toBeVisible();
      await expect(refresh).toHaveAttribute("aria-busy", "true");
    }

    const during = await counters(page);
    expect(during.runs, "no extra refresh may be queued while busy").toBe(1);
    expect(during.ignored, "every busy keypress must be recorded as ignored").toBeGreaterThanOrEqual(6);

    // Let the stalled refresh finish; still exactly one run, focus preserved.
    await expect(refresh).toHaveAttribute("aria-busy", "false", { timeout: 20_000 });
    const after = await counters(page);
    expect(after.runs, "the ignored keys must never fire late").toBe(1);
    await expect(refresh).toBeFocused();
  });

  test("Enter/Space during the failure cooldown are ignored, focus stays on the button", async ({ page }) => {
    const { tooltip } = await openTooltip(page);
    await failRefresh(page);

    // Three failures trigger the escalating cooldown.
    const retry = tooltip.getByRole("button", { name: /Retry refreshing automation statuses/i });
    const refresh = tooltip.getByTestId("refresh-now-btn");

    await refresh.focus();
    await refresh.press("Enter");
    await expect(refresh).toHaveAttribute("aria-busy", "false", { timeout: 20_000 });
    for (let i = 0; i < 2; i++) {
      await expect(retry).toBeVisible();
      await retry.focus();
      await retry.press("Enter");
      await expect(refresh).toHaveAttribute("aria-busy", "false", { timeout: 20_000 });
    }

    // Cooldown is on: the label says so.
    await expect
      .poll(async () => (await refresh.getAttribute("aria-label")) ?? "", {
        message: "the button should report a cooldown after 3 failures",
        timeout: 15_000,
      })
      .toMatch(/cooldown/i);

    const before = await counters(page);
    await refresh.focus();
    await expect(refresh).toBeFocused();

    for (let i = 0; i < 5; i++) {
      await page.keyboard.press(i % 2 === 0 ? "Enter" : "Space");
      await expect(refresh, "focus must stay on the same button during cooldown").toBeFocused();
      await expect(tooltip).toBeVisible();
    }

    const after = await counters(page);
    expect(after.runs, "cooldown keypresses must not start a refresh").toBe(before.runs);
    expect(after.ignored, "cooldown keypresses must be recorded as ignored").toBeGreaterThanOrEqual(
      before.ignored + 5,
    );
  });

  test("a single Enter still works once the button is idle again", async ({ page }) => {
    const { refresh } = await openTooltip(page);
    await stallRefresh(page, 500);

    await refresh.focus();
    await refresh.press("Enter");
    await expect(refresh).toHaveAttribute("aria-busy", "false", { timeout: 20_000 });
    const first = await counters(page);

    await refresh.focus();
    await refresh.press("Enter");
    await expect
      .poll(async () => (await counters(page)).runs, {
        message: "an idle button must accept a fresh Enter",
        timeout: 15_000,
      })
      .toBe(first.runs + 1);
    await expect(refresh).toBeFocused();
  });
});
