import { expect, request, test, type APIRequestContext, type Page } from "@playwright/test";
import { restoreSession } from "./support/session";

const MISSED_CALLS_PATH = "/dashboard/missed-calls";

const SUPABASE_URL = process.env["VITE_SUPABASE_URL"] ?? process.env["SUPABASE_URL"];
const SUPABASE_KEY =
  process.env["VITE_SUPABASE_PUBLISHABLE_KEY"] ?? process.env["SUPABASE_PUBLISHABLE_KEY"];

function accessToken() {
  const direct = process.env["LOVABLE_BROWSER_SUPABASE_ACCESS_TOKEN"];
  if (direct) return direct;
  const sessionJson = process.env["LOVABLE_BROWSER_SUPABASE_SESSION_JSON"];
  if (!sessionJson) return undefined;
  try {
    const parsed = JSON.parse(sessionJson) as Record<string, unknown>;
    const inner = (parsed["currentSession"] ?? parsed) as Record<string, unknown>;
    return inner["access_token"] as string | undefined;
  } catch {
    return undefined;
  }
}

/** PostgREST client acting as the signed-in preview user (RLS applies). */
async function restClient(): Promise<APIRequestContext | null> {
  const token = accessToken();
  if (!SUPABASE_URL || !SUPABASE_KEY || !token) return null;
  return request.newContext({
    baseURL: `${SUPABASE_URL}/rest/v1/`,
    extraHTTPHeaders: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
  });
}

/** Inserts a missed-call automation log row and returns its id. */
async function insertMissedCall(
  api: APIRequestContext,
  userId: string,
  outcome: "sent" | "failed",
): Promise<string> {
  const res = await api.post("logs", {
    data: {
      user_id: userId,
      action_type: "missed_call_text",
      status: outcome === "sent" ? "sent" : "failed",
      message_sent: `E2E live-region probe (${outcome})`,
      twilio_message_sid: outcome === "sent" ? `SMe2e${Date.now()}` : null,
      recipient_phone: "+14155550000",
    },
  });
  expect(res.ok(), `log insert failed: ${res.status()} ${await res.text()}`).toBe(true);
  const rows = (await res.json()) as { id: string }[];
  return rows[0]!.id;
}

async function currentUserId(api: APIRequestContext) {
  const res = await api.get("profiles?select=id&limit=1");
  if (!res.ok()) return null;
  const rows = (await res.json()) as { id: string }[];
  return rows[0]?.id ?? null;
}

/** Stable identity of the focused element, to prove focus never moves. */
function focusSignature(page: Page) {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return "NONE";
    return [
      el.tagName,
      el.getAttribute("data-testid") ?? "",
      el.getAttribute("type") ?? "",
      el.getAttribute("aria-label") ?? "",
    ].join("|");
  });
}

/** Triggers a react-query window-focus refetch without touching the DOM focus. */
async function triggerRefetch(page: Page) {
  await page.evaluate(() => {
    window.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("focus"));
  });
}

test.describe("Missed calls · automation updates are announced, not focused", () => {
  let api: APIRequestContext | null = null;
  let userId: string | null = null;
  const createdLogIds: string[] = [];

  test.beforeEach(async ({ context, page, baseURL }) => {
    const restored = await restoreSession(context, page, baseURL!);
    test.skip(!restored, "No Supabase session available for authenticated e2e tests.");
    api = await restClient();
    test.skip(!api, "No Supabase REST credentials available for authenticated e2e tests.");
    userId = await currentUserId(api!);
    test.skip(!userId, "Could not resolve the signed-in user's profile.");
    await page.goto(MISSED_CALLS_PATH, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Missed calls" }).first()).toBeVisible();
  });

  test.afterEach(async () => {
    if (!api) return;
    for (const id of createdLogIds.splice(0)) {
      await api.delete(`logs?id=eq.${id}`).catch(() => undefined);
    }
  });

  test("live region exists, is polite/atomic and is not focusable", async ({ page }) => {
    const live = page.getByTestId("missed-calls-status-live");
    await expect(live).toHaveAttribute("aria-live", "polite");
    await expect(live).toHaveAttribute("aria-atomic", "true");
    await expect(live).toHaveAttribute("role", "status");
    // Never a tab stop: no tabindex, and not a focusable element.
    expect(await live.getAttribute("tabindex")).toBeNull();
    await expect
      .poll(async () => ((await live.textContent()) ?? "").trim().length, { timeout: 20_000 })
      .toBeGreaterThan(0);
    await expect(live).toContainText(/Missed-call automation updated\./i);
  });

  test("status and auto-reply outcome are announced after an update without moving focus", async ({
    page,
  }) => {
    const live = page.getByTestId("missed-calls-status-live");
    const search = page.getByRole("searchbox");
    await search.focus();
    const focusBefore = await focusSignature(page);

    await expect
      .poll(async () => ((await live.textContent()) ?? "").trim().length, { timeout: 20_000 })
      .toBeGreaterThan(0);
    const before = ((await live.textContent()) ?? "").trim();

    // A new missed-call automation outcome lands in the backend.
    createdLogIds.push(await insertMissedCall(api!, userId!, "failed"));
    await triggerRefetch(page);

    await expect
      .poll(async () => ((await live.textContent()) ?? "").trim(), {
        message: "live region should re-announce the missed-call automation outcome",
        timeout: 25_000,
      })
      .not.toBe(before);

    const after = ((await live.textContent()) ?? "").trim();
    // The announcement names both the status counts and the auto-reply outcome.
    expect(after).toMatch(/call(s)? shown/i);
    expect(after).toMatch(/auto-reply sent/i);
    expect(after).toMatch(/failed/i);
    expect(after).toMatch(/awaiting consent/i);
    expect(after).toMatch(/Newest call .*auto-reply (sent|failed|unconfirmed|skipped)/i);

    // Focus never moved, and the live region never became the active element.
    expect(await focusSignature(page)).toBe(focusBefore);
    await expect(search).toBeFocused();
    expect(
      await page.evaluate(
        (testid) => document.activeElement?.getAttribute("data-testid") === testid,
        "missed-calls-status-live",
      ),
    ).toBe(false);
  });

  test("each subsequent automation update re-announces and keeps focus put", async ({ page }) => {
    const live = page.getByTestId("missed-calls-status-live");
    const search = page.getByRole("searchbox");
    await search.focus();

    let previous = "";
    for (const outcome of ["sent", "failed"] as const) {
      await expect
        .poll(async () => ((await live.textContent()) ?? "").trim().length, { timeout: 20_000 })
        .toBeGreaterThan(0);
      previous = ((await live.textContent()) ?? "").trim();

      createdLogIds.push(await insertMissedCall(api!, userId!, outcome));
      await triggerRefetch(page);

      await expect
        .poll(async () => ((await live.textContent()) ?? "").trim(), {
          message: `update (${outcome}) should produce a fresh announcement`,
          timeout: 25_000,
        })
        .not.toBe(previous);

      await expect(search).toBeFocused();
    }
  });
});
