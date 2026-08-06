import { expect, test, type Locator, type Page } from "@playwright/test";
import { restoreSession } from "./support/session";

const SETTINGS_PATH = "/dashboard/settings";

/**
 * Regression coverage for tooltip *container identity*: repeatedly refreshing
 * automation statuses must update the tooltip's contents in place. The tooltip
 * element itself must never be unmounted and re-created, because a replacement
 * silently breaks focus trapping, aria-live announcements (a fresh live region
 * re-announces nothing) and any open-state the user relies on.
 *
 * Identity is proven three ways:
 *  - a unique attribute stamped on the container before the refreshes (lost on remount),
 *  - a JS handle compared with `===` after each refresh,
 *  - a MutationObserver on the container's parent recording childList churn.
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

/** Stamp the container and start watching its parent for child replacement. */
async function beginIdentityWatch(tooltip: Locator, stamp: string) {
  await tooltip.evaluate((el, value) => {
    el.setAttribute("data-identity-stamp", value);
    const w = window as unknown as {
      __tooltipNode?: Element;
      __tooltipMutations?: string[];
      __tooltipObserver?: MutationObserver;
    };
    w.__tooltipNode = el;
    w.__tooltipMutations = [];
    w.__tooltipObserver?.disconnect();
    const observer = new MutationObserver((records) => {
      for (const r of records) {
        for (const removed of Array.from(r.removedNodes)) {
          if (removed === el) w.__tooltipMutations!.push("tooltip-removed");
        }
        for (const added of Array.from(r.addedNodes)) {
          if (added !== el && added instanceof Element && added.id === el.id) {
            w.__tooltipMutations!.push("tooltip-replaced");
          }
        }
      }
    });
    if (el.parentElement) observer.observe(el.parentElement, { childList: true });
    w.__tooltipObserver = observer;
  }, stamp);
}

/** Is the live DOM node still the exact element we stamped? */
function isSameNode(tooltip: Locator) {
  return tooltip.evaluate((el) => {
    const w = window as unknown as { __tooltipNode?: Element };
    return el === w.__tooltipNode && el.isConnected;
  });
}

function identityMutations(page: Page) {
  return page.evaluate(() => {
    const w = window as unknown as { __tooltipMutations?: string[] };
    return w.__tooltipMutations ?? [];
  });
}

/** Click Refresh now and wait for a genuine completed refresh cycle. */
async function refreshOnce(refresh: Locator, live: Locator) {
  const announcementBefore = (await live.textContent())?.trim() ?? "";
  await refresh.click();
  await expect(refresh).toHaveAttribute("aria-busy", "false", { timeout: 20_000 });
  await expect
    .poll(async () => (await live.textContent())?.trim() ?? "", { timeout: 20_000 })
    .not.toBe(announcementBefore);
}

test.describe("Settings · ACTIVE tooltip container survives repeated refreshes", () => {
  test.beforeEach(async ({ context, page, baseURL }) => {
    const restored = await restoreSession(context, page, baseURL!);
    test.skip(!restored, "No Supabase session available for authenticated e2e tests.");
    await page.goto(SETTINGS_PATH, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Settings" }).first()).toBeVisible();
  });

  test("the tooltip element is the same node across three consecutive refreshes", async ({ page }) => {
    const { tooltip, tooltipId, refresh, live } = await openTooltip(page);
    await beginIdentityWatch(tooltip, "tooltip-container");

    for (let round = 1; round <= 3; round += 1) {
      await refreshOnce(refresh, live);

      // Same container, same id, still open, contents updated in place.
      expect(await isSameNode(tooltip), `tooltip node was replaced on refresh ${round}`).toBe(true);
      await expect(tooltip).toHaveAttribute("data-identity-stamp", "tooltip-container");
      await expect(tooltip).toHaveAttribute("id", tooltipId);
      await expect(tooltip).toBeVisible();

      // The live region inside it is also the same node, otherwise the polite
      // announcement would be re-created and never read out.
      expect(
        await live.evaluate((el) => {
          const w = window as unknown as { __liveNode?: Element };
          const first = !w.__liveNode;
          const same = first || el === w.__liveNode;
          w.__liveNode = el;
          return same && el.isConnected;
        }),
        `tooltip live region was replaced on refresh ${round}`,
      ).toBe(true);
    }

    expect(await identityMutations(page), "tooltip container was unmounted/re-created").toEqual([]);
    // Only one element ever carries that id — no duplicate/shadow container.
    expect(await page.locator(`#${tooltipId}`).count()).toBe(1);
  });

  test("rapid back-to-back refreshes still reuse the same tooltip container", async ({ page }) => {
    const { tooltip, refresh, live } = await openTooltip(page);
    await beginIdentityWatch(tooltip, "rapid-container");

    // Fire several clicks without waiting between them; in-flight refreshes are
    // coalesced server-side, but the container must not churn either way.
    for (let i = 0; i < 5; i += 1) {
      await refresh.click({ force: true });
      await page.waitForTimeout(60);
    }
    await expect(refresh).toHaveAttribute("aria-busy", "false", { timeout: 20_000 });
    await expect.poll(async () => ((await live.textContent())?.trim() ?? "").length, { timeout: 20_000 }).toBeGreaterThan(0);

    expect(await isSameNode(tooltip)).toBe(true);
    await expect(tooltip).toHaveAttribute("data-identity-stamp", "rapid-container");
    await expect(tooltip).toBeVisible();
    expect(await identityMutations(page)).toEqual([]);
  });

  test("container identity holds under reduced motion too", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.reload({ waitUntil: "domcontentloaded" });

    const { tooltip, refresh, live } = await openTooltip(page);
    await beginIdentityWatch(tooltip, "reduced-motion-container");

    await refreshOnce(refresh, live);
    await refreshOnce(refresh, live);

    expect(await isSameNode(tooltip)).toBe(true);
    await expect(tooltip).toHaveAttribute("data-identity-stamp", "reduced-motion-container");
    await expect(tooltip).toBeVisible();
    expect(await identityMutations(page)).toEqual([]);
  });
});
