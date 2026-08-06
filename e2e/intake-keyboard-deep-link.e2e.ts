import { expect, test } from "@playwright/test";
import { restoreSession } from "./support/session";

/**
 * Intakes → keyboard-only deep linking.
 *
 * Tabs to the roving tab stop, moves with ArrowDown, and asserts the newly
 * targeted submission gets a visible focus ring, an expanded details panel
 * (`aria-expanded="true"`), and an announcement in the polite live region.
 */

const BASE = process.env["E2E_BASE_URL"] ?? "http://localhost:8080";

test.describe("intake keyboard deep link", () => {
  test.beforeEach(async ({ context, page }) => {
    const ok = await restoreSession(context, page, BASE);
    test.skip(!ok, "no Supabase session injected — cannot reach authenticated routes");
  });

  test("arrow keys open a deep-linked intake with focus ring, expansion and announcement", async ({
    page,
  }) => {
    await page.goto("/dashboard/intakes", { waitUntil: "domcontentloaded" });

    const cards = page.locator('[role="listitem"][id^="intake-"]');
    await expect(cards.first()).toBeVisible({ timeout: 20_000 });

    const ids = (
      await cards.evaluateAll((els) => els.map((el) => el.id.replace(/^intake-/, "")))
    ).filter(Boolean);
    test.skip(ids.length < 2, "needs at least two intake submissions to arrow between");

    // Keyboard only: walk the tab order until the roving card tab stop has focus.
    const cardIdOfFocus = () =>
      page.evaluate(
        () =>
          document.activeElement?.closest("[role='listitem'][id^='intake-']")?.id ?? null,
      );

    let focusedCard: string | null = null;
    for (let i = 0; i < 60 && !focusedCard; i++) {
      await page.keyboard.press("Tab");
      focusedCard = await cardIdOfFocus();
    }
    expect(focusedCard, "Tab reaches an intake card").toBeTruthy();

    // Move down the list with the keyboard — this rewrites the deep link.
    await page.keyboard.press("ArrowDown");

    const targetId = ids[1]!;
    const target = page.locator(`#intake-${targetId}`);

    // URL deep link followed the keyboard.
    await expect(page).toHaveURL(new RegExp(`intakeId=${encodeURIComponent(targetId)}`));
    await expect(target).toBeFocused();
    await expect(target).toHaveAttribute("data-jumped", "true");

    // Visible focus ring for keyboard users (focus-visible ring + jump ring).
    const ring = await target.evaluate((el) => {
      const s = getComputedStyle(el);
      return { boxShadow: s.boxShadow, matchesFocusVisible: el.matches(":focus-visible") };
    });
    expect(ring.matchesFocusVisible, "card matches :focus-visible after keyboard move").toBe(true);
    expect(ring.boxShadow, "focus ring is painted").not.toBe("none");

    // Details panel expanded for the targeted submission.
    await expect(target.getByRole("button", { name: /hide details/i })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await expect(page.locator(`#intake-details-${targetId}`)).toBeVisible();

    // Live region announced the opened submission and its available actions.
    const liveRegion = page.locator('[role="status"][aria-live="polite"][aria-atomic="true"]');
    await expect(liveRegion).toContainText(/Opened intake submission/i);
    await expect(liveRegion).toContainText(/Details expanded/i);
    await expect(liveRegion).toContainText(/Available actions:.*Hide details/i);
  });
});
