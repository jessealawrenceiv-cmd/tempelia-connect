import { expect, test, type Locator, type Page } from "@playwright/test";
import { restoreSession } from "./support/session";

const SETTINGS_PATH = "/dashboard/settings";
// The status-refresh server function is addressed by a base64 id that always
// contains the source file name, so we can fail/stall just that call.
const STATUS_REFRESH_FN = "c3RhdHVzLXJlZnJlc2g";

/**
 * Outcome coverage for the ACTIVE tooltip live region.
 *
 * The happy path is covered in settings-active-tooltip-live-region.e2e.ts.
 * Here we force the *other* refresh outcomes and assert each one is announced
 * politely while focus never moves:
 *  - hard failure of the refresh server function -> "Refresh failed — statuses unchanged"
 *  - partial data (server fn OK, profile re-read fails) -> failure announcement, statuses unchanged
 *  - lock contention ("already running") -> page live region announces, tooltip text is not corrupted
 *  - recovery after a failure -> next announcement reports a successful re-check
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
    tooltip,
    live: tooltip.getByTestId("adv-tooltip-status-live"),
    refresh: tooltip.getByRole("button", { name: /Refresh automation statuses now/i }),
  };
}

/** Stable identity of the currently focused element. */
function focusSignature(page: Page) {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return "NONE";
    return [el.tagName, el.getAttribute("data-testid") ?? "", el.getAttribute("aria-label") ?? ""].join("|");
  });
}

async function waitForText(live: Locator, previous: string) {
  await expect
    .poll(async () => (await live.textContent())?.trim() ?? "", {
      message: "tooltip live region should announce the refresh outcome",
      timeout: 20_000,
    })
    .not.toBe(previous);
  return (await live.textContent())?.trim() ?? "";
}

/** Fail the status-refresh server function itself. */
async function failRefreshFn(page: Page, message = "Simulated refresh failure") {
  await page.route("**/_serverFn/**", async (route) => {
    if (route.request().url().includes(STATUS_REFRESH_FN)) {
      await new Promise((r) => setTimeout(r, 300));
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ message }),
      });
      return;
    }
    await route.fallback();
  });
}

/** Partial outcome: the lock/refresh succeeds but the profile re-read fails. */
async function failProfileRead(page: Page) {
  await page.route("**/rest/v1/profiles*", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ message: "Partial refresh: profile data unavailable" }),
    });
  });
}

test.describe("Settings · ACTIVE tooltip live region · refresh outcomes", () => {
  test.beforeEach(async ({ context, page, baseURL }) => {
    const restored = await restoreSession(context, page, baseURL!);
    test.skip(!restored, "No Supabase session available for authenticated e2e tests.");
    await page.goto(SETTINGS_PATH, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Settings" }).first()).toBeVisible();
  });

  test("a failed refresh is announced as failed and unchanged, focus stays put", async ({ page }) => {
    const { tooltip, live, refresh } = await openTooltip(page);
    await failRefreshFn(page, "Simulated refresh failure");

    await refresh.focus();
    const focusBefore = await focusSignature(page);
    const previous = (await live.textContent())?.trim() ?? "";

    await refresh.click();
    const announced = await waitForText(live, previous);

    expect(announced).toMatch(/Refresh failed/i);
    expect(announced, "failure must state statuses were not changed").toMatch(/statuses unchanged/i);
    expect(announced, "failure must carry an underlying reason").toMatch(/unchanged\.\s*\S+/i);

    // Politeness: an announcement must never grab focus.
    await expect(live).toHaveAttribute("aria-live", "polite");
    await expect(live).not.toBeFocused();
    // The failure handler intentionally moves focus to Retry; what must never
    // happen is focus dropping to <body> or being pulled by the live region.
    const focusAfter = await focusSignature(page);
    expect(focusAfter, "focus dropped out of the tooltip on failure").not.toBe("NONE");
    expect(focusAfter, "focus fell to the document body on failure").toMatch(
      /Refresh automation statuses|Retry refresh/i,
    );
    expect(focusBefore).toMatch(/Refresh automation statuses/i);
    expect(
      await tooltip.evaluate((el) => !!document.activeElement && el.contains(document.activeElement)),
      "focus escaped the tooltip on failure",
    ).toBe(true);
  });

  test("partial data (profile re-read fails) announces an honest outcome, never a false update", async ({ page }) => {
    const { tooltip, live, refresh } = await openTooltip(page);
    await failProfileRead(page);

    const other = tooltip.locator("button").first();
    await other.focus();
    const focusBefore = await focusSignature(page);
    const previous = (await live.textContent())?.trim() ?? "";

    // Programmatic click: no pointer focus side effects.
    await refresh.evaluate((el) => (el as HTMLElement).click());
    const announced = await waitForText(live, previous);

    // Degraded read must never be reported as a successful status change; the
    // tooltip may only say the statuses are unchanged or that the refresh failed.
    expect(announced, "partial data must not be announced as an update").not.toMatch(/Statuses updated/i);
    expect(announced, "partial data must still report an outcome").toMatch(
      /Statuses already current|Refresh failed/i,
    );
    expect(announced, "outcome must be timestamped or explained").toMatch(/\d{1,2}:\d{2}|unchanged/i);

    expect(await focusSignature(page), "focus moved on the partial-data path").toBe(focusBefore);
    await expect(other).toBeFocused();
    await expect(live).not.toBeFocused();
  });

  test("a concurrent refresh is announced as already running and never as success", async ({ page }) => {
    const { live, refresh } = await openTooltip(page);

    // Server reports the single-run lock was held by someone else.
    await page.route("**/_serverFn/**", async (route) => {
      if (route.request().url().includes(STATUS_REFRESH_FN)) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            result: { ran: false, skipped: "in_progress", evaluatedAt: new Date().toISOString() },
          }),
        });
        return;
      }
      await route.fallback();
    });

    await refresh.focus();
    const focusBefore = await focusSignature(page);
    const tooltipTextBefore = (await live.textContent())?.trim() ?? "";
    const pageLive = page.locator('[aria-live="polite"]').filter({ hasText: /refresh/i }).first();

    await refresh.click();

    // The page-level live region reports the contention outcome.
    await expect
      .poll(async () => (await pageLive.textContent())?.trim() ?? "", { timeout: 20_000 })
      .toMatch(/already running|Refreshing automation statuses/i);

    // The tooltip status text must never be rewritten into a success claim.
    const tooltipTextAfter = (await live.textContent())?.trim() ?? "";
    expect(tooltipTextAfter).not.toMatch(/Statuses updated|Statuses already current/i);
    expect(tooltipTextAfter).toBe(tooltipTextBefore);

    expect(await focusSignature(page), "focus moved while a refresh was already running").toBe(focusBefore);
    await expect(refresh).toBeFocused();
  });

  test("recovery after a failure announces the new successful outcome", async ({ page }) => {
    const { live, refresh } = await openTooltip(page);
    await failRefreshFn(page, "Transient refresh failure");

    await refresh.focus();
    const focusBefore = await focusSignature(page);
    let text = (await live.textContent())?.trim() ?? "";

    await refresh.click();
    text = await waitForText(live, text);
    expect(text).toMatch(/Refresh failed/i);

    // Drop the fault injection and refresh again from the same control.
    await page.unroute("**/_serverFn/**");
    await refresh.focus();
    const focusDuringRecovery = await focusSignature(page);
    await refresh.click();

    const recovered = await waitForText(live, text);
    expect(recovered, "recovery must report a real outcome").toMatch(
      /Statuses (updated|already current)/i,
    );
    expect(recovered).toMatch(/Opt-in prompt & cooldown (ACTIVE|ON HOLD)/i);
    expect(recovered).toMatch(/\d{1,2}:\d{2}/);
    expect(recovered).not.toMatch(/Refresh failed/i);

    expect(await focusSignature(page), "focus moved during recovery refresh").toBe(focusDuringRecovery);
    await expect(live).not.toBeFocused();
    expect(focusBefore).toBeTruthy();
  });
});
