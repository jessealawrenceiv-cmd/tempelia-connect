import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { restoreSession } from "./support/session";

const SETTINGS_PATH = "/dashboard/settings";

/**
 * Accessibility coverage for the ACTIVE automation status badge tooltip:
 * keyboard open/close, focus trapping, focus restoration, ARIA wiring, and
 * axe-core scans of the page with the tooltip both closed and open.
 */
async function getActiveBadge(page: Page) {
  const panel = page
    .getByRole("heading", { name: "Automations in Advanced" })
    .locator("..")
    .locator("..");
  await expect(panel).toBeVisible();
  const trigger = panel.locator('button[aria-haspopup="true"][aria-controls]').first();
  await expect(trigger).toBeVisible();
  const tooltipId = await trigger.getAttribute("aria-controls");
  expect(tooltipId, "ACTIVE badge must reference its tooltip via aria-controls").toBeTruthy();
  return { trigger, tooltip: page.locator(`#${tooltipId}`) };
}

async function scan(page: Page, include?: string) {
  const builder = new AxeBuilder({ page }).withTags([
    "wcag2a",
    "wcag2aa",
    "wcag21a",
    "wcag21aa",
  ]);
  if (include) builder.include(include);
  const results = await builder.analyze();
  return results.violations.map((v) => ({
    id: v.id,
    impact: v.impact,
    nodes: v.nodes.map((n) => n.target.join(" ")),
  }));
}

test.describe("Settings · ACTIVE tooltip accessibility", () => {
  test.beforeEach(async ({ context, page, baseURL }) => {
    const restored = await restoreSession(context, page, baseURL!);
    test.skip(!restored, "No Supabase session available for authenticated e2e tests.");
    await page.goto(SETTINGS_PATH, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Settings" }).first()).toBeVisible();
  });

  test("ACTIVE badge exposes correct ARIA wiring when closed and open", async ({ page }) => {
    const { trigger, tooltip } = await getActiveBadge(page);

    // Closed state: named, popup-capable, collapsed.
    const name = (await trigger.getAttribute("aria-label")) ?? (await trigger.innerText());
    expect(name?.trim().length ?? 0).toBeGreaterThan(0);
    await expect(trigger).toHaveAttribute("aria-haspopup", "true");

    await trigger.focus();
    await page.keyboard.press("Enter");
    await expect(tooltip).toBeVisible();
    await expect(trigger).toHaveAttribute("aria-expanded", "true");

    // The tooltip surface is a labelled dialog-like region, not an orphan div.
    const role = await tooltip.getAttribute("role");
    expect(role).toBeTruthy();
    const labelled =
      (await tooltip.getAttribute("aria-label")) ?? (await tooltip.getAttribute("aria-labelledby"));
    expect(labelled).toBeTruthy();

    await page.keyboard.press("Escape");
    await expect(tooltip).toBeHidden();
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  test("Enter, Space and ArrowDown all open the tooltip and move focus inside", async ({ page }) => {
    const { trigger, tooltip } = await getActiveBadge(page);

    for (const key of ["Enter", "Space", "ArrowDown"]) {
      await trigger.focus();
      await page.keyboard.press(key);
      await expect(tooltip, `${key} should open the tooltip`).toBeVisible();
      await expect(tooltip.locator("button").first()).toBeFocused();

      await page.keyboard.press("Escape");
      await expect(tooltip).toBeHidden();
      await expect(trigger).toBeFocused();
    }
  });

  test("focus is trapped inside the tooltip in both directions", async ({ page }) => {
    const { trigger, tooltip } = await getActiveBadge(page);

    await trigger.focus();
    await page.keyboard.press("Enter");
    await expect(tooltip).toBeVisible();

    const focusables = tooltip.locator("button");
    const count = await focusables.count();
    expect(count).toBeGreaterThan(1);

    // Forward: wraps from the last control back to the first.
    for (let i = 0; i < count + 2; i++) {
      const inside = await tooltip.evaluate(
        (el) => !!document.activeElement && el.contains(document.activeElement),
      );
      expect(inside, `focus escaped the trap after ${i} Tab presses`).toBe(true);
      await page.keyboard.press("Tab");
    }

    // Backward: Shift+Tab also stays inside.
    for (let i = 0; i < count + 2; i++) {
      await page.keyboard.press("Shift+Tab");
      const inside = await tooltip.evaluate(
        (el) => !!document.activeElement && el.contains(document.activeElement),
      );
      expect(inside, `focus escaped the trap after ${i + 1} Shift+Tab presses`).toBe(true);
    }
  });

  test("focus returns to the trigger on Escape, Close button and outside click", async ({ page }) => {
    const { trigger, tooltip } = await getActiveBadge(page);

    // 1. Escape
    await trigger.focus();
    await page.keyboard.press("Enter");
    await expect(tooltip).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(tooltip).toBeHidden();
    await expect(trigger).toBeFocused();

    // 2. The in-tooltip Close control, activated by keyboard.
    await page.keyboard.press("Enter");
    await expect(tooltip).toBeVisible();
    const close = tooltip.getByRole("button", { name: /close/i }).first();
    if (await close.count()) {
      await close.focus();
      await page.keyboard.press("Enter");
      await expect(tooltip).toBeHidden();
      await expect(trigger).toBeFocused();
    } else {
      await page.keyboard.press("Escape");
      await expect(trigger).toBeFocused();
    }

    // 3. Outside click still returns focus, since focus originated inside.
    await page.keyboard.press("Enter");
    await expect(tooltip).toBeVisible();
    await expect(tooltip.locator("button").first()).toBeFocused();
    await page.mouse.click(5, 5);
    await expect(tooltip).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test("focus never lands on <body> while the tooltip is open or closing", async ({ page }) => {
    const { trigger, tooltip } = await getActiveBadge(page);

    await trigger.focus();
    await page.keyboard.press("Enter");
    await expect(tooltip).toBeVisible();

    const refresh = tooltip.getByRole("button", { name: /Refresh automation statuses now/i });
    await refresh.focus();
    await refresh.click();
    await expect(refresh).toBeFocused();

    let active = await page.evaluate(() => document.activeElement?.tagName ?? "NONE");
    expect(active).not.toBe("BODY");

    await page.keyboard.press("Escape");
    await expect(tooltip).toBeHidden();
    active = await page.evaluate(() => document.activeElement?.tagName ?? "NONE");
    expect(active).not.toBe("BODY");
    await expect(trigger).toBeFocused();
  });

  test("axe-core reports no WCAG A/AA violations with the tooltip closed or open", async ({
    page,
  }) => {
    const { trigger, tooltip } = await getActiveBadge(page);

    expect(await scan(page), "violations with tooltip closed").toEqual([]);

    await trigger.focus();
    await page.keyboard.press("Enter");
    await expect(tooltip).toBeVisible();

    expect(await scan(page), "violations with tooltip open").toEqual([]);

    const tooltipId = await trigger.getAttribute("aria-controls");
    expect(await scan(page, `#${tooltipId}`), "violations inside the tooltip surface").toEqual([]);
  });
});
