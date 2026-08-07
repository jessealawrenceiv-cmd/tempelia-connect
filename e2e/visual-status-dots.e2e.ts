import { test, expect, type Page } from "@playwright/test";

/**
 * Visual regression: status dot colors.
 *
 * The dispatch-log dots are the app's core status vocabulary (violet = action
 * taken, moss = success, steel = informational, muted = neutral). A token rename
 * or a stray `text-*`/`bg-*` swap silently turns them all one color, which no
 * functional test would catch. These tests pin:
 *   1. pixel baselines of the dot cluster in both themes and at a mobile width
 *   2. the resolved background colors, so a broken token fails loudly with a
 *      readable message instead of only a pixel diff
 *
 * Runs against the public landing page, so no session is required.
 *
 * Baselines live in e2e/__screenshots__/. Refresh them intentionally with:
 *   bunx playwright test e2e/visual-status-dots.e2e.ts --update-snapshots
 */

/** Applies the paper (light) variant the way the app's CSS defines it. */
async function setTheme(page: Page, theme: "charcoal" | "paper") {
  await page.evaluate((t) => {
    const root = document.documentElement;
    root.classList.remove("dark");
    root.removeAttribute("data-theme");
    if (t === "paper") root.setAttribute("data-theme", "light");
  }, theme);
}

/** Freezes pulse animations so screenshots are deterministic. */
async function freezeMotion(page: Page) {
  await page.addStyleTag({
    content: `*, *::before, *::after { animation: none !important; transition: none !important; }`,
  });
}

/** The "Dispatch log · live" panel on the landing page holds the dot cluster. */
function dispatchPanel(page: Page) {
  return page.locator("div.panel", { hasText: "Dispatch log" }).first();
}

async function gotoLanding(page: Page) {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const panel = dispatchPanel(page);
  await expect(panel).toBeVisible();
  await freezeMotion(page);
  return panel;
}

const themes = [
  { name: "charcoal", label: "dark" },
  { name: "paper", label: "light" },
] as const;

test.describe("Visual · status dot colors", () => {
  for (const theme of themes) {
    test(`dispatch log dots — desktop ${theme.label}`, async ({ page }) => {
      const panel = await gotoLanding(page);
      await setTheme(page, theme.name);
      await expect(panel).toHaveScreenshot(`dots-desktop-${theme.label}.png`);
    });

    test(`dispatch log dots — mobile ${theme.label}`, async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 900 });
      const panel = await gotoLanding(page);
      await setTheme(page, theme.name);
      await expect(panel).toHaveScreenshot(`dots-mobile-${theme.label}.png`);
    });

    test(`dot colors stay distinct and opaque — ${theme.label}`, async ({ page }) => {
      const panel = await gotoLanding(page);
      await setTheme(page, theme.name);

      const dots = panel.locator("span.rounded-full");
      const count = await dots.count();
      expect(count).toBeGreaterThan(1);

      const colors: string[] = [];
      for (let i = 0; i < count; i++) {
        const color = await dots
          .nth(i)
          .evaluate((el) => getComputedStyle(el).backgroundColor);
        // A dot with no fill means the color token stopped resolving.
        expect(color, `dot ${i} has no background color`).not.toBe("rgba(0, 0, 0, 0)");
        expect(color).not.toBe("transparent");
        colors.push(color);
      }
      // Status meaning depends on the dots not collapsing into one color.
      expect(new Set(colors).size).toBeGreaterThan(1);
    });
  }

  test("dots keep their size at mobile width", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 900 });
    const panel = await gotoLanding(page);
    const dot = panel.locator("span.rounded-full").last();
    const box = await dot.boundingBox();
    expect(box).not.toBeNull();
    // 0.5rem dots; a layout regression that squashes them shows up here.
    expect(box!.width).toBeGreaterThanOrEqual(6);
    expect(box!.width).toBeLessThanOrEqual(12);
    expect(Math.abs(box!.width - box!.height)).toBeLessThanOrEqual(1);
  });
});
