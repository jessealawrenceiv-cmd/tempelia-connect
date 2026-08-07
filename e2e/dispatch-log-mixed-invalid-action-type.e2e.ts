import { expect, test } from "@playwright/test";
import { restoreSession } from "./support/session";
import { LOG_ACTION_TYPES } from "../src/lib/log-action-types.generated";

/**
 * E2E for a mixed action_type filter in the Activity (Dispatch) log:
 *
 * Phase 1 — client guard: a deep link carrying one real and one bogus record
 *   type gets the bogus value stripped before any request, with a visible
 *   "Record type filter ignored" notice.
 * Phase 2 — server rejection: the stubbed REST endpoint answers with the real
 *   PostgREST `logs_action_type_check` payload (HTTP 400). Both the list view
 *   and the CSV export must render the same user-friendly error — friendly
 *   headline, plain-language explanation, allowed-type list, and the exact
 *   constraint text behind "Technical details".
 */

const VALID_TYPE = "quote_sms";
const BOGUS_TYPE = "not_a_real_type";

/** Exactly what PostgREST returns for the CHECK violation. */
const CHECK_400 = {
  code: "23514",
  message: 'new row for relation "logs" violates check constraint "logs_action_type_check"',
  details: `Failing row contains (…, ${BOGUS_TYPE}, …).`,
  hint: null,
};

type Row = {
  id: string;
  action_type: string;
  message_sent: string;
  created_at: string;
  status: string;
  customer_id: null;
  recipient_phone: string;
  twilio_message_sid: null;
  voicemail_url: null;
  recording_sid: null;
  call_sid: null;
  prompt_template: null;
  prompt_template_hash: null;
  prompt_cooldown_minutes: null;
};

const ROWS: Row[] = Array.from({ length: 5 }, (_, i) => ({
  id: `quote-${i}`,
  action_type: VALID_TYPE,
  message_sent: `quote fixture #${i}`,
  created_at: new Date(Date.UTC(2026, 6, 1, 12, 0, 0) - i * 60_000).toISOString(),
  status: "sent",
  customer_id: null,
  recipient_phone: "+14155550100",
  twilio_message_sid: null,
  voicemail_url: null,
  recording_sid: null,
  call_sid: null,
  prompt_template: null,
  prompt_template_hash: null,
  prompt_cooldown_minutes: null,
}));

test.describe("E2E · Activity log mixed invalid action_type filter", () => {
  /** Flipped on to make every logs read fail with the 400 payload. */
  let rejectWith400 = false;
  /** Every action_type filter value that actually reached the network. */
  let sentTypes: string[] = [];

  test.beforeEach(async ({ context, page, baseURL }) => {
    const ok = await restoreSession(context, page, baseURL!);
    test.skip(!ok, "No Supabase session available in this environment");

    rejectWith400 = false;
    sentTypes = [];

    await context.route(/\/rest\/v1\/logs(_archive)?\?/, async (route) => {
      const params = new URL(route.request().url()).searchParams;
      const filter = params.get("action_type") ?? "";
      const values = filter.startsWith("in.")
        ? filter
            .slice(3)
            .replace(/^\(|\)$/g, "")
            .split(",")
            .map((v) => v.replace(/^"|"$/g, "").trim())
            .filter(Boolean)
        : filter.startsWith("eq.")
          ? [filter.slice(3)]
          : [];
      sentTypes.push(...values);

      if (rejectWith400) {
        await route.fulfill({
          status: 400,
          contentType: "application/json",
          body: JSON.stringify(CHECK_400),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "content-range": "0-4/*" },
        body: JSON.stringify(ROWS),
      });
    });
  });

  test("strips the bogus value client-side, then shows the same friendly 400 for list and export", async ({
    page,
  }) => {
    // ---- Phase 1: mixed filter via deep link -------------------------------
    await page.goto(`/dashboard?logTypes=${VALID_TYPE},${BOGUS_TYPE}`, {
      waitUntil: "domcontentloaded",
    });

    // The bogus value is announced and dropped; only the valid one is sent.
    await expect(page.getByText("Record type filter ignored")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("log-filter-help-logTypes")).toContainText(BOGUS_TYPE);
    await expect(page.getByText("quote fixture #0")).toBeVisible({ timeout: 20_000 });
    expect(sentTypes).toContain(VALID_TYPE);
    expect(sentTypes).not.toContain(BOGUS_TYPE);

    // ---- Phase 2: the server rejects the request anyway (drift) ------------
    rejectWith400 = true;
    await page.reload({ waitUntil: "domcontentloaded" });

    // List view: the user-friendly payload, not a raw Postgres dump.
    const alert = page.getByTestId("log-error-alert");
    await expect(alert).toBeVisible({ timeout: 20_000 });
    await expect(alert).toContainText("That record type isn’t one we track");
    await expect(alert).toContainText("fixed list of record types");
    await expect(alert).toContainText(`Allowed: ${LOG_ACTION_TYPES.join(", ")}`);

    const toggle = page.getByTestId("log-error-details-toggle");
    await expect(toggle).toContainText("HTTP 400");
    await toggle.click();
    await expect(page.getByTestId("log-error-details-text")).toContainText(
      "logs_action_type_check",
    );

    // Inline helper text next to the Record type filter, no disclosure needed.
    await expect(page.getByText(/Only these record types can be filtered/i)).toBeVisible();

    // Export view: same headline and same constraint text in the toast.
    await page.getByRole("button", { name: /Export/i }).click();
    const toast = page.locator("[data-sonner-toast]").filter({
      hasText: "That record type isn’t one we track",
    });
    await expect(toast).toBeVisible({ timeout: 20_000 });
    await expect(toast).toContainText("fixed list of record types");
    await expect(toast).toContainText("logs_action_type_check");
    await expect(toast).toContainText("HTTP 400");

    // Recovery: clearing filters re-runs the query and the log loads again.
    rejectWith400 = false;
    await page.getByTestId("log-error-clear-filters").click();
    await expect(page.getByText("quote fixture #0")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("log-error-alert")).toHaveCount(0);
  });
});
