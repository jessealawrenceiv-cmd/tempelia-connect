import { expect, test } from "@playwright/test";
import { restoreSession } from "./support/session";

/**
 * Intakes → browser history navigation between two deep links.
 *
 * Visits submission A, then submission B, then walks back/forward with the
 * browser buttons. After each hop the highlight (`data-jumped`), the expanded
 * details panel, the scroll position, and DOM focus must all follow the URL.
 */

const BASE = process.env["E2E_BASE_URL"] ?? "http://localhost:8080";

const deepLink = (id: string) =>
  `/dashboard/intakes?intakeId=${encodeURIComponent(id)}#intake-${encodeURIComponent(id)}`;

test.describe("intake deep-link history navigation", () => {
  test.beforeEach(async ({ context, page }) => {
    const ok = await restoreSession(context, page, BASE);
    test.skip(!ok, "no Supabase session injected — cannot reach authenticated routes");
  });

  test("back/forward moves highlight, scroll and focus between two intakes", async ({ page }) => {
    await page.goto("/dashboard/intakes", { waitUntil: "domcontentloaded" });

    const cards = page.locator('[role="listitem"][id^="intake-"]');
    await expect(cards.first()).toBeVisible({ timeout: 20_000 });

    const ids = (await cards.evaluateAll((els) =>
      els.map((el) => el.id.replace(/^intake-/, "")),
    )).filter(Boolean);

    test.skip(ids.length < 2, "needs at least two intake submissions to navigate between");

    const [a, b] = [ids[0]!, ids[ids.length - 1]!];
    expect(a).not.toBe(b);

    /** Asserts the given submission is the highlighted / expanded / focused one. */
    const expectActive = async (id: string, other: string) => {
      const card = page.locator(`#intake-${id}`);
      await expect(card).toBeVisible();
      await expect(card).toHaveAttribute("data-jumped", "true");

      // Details panel open for the active card…
      await expect(card.getByRole("button", { name: /hide details/i })).toHaveAttribute(
        "aria-expanded",
        "true",
      );
      // …and closed for the other one.
      await expect(
        page.locator(`#intake-${other}`).getByRole("button", { name: /show details/i }),
      ).toHaveAttribute("aria-expanded", "false");

      // Scrolled into view.
      await expect
        .poll(
          () =>
            card.evaluate((el) => {
              const r = el.getBoundingClientRect();
              return r.top < window.innerHeight && r.bottom > 0;
            }),
          { message: `#intake-${id} scrolled into view` },
        )
        .toBe(true);

      // Focus follows the deep link (roving tab stop lands on the card group).
      await expect
        .poll(() => page.evaluate(() => document.activeElement?.closest("[role='listitem'][id^='intake-']")?.id), {
          message: `focus inside #intake-${id}`,
        })
        .toBe(`intake-${id}`);
    };

    // A → B via full deep-link navigations (each pushes a history entry).
    await page.goto(deepLink(a), { waitUntil: "domcontentloaded" });
    await expectActive(a, b);

    await page.goto(deepLink(b), { waitUntil: "domcontentloaded" });
    await expectActive(b, a);

    // Back → A
    await page.goBack({ waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(new RegExp(`intakeId=${encodeURIComponent(a)}`));
    await expectActive(a, b);

    // Forward → B
    await page.goForward({ waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(new RegExp(`intakeId=${encodeURIComponent(b)}`));
    await expectActive(b, a);
  });
});
