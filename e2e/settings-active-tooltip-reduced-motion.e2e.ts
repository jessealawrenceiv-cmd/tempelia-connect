import { expect, test, type Locator, type Page } from "@playwright/test";
import { restoreSession } from "./support/session";

const SETTINGS_PATH = "/dashboard/settings";

/**
 * Reduced-motion coverage for the ACTIVE tooltip.
 *
 * With `prefers-reduced-motion: reduce`, animations are suppressed (the refresh
 * progress bar switches to a static full-width bar, spinners stop spinning).
 * Those style swaps must never affect *behaviour*: refreshing from inside the
 * tooltip must not move focus, must not close the tooltip, and Tab/Shift+Tab
 * must keep cycling only through the tooltip's own controls.
 */
async function openTooltip(page: Page) {
  const panel = page
    .getByRole("heading", { name: "Automations in Advanced" })
    .locator("..")
    .locator("..");
  await expect(panel).toBeVisible();
  const trigger = panel.locator('button[aria-haspopup="true"][aria-controls]').first();
  await expect(trigger).toBeVisible();
  const tooltipId = await trigger.getAttribute("aria-controls");
  expect(tooltipId).toBeTruthy();
  const tooltip = page.locator(`#${tooltipId}`);

  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(tooltip).toBeVisible();

  return {
    trigger,
    tooltipId: tooltipId!,
    tooltip,
    live: tooltip.getByTestId("adv-tooltip-status-live"),
    refresh: tooltip.getByRole("button", { name: /Refresh automation statuses now/i }),
  };
}

/** A stable description of the focused element, for before/after comparison. */
function focusSignature(page: Page) {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return "none";
    return [
      el.tagName.toLowerCase(),
      el.getAttribute("data-testid") ?? "",
      el.getAttribute("aria-label") ?? "",
      (el.textContent ?? "").trim().slice(0, 40),
    ].join("|");
  });
}

async function isFocusInside(tooltip: Locator) {
  return tooltip.evaluate((el) => el.contains(document.activeElement));
}

/** Click Refresh now and wait for a genuine completed refresh cycle. */
async function refreshOnce(refresh: Locator, live: Locator) {
  const before = (await live.textContent())?.trim() ?? "";
  await refresh.click();
  await expect(refresh).toHaveAttribute("aria-busy", "false", { timeout: 20_000 });
  await expect
    .poll(async () => (await live.textContent())?.trim() ?? "", { timeout: 20_000 })
    .not.toBe(before);
}

test.describe("Settings · ACTIVE tooltip under prefers-reduced-motion", () => {
  test.beforeEach(async ({ context, page, baseURL }) => {
    const restored = await restoreSession(context, page, baseURL!);
    test.skip(!restored, "No Supabase session available for authenticated e2e tests.");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(SETTINGS_PATH, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Settings" }).first()).toBeVisible();
  });

  test("reduced motion is actually in effect", async ({ page }) => {
    expect(
      await page.evaluate(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches),
    ).toBe(true);
  });

  test("refreshing never moves focus off the Refresh button", async ({ page }) => {
    const { tooltip, refresh, live } = await openTooltip(page);

    await refresh.focus();
    const before = await focusSignature(page);
    await expect(refresh).toBeFocused();

    for (let round = 1; round <= 3; round += 1) {
      await refreshOnce(refresh, live);

      expect(await isFocusInside(tooltip), `focus escaped tooltip on refresh ${round}`).toBe(true);
      await expect(refresh, `focus moved off Refresh on refresh ${round}`).toBeFocused();
      expect(await focusSignature(page)).toBe(before);
      await expect(tooltip).toBeVisible();
    }
  });

  test("keyboard-triggered refresh keeps focus and the tooltip open", async ({ page }) => {
    const { tooltip, refresh, live } = await openTooltip(page);

    await refresh.focus();
    const before = (await live.textContent())?.trim() ?? "";
    await page.keyboard.press("Enter");
    await expect(refresh).toHaveAttribute("aria-busy", "false", { timeout: 20_000 });
    await expect
      .poll(async () => (await live.textContent())?.trim() ?? "", { timeout: 20_000 })
      .not.toBe(before);

    await expect(refresh).toBeFocused();
    await expect(tooltip).toBeVisible();

    // Space also activates without displacing focus.
    await page.keyboard.press(" ");
    await expect(refresh).toHaveAttribute("aria-busy", "false", { timeout: 20_000 });
    await expect(refresh).toBeFocused();
    await expect(tooltip).toBeVisible();
  });

  test("Tab / Shift+Tab still cycle inside the tooltip after a refresh", async ({ page }) => {
    const { tooltip, refresh, live } = await openTooltip(page);

    const focusables = tooltip.locator(
      'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    const countBefore = await focusables.count();
    expect(countBefore).toBeGreaterThan(0);

    await refreshOnce(refresh, live);
    expect(await focusables.count(), "focusable set changed across refresh").toBe(countBefore);

    await refresh.focus();
    // Forward cycle: every stop must remain inside the tooltip.
    for (let i = 0; i < countBefore + 1; i += 1) {
      await page.keyboard.press("Tab");
      expect(await isFocusInside(tooltip), `Tab #${i + 1} escaped the tooltip`).toBe(true);
    }
    // Backward cycle behaves the same.
    for (let i = 0; i < countBefore + 1; i += 1) {
      await page.keyboard.press("Shift+Tab");
      expect(await isFocusInside(tooltip), `Shift+Tab #${i + 1} escaped the tooltip`).toBe(true);
    }

    await expect(tooltip).toBeVisible();
  });

  test("Escape after a reduced-motion refresh closes the tooltip and returns focus", async ({ page }) => {
    const { trigger, tooltip, refresh, live } = await openTooltip(page);

    await refresh.focus();
    await refreshOnce(refresh, live);
    await expect(refresh).toBeFocused();

    await page.keyboard.press("Escape");
    await expect(tooltip).toBeHidden();
    await expect(trigger).toBeFocused();
  });
});
