import { expect, test, type Page } from "@playwright/test";
import { restoreSession } from "./support/session";

const SETTINGS_PATH = "/dashboard/settings";
// The status-refresh server function is addressed by a base64 id that always
// contains the source file name; failing it forces the refresh error state.
const STATUS_REFRESH_FN = "c3RhdHVzLXJlZnJlc2g";

/**
 * Failure-path focus coverage for the ACTIVE tooltip: after a failed refresh
 * the Retry button receives focus, and clicking Retry must keep focus pinned to
 * that same button for the whole in-flight retry — never dropping to <body>,
 * never jumping to another control, and back on Retry once it fails again.
 */
async function failStatusRefresh(page: Page) {
  await page.route("**/_serverFn/**", async (route) => {
    if (route.request().url().includes(STATUS_REFRESH_FN)) {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ message: "Simulated refresh failure" }),
      });
      return;
    }
    await route.fallback();
  });
}

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
    refresh: tooltip.getByRole("button", { name: /Refresh automation statuses/i }),
    retry: tooltip.locator("button", { hasText: /^(Retry|Retrying)/ }).first(),
  };
}

/** Identity of the focused element, stable across re-renders. */
function focusInfo(page: Page) {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return { tag: "NONE", label: "", text: "" };
    return {
      tag: el.tagName,
      label: el.getAttribute("aria-label") ?? "",
      text: (el.textContent ?? "").trim().slice(0, 24),
    };
  });
}

/**
 * Samples document.activeElement continuously in the page while `action` runs,
 * so a momentary focus drop cannot slip between Playwright assertions.
 */
async function recordFocusDuring(page: Page, action: () => Promise<void>) {
  await page.evaluate(() => {
    const w = window as unknown as { __focusSamples?: string[]; __focusTimer?: number };
    w.__focusSamples = [];
    const sample = () => {
      const el = document.activeElement as HTMLElement | null;
      w.__focusSamples!.push(
        el ? `${el.tagName}|${el.getAttribute("aria-label") ?? ""}|${(el.textContent ?? "").trim().slice(0, 16)}` : "NONE",
      );
    };
    sample();
    w.__focusTimer = window.setInterval(sample, 20);
    document.addEventListener("focusout", sample, true);
    document.addEventListener("focusin", sample, true);
  });

  await action();

  return page.evaluate(() => {
    const w = window as unknown as { __focusSamples?: string[]; __focusTimer?: number };
    if (w.__focusTimer) window.clearInterval(w.__focusTimer);
    return w.__focusSamples ?? [];
  });
}

test.describe("Settings · Retry focus after a failed refresh", () => {
  test.beforeEach(async ({ context, page, baseURL }) => {
    const restored = await restoreSession(context, page, baseURL!);
    test.skip(!restored, "No Supabase session available for authenticated e2e tests.");
    await failStatusRefresh(page);
    await page.goto(SETTINGS_PATH, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Settings" }).first()).toBeVisible();
  });

  test("clicking Retry keeps focus pinned to the Retry button throughout", async ({ page }) => {
    const { tooltip, refresh, retry } = await openTooltip(page);

    // 1. Provoke the failure from Refresh now.
    await refresh.focus();
    await refresh.click();

    // 2. The error surfaces and focus lands on Retry automatically.
    await expect(tooltip.getByText(/Couldn’t refresh statuses/i)).toBeVisible();
    await expect(retry).toBeVisible();
    await expect(retry).toBeFocused();
    const before = await focusInfo(page);

    // 3. Click Retry and sample focus for the entire in-flight retry.
    const samples = await recordFocusDuring(page, async () => {
      await retry.click();
      // In-flight: aria-busy and the "Retrying…" label, still focused.
      await expect(retry).toHaveAttribute("aria-busy", "true");
      await expect(retry).toBeFocused();
      // The retry fails again and the button returns to its idle label.
      await expect(retry).toHaveAttribute("aria-busy", "false");
      await expect(tooltip.getByText(/Couldn’t refresh statuses/i)).toBeVisible();
    });

    // No sample may show focus on <body> or nothing.
    const escaped = samples.filter((s) => s.startsWith("BODY") || s === "NONE" || s.startsWith("HTML"));
    expect(escaped, `focus left the Retry button during the retry: ${escaped.join(", ")}`).toEqual([]);

    // Every sample is the Retry button itself (idle or retrying label).
    const foreign = samples.filter((s) => !/Retry/i.test(s));
    expect(foreign, `focus moved to another control: ${foreign.join(", ")}`).toEqual([]);

    // 4. Focus ends on Retry, same control as before the click.
    await expect(retry).toBeFocused();
    const after = await focusInfo(page);
    expect(after.tag).toBe(before.tag);
    expect(after.label).toMatch(/Retry/i);

    // 5. Repeated Retry clicks stay pinned too.
    await retry.click();
    await expect(retry).toBeFocused();
    await expect(retry).toHaveAttribute("aria-busy", "false");
    await expect(retry).toBeFocused();

    // 6. Keyboard activation behaves the same way.
    await page.keyboard.press("Enter");
    await expect(retry).toBeFocused();
    await expect(retry).toHaveAttribute("aria-busy", "false");
    await expect(retry).toBeFocused();

    // The tooltip never closed, and focus is still inside it.
    await expect(tooltip).toBeVisible();
    expect(
      await tooltip.evaluate((el) => !!document.activeElement && el.contains(document.activeElement)),
    ).toBe(true);
  });

  test("Retry stays focused and the failure is re-announced on each attempt", async ({ page }) => {
    const { tooltip, refresh, retry } = await openTooltip(page);

    await refresh.focus();
    await refresh.click();
    await expect(retry).toBeFocused();

    const live = tooltip.getByTestId("adv-tooltip-status-live");
    let announcement = (await live.textContent())?.trim() ?? "";

    for (const pass of [1, 2]) {
      await retry.click();
      await expect
        .poll(async () => (await live.textContent())?.trim() ?? "", { timeout: 20_000 })
        .not.toBe(announcement);
      announcement = (await live.textContent())?.trim() ?? "";
      expect(announcement, `pass ${pass}`).toMatch(/Refresh failed/i);
      // The live region announces without taking focus off Retry.
      await expect(live).not.toBeFocused();
      await expect(retry, `pass ${pass}: Retry lost focus`).toBeFocused();
    }

    // Attempt counter is surfaced, and Retry is still the focused control.
    await expect(tooltip.getByText(/failed attempts in a row/i)).toBeVisible();
    await expect(retry).toBeFocused();
  });
});
