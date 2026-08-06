import { expect, test, type Locator, type Page } from "@playwright/test";
import { restoreSession } from "./support/session";

const SETTINGS_PATH = "/dashboard/settings";

/**
 * Reduced motion must not degrade the ACTIVE tooltip's polite announcements.
 *
 * With animations suppressed there is no visual motion cue at all, so the live
 * region is the *only* channel telling a screen-reader (or motion-sensitive)
 * user that a refresh completed and what the automation status now is. These
 * tests assert the region keeps re-announcing accurately — same node, correct
 * status text, correct outcome, fresh timestamp — on every repeat refresh.
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
    refresh: tooltip.getByRole("button", { name: /Refresh automation statuses now/i }),
  };
}

/** Record every distinct text the live region ever holds. */
async function beginAnnouncementLog(live: Locator) {
  await live.evaluate((el) => {
    const w = window as unknown as { __ann?: string[]; __annObs?: MutationObserver };
    w.__ann = [(el.textContent ?? "").trim()].filter(Boolean);
    w.__annObs?.disconnect();
    const obs = new MutationObserver(() => {
      const text = (el.textContent ?? "").trim();
      if (text && w.__ann![w.__ann!.length - 1] !== text) w.__ann!.push(text);
    });
    obs.observe(el, { childList: true, characterData: true, subtree: true });
    w.__annObs = obs;
  });
}

function announcements(page: Page) {
  return page.evaluate(() => (window as unknown as { __ann?: string[] }).__ann ?? []);
}

function focusSignature(page: Page) {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return "NONE";
    return [el.tagName, el.getAttribute("data-testid") ?? "", el.getAttribute("aria-label") ?? ""].join("|");
  });
}

async function refreshAndAwaitAnnouncement(refresh: Locator, live: Locator, previous: string) {
  await refresh.click();
  await expect(refresh).toHaveAttribute("aria-busy", "false", { timeout: 20_000 });
  await expect
    .poll(async () => (await live.textContent())?.trim() ?? "", {
      message: "live region should re-announce after a reduced-motion refresh",
      timeout: 20_000,
    })
    .not.toBe(previous);
  return (await live.textContent())?.trim() ?? "";
}

test.describe("Settings · ACTIVE tooltip live region under reduced motion", () => {
  test.beforeEach(async ({ context, page, baseURL }) => {
    const restored = await restoreSession(context, page, baseURL!);
    test.skip(!restored, "No Supabase session available for authenticated e2e tests.");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(SETTINGS_PATH, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Settings" }).first()).toBeVisible();
    expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);
  });

  test("region keeps its polite/atomic contract with motion disabled", async ({ page }) => {
    const { live } = await openTooltip(page);

    await expect(live).toHaveAttribute("aria-live", "polite");
    await expect(live).toHaveAttribute("aria-atomic", "true");
    await expect(live).toHaveAttribute("role", "status");
    expect(await live.getAttribute("tabindex")).toBeNull();
    expect(
      await live.evaluate((el) => el.querySelectorAll("a,button,input,select,textarea,[tabindex]").length),
      "live region must contain no focusable children",
    ).toBe(0);

    // Motion suppression must not hide the region from assistive tech.
    const styles = await live.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { display: cs.display, visibility: cs.visibility, animationName: cs.animationName };
    });
    expect(styles.display).not.toBe("none");
    expect(styles.visibility).not.toBe("hidden");
    expect(await live.getAttribute("aria-hidden")).toBeNull();
  });

  test("three consecutive refreshes each re-announce accurate status and time", async ({ page }) => {
    const { tooltip, live, refresh } = await openTooltip(page);
    await beginAnnouncementLog(live);

    await refresh.focus();
    const focusBefore = await focusSignature(page);
    let previous = (await live.textContent())?.trim() ?? "";

    for (let pass = 1; pass <= 3; pass += 1) {
      const next = await refreshAndAwaitAnnouncement(refresh, live, previous);

      // Accurate content: automation named, outcome stated, time present.
      expect(next, `pass ${pass}: must name the automation and its status`).toMatch(
        /Opt-in prompt & cooldown (ACTIVE|ON HOLD)/i,
      );
      expect(next, `pass ${pass}: must state the refresh outcome`).toMatch(
        /Statuses (updated|already current)|Refresh failed/i,
      );
      expect(next, `pass ${pass}: must carry a re-check time`).toMatch(/\d{1,2}:\d{2}/);
      // Never a false claim of change plus a failure in the same breath.
      expect(next, `pass ${pass}: contradictory announcement`).not.toMatch(
        /Statuses updated[\s\S]*Refresh failed|Refresh failed[\s\S]*Statuses updated/i,
      );

      // Announcement channel is the tooltip's own region; focus is untouched.
      expect(await focusSignature(page), `pass ${pass}: focus moved`).toBe(focusBefore);
      await expect(refresh).toBeFocused();
      await expect(tooltip).toBeVisible();

      previous = next;
    }

    // Each refresh produced a genuinely new announcement (no silent repeats,
    // which a screen reader would not read out).
    const log = await announcements(page);
    expect(log.length, `expected 3 fresh announcements, got: ${JSON.stringify(log)}`).toBeGreaterThanOrEqual(4);
    for (let i = 1; i < log.length; i += 1) {
      expect(log[i], "consecutive announcements must differ").not.toBe(log[i - 1]);
    }
  });

  test("the live region node itself is never replaced across refreshes", async ({ page }) => {
    const { live, refresh } = await openTooltip(page);

    await live.evaluate((el) => {
      (window as unknown as { __liveNode?: Element }).__liveNode = el;
    });

    let previous = (await live.textContent())?.trim() ?? "";
    for (let pass = 1; pass <= 2; pass += 1) {
      previous = await refreshAndAwaitAnnouncement(refresh, live, previous);
      expect(
        await live.evaluate(
          (el) => el === (window as unknown as { __liveNode?: Element }).__liveNode && el.isConnected,
        ),
        `live region was re-created on pass ${pass} — a fresh region announces nothing`,
      ).toBe(true);
    }
  });

  test("announcement still reflects the real status after a failed refresh", async ({ page }) => {
    const { live, refresh, tooltip } = await openTooltip(page);

    // First, a healthy refresh to capture the truthful baseline status.
    let previous = (await live.textContent())?.trim() ?? "";
    previous = await refreshAndAwaitAnnouncement(refresh, live, previous);
    const baselineStatus = /ON HOLD/i.test(previous) ? "ON HOLD" : "ACTIVE";

    // Now force the server call to fail.
    await page.route("**/_serverFn/**", (route) =>
      /status-refresh|statusRefresh/i.test(route.request().url())
        ? route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"boom"}' })
        : route.fallback(),
    );

    await refresh.click();
    await expect(refresh).toHaveAttribute("aria-busy", "false", { timeout: 20_000 });
    const after = await expect
      .poll(async () => (await live.textContent())?.trim() ?? "", { timeout: 20_000 })
      .not.toBe(previous)
      .then(async () => (await live.textContent())?.trim() ?? "");

    // Honest failure messaging, and the status shown is still the real one —
    // never invented, never silently flipped.
    expect(after).toMatch(/Refresh failed|Statuses already current/i);
    expect(after).not.toMatch(/Statuses updated/i);
    expect(after, "status must not be fabricated after a failure").toMatch(
      new RegExp(`Opt-in prompt & cooldown ${baselineStatus}`, "i"),
    );
    await expect(tooltip).toBeVisible();
    await expect(refresh).toBeFocused();
  });
});
