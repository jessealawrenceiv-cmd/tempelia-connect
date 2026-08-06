import { expect, test } from "@playwright/test";
import { restoreSession } from "./support/session";

/**
 * Intakes → "Copy link".
 *
 * Verifies the button writes the canonical deep link for that submission
 * (`<origin>/dashboard/intakes?intakeId=<id>#intake-<id>`) to the clipboard,
 * and that pasting it back reproduces the expanded, highlighted card.
 */

const BASE = process.env["E2E_BASE_URL"] ?? "http://localhost:8080";

test.describe("intake copy link", () => {
  test.beforeEach(async ({ context, page }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE });
    const ok = await restoreSession(context, page, BASE);
    test.skip(!ok, "no Supabase session injected — cannot reach authenticated routes");
  });

  test("copies the canonical deep-link URL for the card", async ({ page }) => {
    await page.goto("/dashboard/intakes", { waitUntil: "domcontentloaded" });

    const firstCard = page.locator('[id^="intake-"]').first();
    await expect(firstCard).toBeVisible({ timeout: 20_000 });

    const cardId = await firstCard.getAttribute("id");
    const intakeId = cardId!.replace(/^intake-/, "");
    expect(intakeId, "card carries a submission id").toBeTruthy();

    await firstCard.getByRole("button", { name: /copy link/i }).click();

    // Button confirms visually…
    await expect(firstCard.getByRole("button", { name: /^copied$/i })).toBeVisible();

    // …and the clipboard holds the canonical deep link.
    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    const encoded = encodeURIComponent(intakeId);
    expect(clipboard).toBe(`${BASE}/dashboard/intakes?intakeId=${encoded}#intake-${encoded}`);

    // Round-trip: the copied link reopens the same submission, expanded.
    await page.goto(clipboard, { waitUntil: "domcontentloaded" });
    const target = page.locator(`#intake-${intakeId}`);
    await expect(target).toBeVisible();
    await expect(target).toHaveAttribute("data-jumped", "true");
    await expect(target.getByRole("button", { name: /hide details/i })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });
});
