import { expect, test, type Page } from "@playwright/test";
import { restoreSession } from "./support/session";

const SETTINGS_PATH = "/dashboard/settings";
// The status-refresh server function is addressed by a base64 id that always
// contains the source file name, so we can stall just that call.
const STATUS_REFRESH_FN = "c3RhdHVzLXJlZnJlc2g";

/**
 * Keyboard navigation while a refresh is IN FLIGHT.
 *
 * Regression guard for two failures:
 *  1. Tab / Shift+Tab skipping the "Refresh now" button while it is busy
 *     (e.g. because it got disabled or swapped for a spinner node).
 *  2. Focus landing on a tooltip element that was unmounted mid-refresh
 *     (a detached node -> screen readers announce nothing, keys go nowhere).
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
    tooltipId: tooltipId!,
    trigger,
    tooltip,
    // Label flips to "Refreshing automation statuses" while busy, so match both.
    refresh: tooltip.locator('button[aria-label*="automation statuses"]').first(),
  };
}

/** Where is focus, is the node still in the document, and is it inside the tooltip? */
function focusState(page: Page, tooltipId: string) {
  return page.evaluate((id) => {
    const el = document.activeElement as HTMLElement | null;
    const tooltip = document.getElementById(id);
    return {
      tag: el?.tagName ?? "NONE",
      label: el?.getAttribute("aria-label") ?? el?.textContent?.trim().slice(0, 60) ?? "",
      testid: el?.getAttribute("data-testid") ?? "",
      connected: el ? el.isConnected : false,
      isBody: el === document.body,
      insideTooltip: !!(el && tooltip && tooltip.contains(el)),
      tooltipPresent: !!tooltip,
    };
  }, tooltipId);
}

/** Hold the refresh server function open so the button stays busy while we tab. */
async function stallRefresh(page: Page, ms = 4_000) {
  await page.route("**/_serverFn/**", async (route) => {
    if (route.request().url().includes(STATUS_REFRESH_FN)) {
      await new Promise((r) => setTimeout(r, ms));
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          result: { ran: true, evaluatedAt: new Date().toISOString() },
        }),
      });
      return;
    }
    await route.fallback();
  });
}

test.describe("Settings · ACTIVE tooltip · Tab during in-flight refresh", () => {
  test.beforeEach(async ({ context, page, baseURL }) => {
    const restored = await restoreSession(context, page, baseURL!);
    test.skip(!restored, "No Supabase session available for authenticated e2e tests.");
    await page.goto(SETTINGS_PATH, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Settings" }).first()).toBeVisible();
  });

  test("Tab cycles reach the busy Refresh now button and never leave the tooltip", async ({ page }) => {
    const { tooltip, tooltipId, refresh } = await openTooltip(page);
    await stallRefresh(page);

    await refresh.focus();
    await expect(refresh).toBeFocused();
    await refresh.click();

    // Sanity: the refresh really is in flight while we press keys.
    await expect
      .poll(async () => (await refresh.getAttribute("aria-busy")) ?? "", {
        message: "refresh should report a busy state",
        timeout: 5_000,
      })
      .toBe("true");

    const focusableCount = await tooltip.locator("button, [href], [tabindex]:not([tabindex='-1'])").count();
    expect(focusableCount, "tooltip must expose focusable controls").toBeGreaterThan(0);

    // Walk forward a full cycle (plus one) and record everything we land on.
    const seen: string[] = [];
    for (let i = 0; i < focusableCount + 1; i++) {
      await page.keyboard.press("Tab");
      const state = await focusState(page, tooltipId);
      expect(state.tooltipPresent, "tooltip must not unmount during refresh").toBe(true);
      expect(state.connected, `focus landed on a detached node after ${i + 1} Tab press(es)`).toBe(true);
      expect(state.isBody, `focus fell out to <body> after ${i + 1} Tab press(es)`).toBe(false);
      expect(state.insideTooltip, `focus escaped the tooltip after ${i + 1} Tab press(es)`).toBe(true);
      seen.push(`${state.label} ${state.testid}`.trim());
    }

    expect(
      seen.some((s) => /refresh/i.test(s)),
      `forward Tab cycle skipped the busy Refresh now button. Visited: ${JSON.stringify(seen)}`,
    ).toBe(true);
  });

  test("Shift+Tab cycles also reach the busy Refresh now button", async ({ page }) => {
    const { tooltip, tooltipId, refresh } = await openTooltip(page);
    await stallRefresh(page);

    await refresh.focus();
    await refresh.click();

    const focusableCount = await tooltip.locator("button, [href], [tabindex]:not([tabindex='-1'])").count();

    const seen: string[] = [];
    for (let i = 0; i < focusableCount + 1; i++) {
      await page.keyboard.press("Shift+Tab");
      const state = await focusState(page, tooltipId);
      expect(state.tooltipPresent, "tooltip must not unmount during refresh").toBe(true);
      expect(state.connected, `focus landed on a detached node after ${i + 1} Shift+Tab press(es)`).toBe(true);
      expect(state.isBody, `focus fell out to <body> after ${i + 1} Shift+Tab press(es)`).toBe(false);
      expect(state.insideTooltip, `focus escaped the tooltip after ${i + 1} Shift+Tab press(es)`).toBe(true);
      seen.push(`${state.label} ${state.testid}`.trim());
    }

    expect(
      seen.some((s) => /refresh/i.test(s)),
      `backward Tab cycle skipped the busy Refresh now button. Visited: ${JSON.stringify(seen)}`,
    ).toBe(true);
  });

  test("rapid Tab/Shift+Tab bursts mid-refresh keep focus on a live tooltip node", async ({ page }) => {
    const { tooltipId, refresh } = await openTooltip(page);
    await stallRefresh(page);

    await refresh.focus();
    await refresh.click();

    for (let i = 0; i < 12; i++) {
      await page.keyboard.press(i % 2 === 0 ? "Tab" : "Shift+Tab");
    }

    const state = await focusState(page, tooltipId);
    expect(state.tooltipPresent, "tooltip survived the key burst").toBe(true);
    expect(state.connected, "focus must stay on a mounted element").toBe(true);
    expect(state.insideTooltip, "focus must remain trapped in the tooltip").toBe(true);

    // Focus must still be usable: the refresh control is reachable again.
    await expect
      .poll(
        async () => {
          await page.keyboard.press("Tab");
          const s = await focusState(page, tooltipId);
          return `${s.label} ${s.testid}`;
        },
        { message: "Refresh now must remain reachable after a key burst", timeout: 10_000 },
      )
      .toMatch(/refresh/i);
  });
});
