import { test, expect, request, type APIRequestContext, type Page } from "@playwright/test";
import { restoreSession } from "./support/session";

const SETTINGS_PATH = "/dashboard/settings";

const SUPABASE_URL = process.env["VITE_SUPABASE_URL"] ?? process.env["SUPABASE_URL"];
const SUPABASE_KEY =
  process.env["VITE_SUPABASE_PUBLISHABLE_KEY"] ?? process.env["SUPABASE_PUBLISHABLE_KEY"];

/** Access token for the signed-in preview user, used to write as that user (RLS applies). */
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

/** Minimal PostgREST client acting as the signed-in user. */
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

type ProfileRow = {
  id: string;
  auto_refresh_enabled: boolean;
  auto_refresh_interval_minutes: number;
};

async function readProfile(api: APIRequestContext): Promise<ProfileRow | null> {
  const res = await api.get(
    "profiles?select=id,auto_refresh_enabled,auto_refresh_interval_minutes&limit=1"
  );
  if (!res.ok()) return null;
  const rows = (await res.json()) as ProfileRow[];
  return rows[0] ?? null;
}

async function patchProfile(api: APIRequestContext, id: string, patch: Record<string, unknown>) {
  const res = await api.patch(`profiles?id=eq.${id}`, { data: patch });
  expect(res.ok(), `profile update failed: ${res.status()} ${await res.text()}`).toBe(true);
}

async function latestStatusRefresh(api: APIRequestContext): Promise<{
  status: string;
  message_sent: string;
  created_at: string;
} | null> {
  const res = await api.get(
    "logs?select=status,message_sent,created_at&action_type=eq.status_refresh&order=created_at.desc&limit=1"
  );
  if (!res.ok()) return null;
  const rows = (await res.json()) as Array<{ status: string; message_sent: string; created_at: string }>;
  return rows[0] ?? null;
}

async function waitForLive(page: Page) {
  await expect(page.locator('[role="status"]', { hasText: /^\s*Live\s*$/ }).first()).toBeVisible({
    timeout: 20_000,
  });
}

test.describe("Settings · auto-refresh interval", () => {
  let api: APIRequestContext | null = null;
  let original: ProfileRow | null = null;

  test.beforeEach(async ({ context, page, baseURL }) => {
    const restored = await restoreSession(context, page, baseURL!);
    test.skip(!restored, "No Supabase session available for authenticated e2e tests.");
    api = await restClient();
    test.skip(!api, "No Supabase REST credentials available to simulate row updates.");
    original = await readProfile(api!);
    test.skip(!original, "No profile row readable for the signed-in user.");

    await page.goto(SETTINGS_PATH, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Settings" }).first()).toBeVisible();
    await waitForLive(page);
  });

  test.afterEach(async () => {
    if (api && original) {
      await patchProfile(api, original.id, {
        auto_refresh_enabled: original.auto_refresh_enabled,
        auto_refresh_interval_minutes: original.auto_refresh_interval_minutes,
      });
      await api.dispose();
    }
    api = null;
    original = null;
  });

  test("enabling auto-refresh schedules a status re-check and logs it as auto-triggered", async ({ page }) => {
    test.setTimeout(120_000);
    // Pre-enable auto-refresh via the API so the timer starts as soon as the page mounts.
    await patchProfile(api!, original!.id, {
      auto_refresh_enabled: true,
      auto_refresh_interval_minutes: 1,
    });

    // Switch to Advanced tab and verify the UI reflects the persisted state.
    await page.getByRole("button", { name: "Advanced" }).first().click();
    await expect(page.getByRole("heading", { name: "Auto-refresh statuses" }).first()).toBeVisible();

    const panel = page
      .getByRole("heading", { name: "Auto-refresh statuses" })
      .locator("xpath=ancestor::div[contains(@class,'panel')][1]");
    const toggle = panel.locator('input[type="checkbox"]').first();
    await expect(toggle).toBeVisible();
    await expect.poll(async () => toggle.isChecked(), { timeout: 10_000 }).toBe(true);

    const intervalInput = panel.locator('input[type="number"][min="1"][max="120"]').first();
    await expect(intervalInput).toHaveValue("1");

    // Wait for one auto-refresh tick (interval is 1 minute).
    const beforeIso = new Date().toISOString();
    await page.waitForTimeout(65_000);

    // Verify the Activity log received a status_refresh row triggered by auto.
    const row = await latestStatusRefresh(api!);
    expect(row).not.toBeNull();
    expect(new Date(row!.created_at).getTime()).toBeGreaterThan(new Date(beforeIso).getTime());
    const payload = JSON.parse(row!.message_sent) as Record<string, unknown>;
    expect(payload["trigger"]).toBe("auto");
    expect(row!.status).toMatch(/^(updated|already_current)$/);
  });

});
