import { expect, test, type Page } from "@playwright/test";
import { restoreSession } from "./support/session";

const SETTINGS_PATH = "/dashboard/settings";

/**
 * Motion-safety coverage for the busy indicators on Settings.
 *
 * The spinner (`motion-safe:animate-spin`), the realtime connection dot
 * (`motion-safe:animate-pulse`) and the refresh progress bar
 * (`motion-reduce:animate-none`) must all fall back to a *static* rendering
 * when the viewer prefers reduced motion — while still being visible, so the
 * busy/connection state is never communicated by animation alone.
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
  const tooltip = page.locator(`#${tooltipId}`);
  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(tooltip).toBeVisible();
  return {
    tooltip,
    refresh: tooltip.getByRole("button", { name: /Refresh automation statuses now/i }),
  };
}

/** Animation-related computed styles for the first matching element. */
function motionStyles(page: Page, testId: string) {
  return page.evaluate((id) => {
    const el = document.querySelector(`[data-testid="${id}"]`);
    if (!el) return null;
    const cs = getComputedStyle(el);
    return {
      animationName: cs.animationName,
      animationDuration: cs.animationDuration,
      animationIterationCount: cs.animationIterationCount,
      transitionDuration: cs.transitionDuration,
      display: cs.display,
      visibility: cs.visibility,
      opacity: cs.opacity,
      width: cs.width,
    };
  }, testId);
}

function isStatic(styles: { animationName: string } | null) {
  return styles !== null && styles.animationName === "none";
}

test.describe("Settings · spinner and pulse indicators honour reduced motion", () => {
  test.beforeEach(async ({ context, page, baseURL }) => {
    const restored = await restoreSession(context, page, baseURL!);
    test.skip(!restored, "No Supabase session available for authenticated e2e tests.");
  });

  test("spinner and progress bar are static while refreshing under reduced motion", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(SETTINGS_PATH, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Settings" }).first()).toBeVisible();
    expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);

    const { refresh } = await openTooltip(page);

    // Sample the indicators while the refresh is genuinely in flight.
    const sampled: Array<{ spinner: Awaited<ReturnType<typeof motionStyles>>; bar: Awaited<ReturnType<typeof motionStyles>> }> = [];
    const settle = expect(refresh).toHaveAttribute("aria-busy", "false", { timeout: 20_000 });
    await refresh.click();
    await expect(refresh).toHaveAttribute("aria-busy", "true", { timeout: 10_000 }).catch(() => {});
    for (let i = 0; i < 6; i += 1) {
      const spinner = await motionStyles(page, "motion-spinner");
      const bar = await motionStyles(page, "refresh-now-progress-bar");
      if (spinner || bar) sampled.push({ spinner, bar });
      if ((await refresh.getAttribute("aria-busy")) === "false") break;
      await page.waitForTimeout(120);
    }
    await settle;

    const spinnerSamples = sampled.map((s) => s.spinner).filter(Boolean);
    const barSamples = sampled.map((s) => s.bar).filter(Boolean);
    expect(barSamples.length, "progress bar never rendered").toBeGreaterThan(0);

    // No spinning, no sweeping — every sample must be animation-free.
    for (const s of spinnerSamples) expect(isStatic(s), `spinner animated: ${s?.animationName}`).toBe(true);
    for (const b of barSamples) expect(isStatic(b), `progress bar animated: ${b?.animationName}`).toBe(true);

    // The static fallback still fills the track, so progress stays visible.
    const track = await motionStyles(page, "refresh-now-progress");
    const barWidth = parseFloat(barSamples[0]!.width);
    const trackWidth = parseFloat(track!.width);
    expect(barWidth).toBeGreaterThan(trackWidth * 0.9);
    expect(barSamples[0]!.visibility).toBe("visible");
  });

  test("the realtime connection dot never pulses under reduced motion", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(SETTINGS_PATH, { waitUntil: "domcontentloaded" });

    const dot = page.getByTestId("realtime-indicator-dot").first();
    await expect(dot).toBeVisible();

    // Poll across connection state transitions (connecting → live/reconnecting):
    // the pulse class is state-dependent, so check each state we observe.
    const seen = new Set<string>();
    for (let i = 0; i < 12; i += 1) {
      const state = (await dot.getAttribute("data-realtime-state")) ?? "unknown";
      seen.add(state);
      const styles = await motionStyles(page, "realtime-indicator-dot");
      expect(isStatic(styles), `dot pulsed in state "${state}": ${styles?.animationName}`).toBe(true);
      // Colour/opacity still convey the state, not motion.
      expect(styles!.visibility).toBe("visible");
      await page.waitForTimeout(200);
    }
    expect(seen.size).toBeGreaterThan(0);
  });

  test("without reduced motion the same indicators do animate (control)", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.goto(SETTINGS_PATH, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Settings" }).first()).toBeVisible();

    const { refresh } = await openTooltip(page);

    let sawAnimatedBar = false;
    let sawAnimatedSpinner = false;
    const settle = expect(refresh).toHaveAttribute("aria-busy", "false", { timeout: 20_000 });
    await refresh.click();
    for (let i = 0; i < 8; i += 1) {
      const bar = await motionStyles(page, "refresh-now-progress-bar");
      const spinner = await motionStyles(page, "motion-spinner");
      if (bar && bar.animationName !== "none") sawAnimatedBar = true;
      if (spinner && spinner.animationName !== "none") sawAnimatedSpinner = true;
      if (sawAnimatedBar && sawAnimatedSpinner) break;
      if ((await refresh.getAttribute("aria-busy")) === "false" && i > 2) break;
      await page.waitForTimeout(100);
    }
    await settle;

    // Proves the reduced-motion assertions above are meaningful, not vacuous.
    expect(sawAnimatedBar || sawAnimatedSpinner, "no motion-safe animation observed at all").toBe(true);
  });
});
