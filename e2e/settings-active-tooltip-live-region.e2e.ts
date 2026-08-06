import { expect, test, type Page } from "@playwright/test";
import { restoreSession } from "./support/session";

const SETTINGS_PATH = "/dashboard/settings";

/**
 * The ACTIVE tooltip owns a polite live region that announces the automation
 * status outcome of every completed refresh. These tests assert that:
 *  - the region exists, is polite/atomic, and is never a focus target
 *  - its text changes after EACH refresh (repeat refreshes re-announce)
 *  - the announcement names the automation status and the re-check time
 *  - focus stays exactly where the user left it across every refresh
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

async function waitForAnnouncement(page: Page, live: ReturnType<Page["getByTestId"]>, previous: string) {
  await expect
    .poll(async () => (await live.textContent())?.trim() ?? "", {
      message: "tooltip live region should announce the refreshed automation status",
      timeout: 20_000,
    })
    .not.toBe(previous);
  return (await live.textContent())?.trim() ?? "";
}

test.describe("Settings · ACTIVE tooltip live region announcements", () => {
  test.beforeEach(async ({ context, page, baseURL }) => {
    const restored = await restoreSession(context, page, baseURL!);
    test.skip(!restored, "No Supabase session available for authenticated e2e tests.");
    await page.goto(SETTINGS_PATH, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Settings" }).first()).toBeVisible();
  });

  test("live region is polite, atomic and not focusable", async ({ page }) => {
    const { live } = await openTooltip(page);

    await expect(live).toHaveAttribute("aria-live", "polite");
    await expect(live).toHaveAttribute("aria-atomic", "true");
    await expect(live).toHaveAttribute("role", "status");

    // A live region must not be a tab stop or a focus target.
    expect(await live.getAttribute("tabindex")).toBeNull();
    await expect(live).not.toBeFocused();
    expect(
      await live.evaluate((el) => el.querySelectorAll("a,button,input,select,textarea,[tabindex]").length),
    ).toBe(0);
  });

  test("each refresh announces the updated automation status without stealing focus", async ({ page }) => {
    const { trigger, tooltip, live, refresh } = await openTooltip(page);

    // Park focus on the Refresh control and remember exactly where it is.
    await refresh.focus();
    const focusBefore = await focusSignature(page);
    let announcement = (await live.textContent())?.trim() ?? "";

    for (const pass of [1, 2]) {
      await refresh.click();

      const next = await waitForAnnouncement(page, live, announcement);

      // The announcement describes the automation status and when it was checked.
      expect(next, `pass ${pass}: announcement must name the automation`).toMatch(
        /Opt-in prompt & cooldown (ACTIVE|ON HOLD)/i,
      );
      expect(next, `pass ${pass}: announcement must report the refresh outcome`).toMatch(
        /Statuses (updated|already current)|Refresh failed/i,
      );
      expect(next, `pass ${pass}: announcement must carry a re-check time`).toMatch(/\d{1,2}:\d{2}/);

      // Focus never moved: same element before and after the refresh, still
      // inside the tooltip, and the live region itself never took focus.
      expect(await focusSignature(page), `pass ${pass}: focus moved during refresh`).toBe(focusBefore);
      await expect(refresh, `pass ${pass}: refresh button lost focus`).toBeFocused();
      await expect(live).not.toBeFocused();
      expect(
        await tooltip.evaluate((el) => !!document.activeElement && el.contains(document.activeElement)),
        `pass ${pass}: focus escaped the tooltip`,
      ).toBe(true);

      announcement = next;
    }

    // The tooltip is still open and Escape still returns focus to the trigger.
    await expect(tooltip).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(tooltip).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test("announcement fires even when focus is elsewhere in the tooltip", async ({ page }) => {
    const { tooltip, live, refresh } = await openTooltip(page);

    const other = tooltip.locator("button").first();
    await other.focus();
    const focusBefore = await focusSignature(page);
    const previous = (await live.textContent())?.trim() ?? "";

    // Mouse-driven refresh must not pull focus off the user's current control.
    await refresh.click();
    const next = await waitForAnnouncement(page, live, previous);
    expect(next).toMatch(/Opt-in prompt & cooldown/i);

    expect(await focusSignature(page)).toBe(focusBefore);
    await expect(other).toBeFocused();
  });
});
