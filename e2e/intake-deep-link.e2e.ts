import { expect, test } from "@playwright/test";
import { restoreSession } from "./support/session";

/**
 * Home → Intakes deep link.
 *
 * Clicks a "New request" item in Home · Needs your attention and asserts the
 * Intakes page scrolls to, highlights, expands, and focuses the matching
 * submission. Also covers the stale-id miss flow (banner + fallback scroll).
 */

const BASE = process.env["E2E_BASE_URL"] ?? "http://localhost:8080";

test.describe("intake deep link", () => {
  test.beforeEach(async ({ context, page }) => {
    const ok = await restoreSession(context, page, BASE);
    test.skip(!ok, "no Supabase session injected — cannot reach authenticated routes");
  });

  test("clicking a Home 'New request' highlights the right submission", async ({ page }) => {
    await page.goto("/dashboard", { waitUntil: "domcontentloaded" });

    const item = page
      .getByRole("link")
      .filter({ has: page.getByText("New request", { exact: true }) })
      .first();

    if ((await item.count()) === 0) {
      test.skip(true, "no pending intake submissions on this account");
    }

    const href = await item.getAttribute("href");
    const intakeId = new URL(href!, BASE).searchParams.get("intakeId");
    expect(intakeId, "Home link carries an intakeId").toBeTruthy();

    await item.click();

    await expect(page).toHaveURL(new RegExp(`/dashboard/intakes\\?.*intakeId=${intakeId}`));

    const card = page.locator(`#intake-${intakeId}`);
    await expect(card).toBeVisible();

    // Highlighted (jump marker set by the deep-link handler).
    await expect(card).toHaveAttribute("data-jumped", "true");

    // Details panel auto-opened.
    const toggle = card.getByRole("button", { name: /hide details/i });
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(card.locator(`#intake-details-${intakeId}`)).toBeVisible();

    // Focus moved to the card group.
    await expect(card).toBeFocused();

    // Scrolled into view.
    const inView = await card.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return r.top < window.innerHeight && r.bottom > 0;
    });
    expect(inView, "card is scrolled into the viewport").toBe(true);

    // No miss banner on a valid id.
    await expect(page.getByRole("alert")).toHaveCount(0);

    // Live-region announcement for screen readers.
    await expect(page.locator('[role="status"]')).toContainText(/opened intake submission/i);
  });

  test("stale intake id shows the miss banner and lands on the newest submission", async ({ page }) => {
    const staleId = "00000000-0000-4000-8000-000000000000";
    await page.goto(`/dashboard/intakes?intakeId=${staleId}#intake-${staleId}`, {
      waitUntil: "domcontentloaded",
    });

    const banner = page.getByRole("alert");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText(/couldn't find that submission/i);
    await expect(banner).toContainText(staleId);

    // Nothing is highlighted on a miss.
    await expect(page.locator('[data-jumped="true"]')).toHaveCount(0);

    // Banner heading takes focus so the miss is announced.
    const heading = banner.getByRole("heading");
    await expect(heading).toBeFocused();

    // Dismiss clears the banner.
    await banner.getByRole("button", { name: /dismiss/i }).click();
    await expect(page.getByRole("alert")).toHaveCount(0);
  });
});
