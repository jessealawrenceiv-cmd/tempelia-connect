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

type ProfileRow = { id: string; voicemail_enabled: boolean; decline_followup_mode: string };

async function readProfile(api: APIRequestContext): Promise<ProfileRow | null> {
  const res = await api.get("profiles?select=id,voicemail_enabled,decline_followup_mode&limit=1");
  if (!res.ok()) return null;
  const rows = (await res.json()) as ProfileRow[];
  return rows[0] ?? null;
}

async function patchProfile(api: APIRequestContext, id: string, patch: Record<string, unknown>) {
  const res = await api.patch(`profiles?id=eq.${id}`, { data: patch });
  expect(res.ok(), `profile update failed: ${res.status()} ${await res.text()}`).toBe(true);
}

/** The "Automations in Advanced" panel badge trigger. */
async function badgeTrigger(page: Page) {
  const panel = page.getByRole("heading", { name: "Automations in Advanced" }).locator("..").locator("..");
  await expect(panel).toBeVisible();
  const trigger = panel.locator('button[aria-haspopup="true"][aria-controls]').first();
  await expect(trigger).toBeVisible();
  return trigger;
}

/** Waits for the realtime subscription to report Live before mutating the row. */
async function waitForLive(page: Page) {
  await expect(page.locator('[role="status"]', { hasText: /^\s*Live\s*$/ }).first()).toBeVisible({
    timeout: 20_000,
  });
}

test.describe("Settings · ACTIVE badge reacts to live row updates", () => {
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
    // Always put the row back the way we found it.
    if (api && original) {
      await patchProfile(api, original.id, {
        voicemail_enabled: original.voicemail_enabled,
        decline_followup_mode: original.decline_followup_mode,
      });
      await api.dispose();
    }
    api = null;
    original = null;
  });

  test("toggling voicemail_enabled in the database updates the status UI without a reload", async ({ page }) => {
    const trigger = await badgeTrigger(page);
    // The panel badge stays a well-formed status while live updates arrive.
    await expect(trigger).toHaveAttribute("aria-label", /Automation status: .+/i);

    const voicemailSwitch = page.getByRole("switch").first();
    const before = await voicemailSwitch.getAttribute("aria-checked");

    await patchProfile(api!, original!.id, { voicemail_enabled: !original!.voicemail_enabled });

    // Voicemail state re-renders from the live payload — no navigation, no reload.
    await expect
      .poll(async () => voicemailSwitch.getAttribute("aria-checked"), { timeout: 20_000 })
      .not.toBe(before);

    // A toast describes the change and when it happened.
    await expect(page.getByText(/Automation status updated/i).first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/Voicemail (ACTIVE|OFF)/i).first()).toBeVisible();
    await expect(page.getByText(/\d{1,2}:\d{2}:\d{2}/).first()).toBeVisible();
    await expect(trigger).toHaveAttribute("aria-label", /Automation status: .+/i);
  });


  test("the tooltip's live-update line reports the change and its timestamp", async ({ page }) => {
    const trigger = await badgeTrigger(page);
    const tooltipId = await trigger.getAttribute("aria-controls");
    const tooltip = page.locator(`#${tooltipId}`);

    await trigger.focus();
    await page.keyboard.press("Enter");
    await expect(tooltip).toBeVisible();

    const liveLine = tooltip.locator('[aria-live="polite"]', { hasText: /live update/i }).first();
    await expect(liveLine).toContainText(/No live update since this page opened/i);

    await patchProfile(api!, original!.id, { voicemail_enabled: !original!.voicemail_enabled });

    // Attribution + clock time appear instantly, while the tooltip stays open.
    await expect(liveLine).toContainText(/Last live update/i, { timeout: 20_000 });
    await expect(liveLine).toContainText(/\d{1,2}:\d{2}:\d{2}/);
    await expect(liveLine).toContainText(/(this device|another device|the backend)/i);
    await expect(tooltip).toBeVisible();
  });

  test("changing decline_followup_mode in the database updates the control and toast live", async ({ page }) => {
    const trigger = await badgeTrigger(page);
    const tooltipId = await trigger.getAttribute("aria-controls");
    const tooltip = page.locator(`#${tooltipId}`);

    const select = page.locator("select").filter({ hasText: "Manual" }).first();
    await expect(select).toBeVisible();

    const nextMode = original!.decline_followup_mode === "off" ? "auto" : "off";
    await patchProfile(api!, original!.id, { decline_followup_mode: nextMode });

    // The select reflects the new row value straight from the live payload.
    await expect.poll(async () => select.inputValue(), { timeout: 20_000 }).toBe(nextMode);

    await expect(page.getByText(/Declined-quote follow-up/i).first()).toBeVisible({ timeout: 20_000 });

    // And the tooltip's live-update line records the change with its timestamp.
    await trigger.focus();
    await page.keyboard.press("Enter");
    await expect(tooltip).toBeVisible();
    const liveLine = tooltip.locator('[aria-live="polite"]', { hasText: /live update/i }).first();
    await expect(liveLine).toContainText(/Last live update/i);
    await expect(liveLine).toContainText(/\d{1,2}:\d{2}:\d{2}/);
  });
});

