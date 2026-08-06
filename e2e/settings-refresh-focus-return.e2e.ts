import { expect, test, type Page } from "@playwright/test";
import { restoreSession } from "./support/session";

const SETTINGS_PATH = "/dashboard/settings";

/**
 * Focus-return coverage for a *successful* refresh: whichever tooltip control
 * the user activated must still hold focus once the refresh completes — the very
 * same DOM node, not a re-created look-alike and not the badge trigger.
 *
 * Node identity is proven by stamping the clicked element with a unique
 * attribute before the click and asserting `document.activeElement` still
 * carries that stamp afterwards (a remount/replacement would lose it).
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
    lastEvaluated: tooltip.locator('[aria-live="polite"]', { hasText: /Last evaluated/i }).first(),
    refresh: tooltip.getByRole("button", { name: /Refresh automation statuses now/i }),
  };
}

/** Stamp an element so we can recognise the exact same node later. */
async function stampElement(locator: ReturnType<Page["locator"]>, stamp: string) {
  await locator.evaluate((el, value) => el.setAttribute("data-focus-stamp", value), stamp);
}

/** Everything we need to compare focus identity across a refresh. */
function focusIdentity(page: Page) {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return { stamp: null as string | null, tag: "NONE", label: "", text: "" };
    return {
      stamp: el.getAttribute("data-focus-stamp"),
      tag: el.tagName,
      label: el.getAttribute("aria-label") ?? "",
      text: (el.textContent ?? "").trim().slice(0, 24),
    };
  });
}

/**
 * Samples document.activeElement while `action` runs so a momentary focus drop
 * between Playwright assertions cannot go unnoticed.
 */
async function recordFocusDuring(page: Page, action: () => Promise<void>) {
  await page.evaluate(() => {
    const w = window as unknown as { __samples?: string[]; __timer?: number };
    w.__samples = [];
    const sample = () => {
      const el = document.activeElement as HTMLElement | null;
      w.__samples!.push(
        el
          ? `${el.tagName}|${el.getAttribute("data-focus-stamp") ?? ""}|${el.getAttribute("aria-label") ?? ""}`
          : "NONE",
      );
    };
    sample();
    w.__timer = window.setInterval(sample, 20);
    document.addEventListener("focusin", sample, true);
    document.addEventListener("focusout", sample, true);
  });

  await action();

  return page.evaluate(() => {
    const w = window as unknown as { __samples?: string[]; __timer?: number };
    if (w.__timer) window.clearInterval(w.__timer);
    return w.__samples ?? [];
  });
}

test.describe("Settings · focus returns to the clicked control after a refresh", () => {
  test.beforeEach(async ({ context, page, baseURL }) => {
    const restored = await restoreSession(context, page, baseURL!);
    test.skip(!restored, "No Supabase session available for authenticated e2e tests.");
    await page.goto(SETTINGS_PATH, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Settings" }).first()).toBeVisible();
  });

  test("clicking Refresh now returns focus to that exact button when the refresh completes", async ({ page }) => {
    const { tooltip, refresh, live, lastEvaluated } = await openTooltip(page);

    await stampElement(refresh, "clicked-refresh");
    const before = await (async () => {
      await refresh.focus();
      return focusIdentity(page);
    })();
    expect(before.stamp).toBe("clicked-refresh");

    const announcementBefore = (await live.textContent())?.trim() ?? "";
    const evaluatedBefore = (await lastEvaluated.textContent())?.trim() ?? "";

    // Start the refresh, then wait for it to actually complete: aria-busy flips
    // back to false, the live region re-announces, and the evaluated line moves.
    const samples = await recordFocusDuring(page, async () => {
      await refresh.click();
      await expect(refresh).toHaveAttribute("aria-busy", "false", { timeout: 20_000 });
      await expect
        .poll(async () => (await live.textContent())?.trim() ?? "", { timeout: 20_000 })
        .not.toBe(announcementBefore);
      await expect
        .poll(async () => (await lastEvaluated.textContent())?.trim() ?? "", { timeout: 20_000 })
        .not.toBe(evaluatedBefore);
    });

    // Focus never fell to the document or hopped to another control mid-refresh.
    const escaped = samples.filter((s) => s === "NONE" || s.startsWith("BODY") || s.startsWith("HTML"));
    expect(escaped, `focus escaped during the refresh: ${escaped.join(", ")}`).toEqual([]);
    const foreign = samples.filter((s) => !s.includes("clicked-refresh"));
    expect(foreign, `focus moved off the clicked control: ${foreign.join(", ")}`).toEqual([]);

    // The focused node is the very same element that was clicked.
    const after = await focusIdentity(page);
    expect(after.stamp).toBe("clicked-refresh");
    expect(after.tag).toBe(before.tag);
    await expect(refresh).toBeFocused();
    expect(
      await refresh.evaluate((el) => el === document.activeElement && el.isConnected),
    ).toBe(true);

    // Focus stayed inside the tooltip, and the tooltip is still open.
    await expect(tooltip).toBeVisible();
    expect(await tooltip.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  });

  test("keyboard-activated refresh also returns focus to the same control", async ({ page }) => {
    const { tooltip, refresh, live } = await openTooltip(page);

    await stampElement(refresh, "keyboard-refresh");
    await refresh.focus();
    await expect(refresh).toBeFocused();

    const announcementBefore = (await live.textContent())?.trim() ?? "";

    await page.keyboard.press("Enter");
    await expect(refresh).toHaveAttribute("aria-busy", "false", { timeout: 20_000 });
    await expect
      .poll(async () => (await live.textContent())?.trim() ?? "", { timeout: 20_000 })
      .not.toBe(announcementBefore);

    const after = await focusIdentity(page);
    expect(after.stamp).toBe("keyboard-refresh");
    await expect(refresh).toBeFocused();
    await expect(tooltip).toBeVisible();
  });

  test("a refresh started while another tooltip control is focused leaves that control focused", async ({ page }) => {
    const { tooltip, refresh, live } = await openTooltip(page);

    // Pick a different focusable control inside the tooltip (an automation entry
    // link or the Close button) and park focus there.
    const others = tooltip.locator("button, a").filter({ hasNotText: /^Refresh now/ });
    const other = others.last();
    await expect(other).toBeVisible();
    await stampElement(other, "other-control");
    await other.focus();
    const before = await focusIdentity(page);
    expect(before.stamp).toBe("other-control");

    const announcementBefore = (await live.textContent())?.trim() ?? "";

    // Trigger the refresh programmatically so the pointer never moves focus.
    await refresh.evaluate((el) => (el as HTMLElement).click());
    await expect
      .poll(async () => (await live.textContent())?.trim() ?? "", { timeout: 20_000 })
      .not.toBe(announcementBefore);

    // Focus is still on the control the user had focused, not on Refresh now.
    const after = await focusIdentity(page);
    expect(after.stamp).toBe("other-control");
    await expect(other).toBeFocused();
    await expect(tooltip).toBeVisible();
  });
});
