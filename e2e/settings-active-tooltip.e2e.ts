import { test, expect, type Page } from "@playwright/test";
import { restoreSession } from "./support/session";

const SETTINGS_PATH = "/dashboard/settings";

/**
 * The "Automations in Advanced" panel lives on the default Settings tab and
 * carries the ACTIVE badge with the tooltip. Returns the badge trigger button.
 */
async function openAdvancedTab(page: Page) {
  const panel = page.getByRole("heading", { name: "Automations in Advanced" }).locator("..").locator("..");
  await expect(panel).toBeVisible();
  const trigger = panel.locator('button[aria-haspopup="true"][aria-controls]').first();
  await expect(trigger).toBeVisible();
  return trigger;
}

async function openDeclinedQuoteBadge(page: Page) {
  const panel = page.getByRole("heading", { name: "Declined-quote follow-up" }).locator("..").locator("..");
  await expect(panel).toBeVisible();
  const trigger = panel.locator('button[aria-haspopup="true"][aria-controls]').first();
  await expect(trigger).toBeVisible();
  return trigger;
}

test.describe("Settings · automation status tooltip a11y", () => {
  test.beforeEach(async ({ context, page, baseURL }) => {
    const restored = await restoreSession(context, page, baseURL!);
    test.skip(!restored, "No Supabase session available for authenticated e2e tests.");
    await page.goto(SETTINGS_PATH, { waitUntil: "domcontentloaded" });
    // Owner-only page; staff accounts see a "Restricted" panel.
    await expect(page.getByRole("heading", { name: "Settings" }).first()).toBeVisible();
  });

  test("keyboard opening traps focus inside the tooltip", async ({ page }) => {
    const trigger = await openAdvancedTab(page);
    const tooltipId = await trigger.getAttribute("aria-controls");
    const tooltip = page.locator(`#${tooltipId}`);

    await trigger.focus();
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("Enter");
    await expect(tooltip).toBeVisible();

    // Focus lands on the first control inside the tooltip.
    const focusables = tooltip.locator("button");
    const count = await focusables.count();
    expect(count).toBeGreaterThan(1);
    await expect(focusables.first()).toBeFocused();

    // Tab cycles forward through tooltip controls only, wrapping at the end.
    for (let i = 1; i < count; i++) {
      await page.keyboard.press("Tab");
      await expect(focusables.nth(i)).toBeFocused();
    }
    await page.keyboard.press("Tab");
    await expect(focusables.first()).toBeFocused();

    // Shift+Tab wraps backwards to the last control, still inside the tooltip.
    await page.keyboard.press("Shift+Tab");
    await expect(focusables.nth(count - 1)).toBeFocused();

    // Focus never escapes the tooltip subtree.
    const stillInside = await tooltip.evaluate(
      (el) => !!document.activeElement && el.contains(document.activeElement),
    );
    expect(stillInside).toBe(true);
  });

  test("arrow keys move between entries and stay inside the tooltip", async ({ page }) => {
    const trigger = await openAdvancedTab(page);
    const tooltipId = await trigger.getAttribute("aria-controls");
    const tooltip = page.locator(`#${tooltipId}`);

    await trigger.focus();
    await page.keyboard.press("ArrowDown");
    await expect(tooltip).toBeVisible();

    const focusables = tooltip.locator("button");
    const count = await focusables.count();
    await expect(focusables.first()).toBeFocused();

    await page.keyboard.press("ArrowDown");
    await expect(focusables.nth(1)).toBeFocused();

    await page.keyboard.press("End");
    await expect(focusables.nth(count - 1)).toBeFocused();

    await page.keyboard.press("Home");
    await expect(focusables.first()).toBeFocused();

    // ArrowUp from the first entry wraps to the last, never to the page body.
    await page.keyboard.press("ArrowUp");
    await expect(focusables.nth(count - 1)).toBeFocused();
  });

  test("Escape closes the tooltip and returns focus to the ACTIVE badge", async ({ page }) => {
    const trigger = await openAdvancedTab(page);
    const tooltipId = await trigger.getAttribute("aria-controls");
    const tooltip = page.locator(`#${tooltipId}`);

    await trigger.focus();
    await page.keyboard.press("Enter");
    await expect(tooltip).toBeVisible();
    await expect(tooltip.locator("button").first()).toBeFocused();

    await page.keyboard.press("Escape");

    await expect(tooltip).toBeHidden();
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await expect(trigger).toBeFocused();
  });

  test("outside click closes the tooltip and returns focus to the trigger", async ({ page }) => {
    const trigger = await openAdvancedTab(page);
    const tooltipId = await trigger.getAttribute("aria-controls");
    const tooltip = page.locator(`#${tooltipId}`);

    await trigger.focus();
    await page.keyboard.press("Enter");
    await expect(tooltip).toBeVisible();

    await page.mouse.click(5, 5);

    await expect(tooltip).toBeHidden();
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await expect(trigger).toBeFocused();
  });

  test('the "last evaluated" line is a polite atomic live region that is announced on refresh', async ({
    page,
  }) => {
    const trigger = await openAdvancedTab(page);
    const tooltipId = await trigger.getAttribute("aria-controls");
    const tooltip = page.locator(`#${tooltipId}`);

    await trigger.focus();
    await page.keyboard.press("Enter");
    await expect(tooltip).toBeVisible();

    const live = tooltip.locator('[aria-live="polite"]', { hasText: "Last evaluated" }).first();
    await expect(live).toBeVisible();
    await expect(live).toHaveAttribute("aria-live", "polite");
    await expect(live).toHaveAttribute("aria-atomic", "true");
    await expect(live).toContainText(/Last evaluated/i);

    // The announcement is not assertive and does not steal focus.
    await expect(live).not.toHaveAttribute("aria-live", "assertive");

    const before = (await live.textContent())?.trim();

    const refresh = tooltip.getByRole("button", { name: /Refresh automation statuses now/i });
    await refresh.focus();
    await refresh.click();

    // Focus stays on the refresh control while re-evaluating (aria-disabled, not disabled).
    await expect(refresh).toBeFocused();

    // The live region re-renders with a fresh evaluation timestamp.
    await expect
      .poll(async () => (await live.textContent())?.trim(), { timeout: 20_000 })
      .not.toBe(before);

    // Still polite + atomic after the update, and focus never jumped to <body>.
    await expect(live).toHaveAttribute("aria-live", "polite");
    await expect(live).toHaveAttribute("aria-atomic", "true");
    const focusInside = await tooltip.evaluate(
      (el) => !!document.activeElement && el.contains(document.activeElement),
    );
    expect(focusInside).toBe(true);
  });

  test("repeated clicks keep focus on Refresh now without jumping", async ({ page }) => {
    const trigger = await openAdvancedTab(page);
    const tooltipId = await trigger.getAttribute("aria-controls");
    const tooltip = page.locator(`#${tooltipId}`);

    await trigger.focus();
    await page.keyboard.press("Enter");
    await expect(tooltip).toBeVisible();

    const refresh = tooltip.getByRole("button", { name: /Refresh automation statuses now/i });
    const lastRefreshed = tooltip.locator('[aria-live="polite"]', { hasText: /Last evaluated/i }).first();
    const before = (await lastRefreshed.textContent())?.trim();

    await refresh.focus();
    await expect(refresh).toBeFocused();

    // Click repeatedly in quick succession. Because the button uses aria-disabled
    // instead of disabled, focus never drops to <body> even while re-evaluating.
    await refresh.click();
    await expect(refresh).toBeFocused();

    await refresh.click();
    await expect(refresh).toBeFocused();

    await refresh.click();
    await expect(refresh).toBeFocused();

    // The live region eventually reports a fresh evaluation timestamp.
    await expect
      .poll(async () => (await lastRefreshed.textContent())?.trim(), { timeout: 20_000 })
      .not.toBe(before);

    // After the refresh settles, focus is still on the Refresh now control.
    await expect(refresh).toBeFocused();

    // One more click after the update also keeps focus pinned.
    await refresh.click();
    await expect(refresh).toBeFocused();

    // The active element is the Refresh now button, never the page body.
    const active = await page.evaluate(() => document.activeElement?.getAttribute("aria-label"));
    expect(active).toMatch(/Refresh automation statuses/i);
  });

  test("tooltip container stays mounted and visible throughout a refresh", async ({ page }) => {
    const trigger = await openAdvancedTab(page);
    const tooltipId = await trigger.getAttribute("aria-controls");
    const tooltip = page.locator(`#${tooltipId}`);

    await trigger.focus();
    await page.keyboard.press("Enter");
    await expect(tooltip).toBeVisible();

    const refresh = tooltip.getByRole("button", { name: /Refresh automation statuses now/i });
    await refresh.focus();
    await expect(refresh).toBeFocused();

    // Start the refresh and immediately verify the tooltip DOM node is still the
    // same connected element — i.e. it has not been unmounted and recreated.
    await refresh.click();
    const stillConnected = await tooltip.evaluate((el) => el.isConnected);
    expect(stillConnected).toBe(true);
    await expect(tooltip).toBeVisible();
    await expect(refresh).toBeFocused();

    // Wait for the refresh to settle and confirm the tooltip never disappeared.
    const lastRefreshed = tooltip.locator('[aria-live="polite"]', { hasText: /Last evaluated/i }).first();
    await expect
      .poll(async () => (await lastRefreshed.textContent())?.trim(), { timeout: 20_000 })
      .toMatch(/Last evaluated/);
    await expect(tooltip).toBeVisible();
    await expect(refresh).toBeFocused();
    const connectedAfter = await tooltip.evaluate((el) => el.isConnected);
    expect(connectedAfter).toBe(true);
  });

  test("other status badges open with Enter/Space and trap focus", async ({ page }) => {
    const trigger = await openDeclinedQuoteBadge(page);
    const tooltipId = await trigger.getAttribute("aria-controls");
    const tooltip = page.locator(`#${tooltipId}`);

    await trigger.focus();
    await page.keyboard.press("Enter");
    await expect(tooltip).toBeVisible();

    // Focus lands on the Close button inside the tooltip.
    const close = tooltip.getByRole("button", { name: "Close" });
    await expect(close).toBeFocused();

    // Tab wraps on the single focusable control.
    await page.keyboard.press("Tab");
    await expect(close).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(close).toBeFocused();

    // Escape closes the tooltip and returns focus to the trigger.
    await page.keyboard.press("Escape");
    await expect(tooltip).toBeHidden();
    await expect(trigger).toBeFocused();

    // Space also opens the tooltip from the trigger.
    await page.keyboard.press("Space");
    await expect(tooltip).toBeVisible();
    await expect(close).toBeFocused();
  });
});
