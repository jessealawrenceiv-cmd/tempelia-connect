import { expect, test } from "@playwright/test";
import { restoreSession } from "./support/session";

/**
 * Deep-links into the Activity (Dispatch) log with ?logTypes= filters, verifies
 * only matching rows render, then confirms "Load 25 older" keyset pagination
 * still works after toggling a type chip.
 *
 * The `logs` REST reads are stubbed so the assertions are deterministic and do
 * not depend on how much real activity the signed-in business happens to have.
 */

const PAGE_SIZE = 25;
const TOTAL_PER_TYPE = 30;

type Fixture = {
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

/** Newest-first synthetic history: 30 rows per action type, 1 minute apart. */
function buildFixtures(): Fixture[] {
  const types = ["missed_call_text", "sms_inbound", "review_request"];
  const base = Date.UTC(2026, 6, 1, 12, 0, 0);
  const rows: Fixture[] = [];
  types.forEach((action_type, typeIndex) => {
    for (let i = 0; i < TOTAL_PER_TYPE; i += 1) {
      const minutesAgo = i * types.length + typeIndex;
      rows.push({
        id: `${action_type}-${String(i).padStart(3, "0")}`,
        action_type,
        message_sent: `${action_type} fixture #${i}`,
        created_at: new Date(base - minutesAgo * 60_000).toISOString(),
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
      });
    }
  });
  return rows.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}

const FIXTURES = buildFixtures();

/** Minimal PostgREST emulation for the filters DispatchLog actually sends. */
function serveLogs(url: URL): Fixture[] {
  const params = url.searchParams;
  let rows = FIXTURES;

  const typeFilter = params.get("action_type");
  if (typeFilter?.startsWith("in.")) {
    const allowed = new Set(
      typeFilter
        .slice(3)
        .replace(/^\(|\)$/g, "")
        .split(",")
        .map((v) => v.replace(/^"|"$/g, "").trim())
        .filter(Boolean),
    );
    rows = rows.filter((r) => allowed.has(r.action_type));
  } else if (typeFilter?.startsWith("eq.")) {
    const wanted = typeFilter.slice(3);
    rows = rows.filter((r) => r.action_type === wanted);
  }

  const cursor = params.get("created_at");
  if (cursor?.startsWith("lt.")) {
    const at = decodeURIComponent(cursor.slice(3));
    rows = rows.filter((r) => r.created_at < at);
  } else if (cursor?.startsWith("gt.")) {
    const at = decodeURIComponent(cursor.slice(3));
    rows = rows.filter((r) => r.created_at > at).slice().reverse();
  }

  const limit = Number(params.get("limit") ?? PAGE_SIZE);
  return rows.slice(0, Number.isFinite(limit) ? limit : PAGE_SIZE);
}

/** Reads the "N loaded" footer counter. */
async function loadedCount(page: import("@playwright/test").Page): Promise<number> {
  const text = await page.getByText(/\d+ loaded/).first().innerText();
  return Number(text.replace(/\D/g, ""));
}

test.describe("E2E · Activity log deep link + pagination", () => {

  test.beforeEach(async ({ context, page, baseURL }) => {
    const ok = await restoreSession(context, page, baseURL!);
    test.skip(!ok, "No Supabase session available in this environment");

    await context.route(/\/rest\/v1\/logs(_archive)?\?/, async (route) => {
      const url = new URL(route.request().url());
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "content-range": "0-24/*" },
        body: JSON.stringify(serveLogs(url)),
      });
    });
  });

  test("deep link renders only the filtered rows, and pagination survives chip changes", async ({ page }) => {
    // Deep link: two type filters. This also auto-expands the collapsed log.
    await page.goto("/dashboard?logTypes=missed_call_text,sms_inbound", {
      waitUntil: "domcontentloaded",
    });

    const list = page.getByRole("list").filter({ has: page.getByText("MISSED_CALL_TEXT").first() }).first();
    await expect(list.getByRole("listitem").first()).toBeVisible({ timeout: 20_000 });

    // Chips for the deep-linked types are pressed; others are not.
    const chip = (label: string) => page.getByRole("button", { name: new RegExp(`^${label}`) }).first();
    await expect(chip("MISSED_CALL_TEXT")).toHaveAttribute("aria-pressed", "true");
    await expect(chip("SMS_INBOUND")).toHaveAttribute("aria-pressed", "true");
    await expect(chip("REVIEW_REQUEST")).toHaveAttribute("aria-pressed", "false");

    // Exactly one keyset page of rows, and none from an unselected type.
    await expect(page.getByText("25 loaded")).toBeVisible();
    await expect(list.getByText("REVIEW_REQUEST")).toHaveCount(0);
    expect(await list.getByText("MISSED_CALL_TEXT").count()).toBeGreaterThan(0);
    expect(await list.getByText("SMS_INBOUND").count()).toBeGreaterThan(0);

    // Pagination on the deep-linked filters.
    const loadOlder = page.getByRole("button", { name: `Load ${PAGE_SIZE} older` });
    await expect(loadOlder).toBeVisible();
    await loadOlder.click();
    await expect(page.getByText("50 loaded")).toBeVisible({ timeout: 20_000 });

    // Now interact with the chips: add a third type. The URL must follow and
    // the newly included type's rows must appear.
    await chip("REVIEW_REQUEST").click();
    await expect(chip("REVIEW_REQUEST")).toHaveAttribute("aria-pressed", "true");
    await expect(page).toHaveURL(/logTypes=[^&]*review_request/);
    await expect(list.getByText("REVIEW_REQUEST").first()).toBeVisible({ timeout: 20_000 });

    // Pagination still works after the chip interaction: the loaded count grows
    // by one page. The footer re-renders while the refetch settles, so retry.
    const before = await loadedCount(page);
    await expect(async () => {
      await page.getByRole("button", { name: `Load ${PAGE_SIZE} older` }).click({ timeout: 5_000 });
      expect(await loadedCount(page)).toBeGreaterThan(before);
    }).toPass({ timeout: 30_000 });

    // Removing a type drops its rows.
    await chip("SMS_INBOUND").click();
    await expect(chip("SMS_INBOUND")).toHaveAttribute("aria-pressed", "false");
    await expect(list.getByText("SMS_INBOUND")).toHaveCount(0, { timeout: 20_000 });
    expect(await list.getByText("MISSED_CALL_TEXT").count()).toBeGreaterThan(0);
  });

  });
});
