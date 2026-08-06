import { expect, test, type Locator, type Page } from "@playwright/test";
import { restoreSession } from "./support/session";

const SETTINGS_PATH = "/dashboard/settings";

/**
 * Keyboard-trap coverage for the ACTIVE tooltip *while a refresh is running*.
 *
 * A refresh swaps spinners in, disables the refresh control and (on failure)
 * mounts an error alert — all of which can change the tab order mid-cycle. This
 * suite tabs and shift-tabs through the tooltip during those transitions and
 * asserts focus never escapes to the page body, the badge trigger's siblings, or
 * any control outside the tooltip.
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
    tooltipId: tooltipId!,
    tooltip,
    live: tooltip.getByTestId("adv-tooltip-status-live"),
    refresh: tooltip.getByRole("button", { name: /Refresh automation statuses now|Refreshing automation statuses|Refresh on cooldown/i }),
  };
}

/** Where is focus right now, relative to the tooltip? */
function focusReport(page: Page, tooltipId: string) {
  return page.evaluate((id) => {
    const el = document.activeElement as HTMLElement | null;
    const tooltip = document.getElementById(id);
    if (!el || el === document.body || el === document.documentElement) {
      return { inside: false, tag: el ? el.tagName : "NONE", label: "", text: "" };
    }
    return {
      inside: Boolean(tooltip && tooltip.contains(el)),
      tag: el.tagName,
      label: el.getAttribute("aria-label") ?? "",
      text: (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40),
    };
  }, tooltipId);
}

/**
 * Presses a key `count` times, recording where focus lands after every press so
 * a single escaped step can't hide behind a final passing assertion.
 */
async function tabThrough(page: Page, tooltipId: string, key: "Tab" | "Shift+Tab", count: number) {
  const trail: Array<{ inside: boolean; tag: string; label: string; text: string }> = [];
  for (let i = 0; i < count; i += 1) {
    await page.keyboard.press(key);
    trail.push(await focusReport(page, tooltipId));
  }
  return trail;
}

function describeTrail(trail: Array<{ inside: boolean; tag: string; label: string; text: string }>) {
  return trail.map((s, i) => `${i}: ${s.inside ? "in" : "OUT"} ${s.tag} ${s.label || s.text}`).join(" | ");
}

/** Kick off a refresh without waiting for it to finish. */
async function startRefresh(refresh: Locator) {
  await refresh.focus();
  await refresh.click();
}

async function waitForRefreshDone(refresh: Locator, live: Locator, previousAnnouncement: string) {
  await expect(refresh).toHaveAttribute("aria-busy", "false", { timeout: 20_000 });
  await expect
    .poll(async () => (await live.textContent())?.trim() ?? "", { timeout: 20_000 })
    .not.toBe(previousAnnouncement);
}

/** Force the next refresh to fail so the error alert changes the tab order. */
async function failNextRefresh(page: Page) {
  await page.route("**/_serverFn/**", async (route) => {
    const url = route.request().url();
    if (/status[-_]?refresh|refreshStatuses|evaluateAutomation/i.test(decodeURIComponent(url))) {
      await route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"forced failure"}' });
      return;
    }
    await route.fallback();
  });
}

test.describe("Settings · ACTIVE tooltip keyboard trap during refresh", () => {
  test.beforeEach(async ({ context, page, baseURL }) => {
    const restored = await restoreSession(context, page, baseURL!);
    test.skip(!restored, "No Supabase session available for authenticated e2e tests.");
    await page.goto(SETTINGS_PATH, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Settings" }).first()).toBeVisible();
  });

  test("Tab cycles only through tooltip controls while a refresh is in flight", async ({ page }) => {
    const { tooltip, tooltipId, refresh, live } = await openTooltip(page);
    const announcementBefore = (await live.textContent())?.trim() ?? "";

    await startRefresh(refresh);

    // Tab enough times to wrap past the last control several times over.
    const trail = await tabThrough(page, tooltipId, "Tab", 12);
    const escaped = trail.filter((s) => !s.inside);
    expect(escaped.length, `focus left the tooltip while refreshing: ${describeTrail(trail)}`).toBe(0);

    await waitForRefreshDone(refresh, live, announcementBefore);

    // Still trapped once the refresh settles.
    const afterTrail = await tabThrough(page, tooltipId, "Tab", 8);
    expect(
      afterTrail.filter((s) => !s.inside).length,
      `focus left the tooltip after refreshing: ${describeTrail(afterTrail)}`,
    ).toBe(0);
    await expect(tooltip).toBeVisible();
  });

  test("Shift+Tab wraps backwards inside the tooltip and never reaches the page body", async ({ page }) => {
    const { tooltip, tooltipId, refresh, live } = await openTooltip(page);
    const announcementBefore = (await live.textContent())?.trim() ?? "";

    await startRefresh(refresh);

    const backwards = await tabThrough(page, tooltipId, "Shift+Tab", 12);
    expect(
      backwards.filter((s) => !s.inside).length,
      `focus left the tooltip going backwards: ${describeTrail(backwards)}`,
    ).toBe(0);
    // Backwards tabbing must actually move focus (a wrap, not a dead stop).
    expect(new Set(backwards.map((s) => s.label || s.text)).size).toBeGreaterThan(1);

    // Mixed direction churn during the same refresh.
    const mixed: typeof backwards = [];
    for (let i = 0; i < 6; i += 1) {
      mixed.push(...(await tabThrough(page, tooltipId, "Tab", 1)));
      mixed.push(...(await tabThrough(page, tooltipId, "Shift+Tab", 1)));
    }
    expect(
      mixed.filter((s) => s.inside === false).length,
      `focus left the tooltip during mixed tabbing: ${describeTrail(mixed)}`,
    ).toBe(0);

    await waitForRefreshDone(refresh, live, announcementBefore);
    await expect(tooltip).toBeVisible();
    expect((await focusReport(page, tooltipId)).inside).toBe(true);
  });

  test("focus stays trapped when a failed refresh mounts the error alert mid-cycle", async ({ page }) => {
    await failNextRefresh(page);

    const { tooltip, tooltipId, refresh } = await openTooltip(page);
    await startRefresh(refresh);

    // Tab continuously across the failure transition (spinner -> error alert with
    // Retry/Dismiss appearing), sampling after every press.
    const trail: Array<{ inside: boolean; tag: string; label: string; text: string }> = [];
    for (let i = 0; i < 20; i += 1) {
      trail.push(...(await tabThrough(page, tooltipId, i % 2 === 0 ? "Tab" : "Shift+Tab", 1)));
      await page.waitForTimeout(120);
    }
    expect(
      trail.filter((s) => !s.inside).length,
      `focus left the tooltip around the failure: ${describeTrail(trail)}`,
    ).toBe(0);

    await expect(tooltip).toBeVisible();
    expect((await focusReport(page, tooltipId)).inside).toBe(true);
  });

  test("Escape is the only way out, and it returns focus to the badge trigger", async ({ page }) => {
    const { trigger, tooltip, tooltipId, refresh, live } = await openTooltip(page);
    const announcementBefore = (await live.textContent())?.trim() ?? "";

    await startRefresh(refresh);
    await tabThrough(page, tooltipId, "Tab", 4);
    expect((await focusReport(page, tooltipId)).inside).toBe(true);

    await waitForRefreshDone(refresh, live, announcementBefore);

    await page.keyboard.press("Escape");
    await expect(tooltip).toBeHidden();
    await expect(trigger).toBeFocused();
    expect((await focusReport(page, tooltipId)).tag).not.toBe("NONE");
  });
});
