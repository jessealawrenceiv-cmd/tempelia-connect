import { test, expect, type Locator, type Page } from "@playwright/test";
import { restoreSession } from "./support/session";

/**
 * Visual regression: ACTIVE badge + status tooltip styling.
 *
 * The tooltip carries popover surface, border, shadow and the small status dot.
 * Those are all token-driven, so a theme edit can quietly make the panel
 * unreadable (paper text on paper background) or clip it off-screen on a phone.
 * Baselines are captured in both themes and at a 390px width.
 *
 * Refresh baselines intentionally with:
 *   bunx playwright test e2e/visual-active-tooltip.e2e.ts --update-snapshots
 */

const SETTINGS_PATH = "/dashboard/settings";

async function setTheme(page: Page, theme: "charcoal" | "paper") {
  await page.evaluate((t) => {
    const root = document.documentElement;
    root.classList.remove("dark");
    root.removeAttribute("data-theme");
    if (t === "paper") root.setAttribute("data-theme", "light");
  }, theme);
}

async function freezeMotion(page: Page) {
  await page.addStyleTag({
    content: `*, *::before, *::after { animation: none !important; transition: none !important; }`,
  });
}

/** The ACTIVE badge trigger inside the "Automations in Advanced" panel. */
async function activeBadge(page: Page) {
  const panel = page
    .getByRole("heading", { name: "Automations in Advanced" })
    .locator("..")
    .locator("..");
  await expect(panel).toBeVisible();
  const trigger = panel.locator('button[aria-haspopup="true"][aria-controls]').first();
  await expect(trigger).toBeVisible();
  return trigger;
}

/**
 * The badge opens its tooltip on focus/Enter (it is a hover+keyboard popover,
 * not a click toggle), so drive it the same way a keyboard user would.
 */
async function openTooltip(page: Page, trigger: Locator) {
  const tooltipId = await trigger.getAttribute("aria-controls");
  await trigger.hover();
  await trigger.focus();
  await page.keyboard.press("Enter");
  const tooltip = page.locator(`#${tooltipId}`);
  await expect(tooltip).toBeVisible();
  return tooltip;
}

const themes = [
  { name: "charcoal", label: "dark" },
  { name: "paper", label: "light" },
] as const;

test.describe("Visual · ACTIVE badge and status tooltip", () => {
  test.beforeEach(async ({ context, page, baseURL }) => {
    const restored = await restoreSession(context, page, baseURL!);
    test.skip(!restored, "No session available for authenticated visual tests.");
    await page.goto(SETTINGS_PATH, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Settings" }).first()).toBeVisible();
    await freezeMotion(page);
  });

  for (const theme of themes) {
    test(`badge — desktop ${theme.label}`, async ({ page }) => {
      const trigger = await activeBadge(page);
      await setTheme(page, theme.name);
      await expect(trigger).toHaveScreenshot(`badge-desktop-${theme.label}.png`);
    });

    test(`tooltip — desktop ${theme.label}`, async ({ page }) => {
      const trigger = await activeBadge(page);
      await setTheme(page, theme.name);
      const tooltip = await openTooltip(page, trigger);
      await freezeMotion(page);
      await expect(tooltip).toHaveScreenshot(`tooltip-desktop-${theme.label}.png`);
    });

    test(`tooltip — mobile ${theme.label}`, async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 900 });
      const trigger = await activeBadge(page);
      await setTheme(page, theme.name);
      const tooltip = await openTooltip(page, trigger);
      await freezeMotion(page);
      await expect(tooltip).toHaveScreenshot(`tooltip-mobile-${theme.label}.png`);

      // The panel must stay inside the viewport on a phone.
      const box = await tooltip.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(-1);
      expect(box!.x + box!.width).toBeLessThanOrEqual(391);
    });

    test(`tooltip surface contrasts with its text — ${theme.label}`, async ({ page }) => {
      const trigger = await activeBadge(page);
      await setTheme(page, theme.name);
      const tooltip = await openTooltip(page, trigger);

      const { bg, fg } = await tooltip.evaluate((el) => {
        const s = getComputedStyle(el);
        return { bg: s.backgroundColor, fg: s.color };
      });
      expect(bg).not.toBe("rgba(0, 0, 0, 0)");
      // Same-color text on background is the classic broken-token symptom.
      expect(bg).not.toBe(fg);
    });
  }
});
