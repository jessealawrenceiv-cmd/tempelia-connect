import { expect, test } from "@playwright/test";
import { restoreSession } from "./support/session";

/**
 * Intakes → details toggle on a highlighted (deep-linked) submission.
 *
 * Verifies the toggle owns its panel via `aria-controls`, flips
 * `aria-expanded` and its label on each click, mounts/unmounts the panel, and
 * keeps focus on the toggle itself (including the Escape-to-collapse path).
 */

const BASE = process.env["E2E_BASE_URL"] ?? "http://localhost:8080";

test.describe("intake details toggle", () => {
  test.beforeEach(async ({ context, page }) => {
    const ok = await restoreSession(context, page, BASE);
    test.skip(!ok, "no Supabase session injected — cannot reach authenticated routes");
  });

  test("expands and collapses with correct aria-controls and focus handling", async ({ page }) => {
    await page.goto("/dashboard/intakes", { waitUntil: "domcontentloaded" });

    const cards = page.locator('[role="listitem"][id^="intake-"]');
    await expect(cards.first()).toBeVisible({ timeout: 20_000 });

    const intakeId = (await cards.first().getAttribute("id"))!.replace(/^intake-/, "");
    expect(intakeId).toBeTruthy();

    // Land on the card as a highlighted deep link.
    const encoded = encodeURIComponent(intakeId);
    await page.goto(`/dashboard/intakes?intakeId=${encoded}#intake-${encoded}`, {
      waitUntil: "domcontentloaded",
    });

    const card = page.locator(`#intake-${intakeId}`);
    await expect(card).toHaveAttribute("data-jumped", "true");

    const panelId = `intake-details-${intakeId}`;
    const panel = page.locator(`#${panelId}`);
    const toggle = card.locator(`button[aria-controls="${panelId}"]`);

    // Deep link opens expanded: label and state agree, panel is present.
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(toggle).toHaveText(/hide details/i);
    await expect(panel).toBeVisible();

    // Collapse by click → state flips, panel goes away, focus stays on toggle.
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(toggle).toHaveText(/show details/i);
    await expect(panel).toBeHidden();
    await expect(toggle).toBeFocused();

    // Expand again by click → panel returns, still the same aria-controls target.
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(toggle).toHaveText(/hide details/i);
    await expect(panel).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-controls", panelId);

    // Keyboard: Escape inside the card collapses it and returns focus to the toggle.
    await card.evaluate((el) => (el as HTMLElement).focus());
    await page.keyboard.press("Escape");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(panel).toBeHidden();
    await expect(toggle).toBeFocused();

    // And Space on the focused toggle re-expands it without moving focus.
    await page.keyboard.press("Space");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(panel).toBeVisible();
    await expect(toggle).toBeFocused();
  });
});
