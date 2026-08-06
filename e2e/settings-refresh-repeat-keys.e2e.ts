import { expect, test, type Page } from "@playwright/test";
import { restoreSession } from "./support/session";

const SETTINGS_PATH = "/dashboard/settings";

/**
 * Keyboard hammering coverage: with focus parked on "Refresh now" inside the
 * ACTIVE tooltip, repeatedly pressing Enter and Space — including while a
 * refresh is still in flight and while the escalating cooldown is active —
 * must never move focus off that button, never close the tooltip, and never
 * scroll the page (Space must stay swallowed by the control).
 *
 * The button uses aria-disabled (not the disabled attribute) precisely so it
 * stays focusable while busy; this test is the regression guard for that.
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
    refresh: tooltip.getByRole("button", { name: /Refresh(ing)? automation statuses|Refresh on cooldown/i }).first(),
  };
}

/** Stamp an element so we can recognise the exact same node later. */
async function stamp(locator: ReturnType<Page["locator"]>, value: string) {
  await locator.evaluate((el, v) => el.setAttribute("data-focus-stamp", v), value);
}

/** Start sampling document.activeElement every 20ms plus on every focus event. */
async function startFocusSampler(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __samples?: string[]; __timer?: number; __scroll?: number };
    w.__samples = [];
    w.__scroll = window.scrollY;
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
}

async function stopFocusSampler(page: Page) {
  return page.evaluate(() => {
    const w = window as unknown as { __samples?: string[]; __timer?: number; __scroll?: number };
    if (w.__timer) window.clearInterval(w.__timer);
    return {
      samples: w.__samples ?? [],
      scrollBefore: w.__scroll ?? 0,
      scrollAfter: window.scrollY,
    };
  });
}

function assertFocusPinned(samples: string[], stampValue: string) {
  const escaped = samples.filter((s) => s === "NONE" || s.startsWith("BODY") || s.startsWith("HTML"));
  expect(escaped, `focus fell to the document: ${escaped.join(", ")}`).toEqual([]);
  const foreign = samples.filter((s) => !s.includes(stampValue));
  expect(foreign, `focus moved off the refresh button: ${foreign.join(", ")}`).toEqual([]);
  expect(samples.length).toBeGreaterThan(3);
}

test.describe("Settings · repeated Enter/Space on Refresh now keeps focus pinned", () => {
  test.beforeEach(async ({ context, page, baseURL }) => {
    const restored = await restoreSession(context, page, baseURL!);
    test.skip(!restored, "No Supabase session available for authenticated e2e tests.");
    await page.goto(SETTINGS_PATH, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Settings" }).first()).toBeVisible();
  });

  test("hammering Enter then Space never moves focus away from the button", async ({ page }) => {
    const { tooltip, refresh, live } = await openTooltip(page);

    await stamp(refresh, "repeat-refresh");
    await refresh.focus();
    await expect(refresh).toBeFocused();

    const announcementBefore = (await live.textContent())?.trim() ?? "";

    await startFocusSampler(page);

    // 8 rapid activations alternating Enter/Space. Most land while the first
    // refresh is still running (or during cooldown) and must be swallowed.
    for (let i = 0; i < 8; i += 1) {
      await page.keyboard.press(i % 2 === 0 ? "Enter" : "Space");
      await page.waitForTimeout(60);
    }

    // Let the in-flight refresh settle, still hammering keys while it does.
    await expect
      .poll(async () => (await live.textContent())?.trim() ?? "", { timeout: 20_000 })
      .not.toBe(announcementBefore);
    for (let i = 0; i < 4; i += 1) {
      await page.keyboard.press(i % 2 === 0 ? "Space" : "Enter");
      await page.waitForTimeout(40);
    }
    await expect(refresh).toHaveAttribute("aria-busy", "false", { timeout: 20_000 });

    const { samples, scrollBefore, scrollAfter } = await stopFocusSampler(page);

    assertFocusPinned(samples, "repeat-refresh");
    // Space must not have scrolled the page out from under the tooltip.
    expect(scrollAfter).toBe(scrollBefore);

    // Same live node, tooltip still open, focus still inside it.
    await expect(refresh).toBeFocused();
    expect(await refresh.evaluate((el) => el.getAttribute("data-focus-stamp"))).toBe("repeat-refresh");
    await expect(tooltip).toBeVisible();
    expect(await tooltip.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  });

  test("repeat presses while busy or on cooldown do not queue extra refreshes", async ({ page }) => {
    const { refresh, live } = await openTooltip(page);

    await stamp(refresh, "no-queue-refresh");
    await refresh.focus();

    // Count distinct live-region announcements: each completed refresh appends a
    // new "(update N)" suffix, so N tells us how many actually ran.
    const readUpdateIndex = async () => {
      const text = (await live.textContent())?.trim() ?? "";
      const m = text.match(/\(update (\d+)\)/);
      return m ? Number(m[1]) : 0;
    };
    const before = await readUpdateIndex();

    for (let i = 0; i < 6; i += 1) {
      await page.keyboard.press(i % 2 === 0 ? "Enter" : "Space");
      await page.waitForTimeout(30);
    }
    await expect(refresh).toHaveAttribute("aria-busy", "false", { timeout: 20_000 });
    await page.waitForTimeout(1_000);

    const after = await readUpdateIndex();
    expect(after - before, "extra refreshes were queued by repeat key presses").toBeLessThanOrEqual(1);
    await expect(refresh).toBeFocused();
  });

  test("focus stays pinned under reduced-motion emulation", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Settings" }).first()).toBeVisible();

    const { tooltip, refresh, live } = await openTooltip(page);
    await stamp(refresh, "reduced-motion-refresh");
    await refresh.focus();
    await expect(refresh).toBeFocused();

    const announcementBefore = (await live.textContent())?.trim() ?? "";
    await startFocusSampler(page);

    for (let i = 0; i < 6; i += 1) {
      await page.keyboard.press(i % 2 === 0 ? "Enter" : "Space");
      await page.waitForTimeout(40);
    }
    await expect
      .poll(async () => (await live.textContent())?.trim() ?? "", { timeout: 20_000 })
      .not.toBe(announcementBefore);
    await expect(refresh).toHaveAttribute("aria-busy", "false", { timeout: 20_000 });

    const { samples } = await stopFocusSampler(page);
    assertFocusPinned(samples, "reduced-motion-refresh");
    await expect(refresh).toBeFocused();
    await expect(tooltip).toBeVisible();
  });
});
