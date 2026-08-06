import { test, expect, request, type APIRequestContext, type Page } from "@playwright/test";
import { restoreSession } from "./support/session";

/**
 * Source attribution coverage.
 *
 * A live automation-status change can come from three places, and the ACTIVE
 * tooltip + toast must say which one:
 *   - this device   → the same tab wrote the row (matching local edit < 15s ago)
 *   - another device → a signed-in session elsewhere wrote a UI-writable field
 *   - backend        → server-side automation wrote a field the UI never writes
 */

const SETTINGS_PATH = "/dashboard/settings";

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

/** PostgREST client acting as the signed-in user — stands in for "another device". */
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

async function openAdvanced(page: Page) {
  const advanced = page.getByRole("tab", { name: /advanced/i }).first();
  if (await advanced.isVisible().catch(() => false)) await advanced.click();
}

async function badgeTrigger(page: Page) {
  const panel = page
    .getByRole("heading", { name: "Automations in Advanced" })
    .locator("..")
    .locator("..");
  await expect(panel).toBeVisible();
  const trigger = panel.locator('button[aria-haspopup="true"][aria-controls]').first();
  await expect(trigger).toBeVisible();
  return trigger;
}

/** Opens the ACTIVE tooltip and returns its panel locator. */
async function openTooltip(page: Page) {
  const trigger = await badgeTrigger(page);
  const id = await trigger.getAttribute("aria-controls");
  await trigger.click();
  const panel = page.locator(`#${id}`);
  await expect(panel).toBeVisible();
  return { trigger, panel };
}

async function waitForLive(page: Page) {
  await expect(
    page.locator('[role="status"]', { hasText: /^\s*Live\s*$/ }).first(),
  ).toBeVisible({ timeout: 20_000 });
}

function voicemailRow(page: Page) {
  return page
    .getByText("Voicemail on missed calls", { exact: true })
    .locator("xpath=ancestor::div[contains(@class,'justify-between')][1]");
}

const attributionToast = (page: Page, phrase: RegExp) =>
  page.locator("[data-sonner-toast]").filter({ hasText: phrase }).first();

test.describe("Settings · live update source attribution", () => {
  let api: APIRequestContext | null = null;
  let original: ProfileRow | null = null;

  test.beforeEach(async ({ context, page, baseURL }) => {
    const restored = await restoreSession(context, page, baseURL!);
    test.skip(!restored, "No Supabase session available for authenticated e2e tests.");
    api = await restClient();
    test.skip(!api, "No Supabase REST credentials available to simulate remote updates.");
    original = await readProfile(api!);
    test.skip(!original, "No profile row readable for the signed-in user.");

    await page.goto(SETTINGS_PATH, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Settings" }).first()).toBeVisible();
    await openAdvanced(page);
    await waitForLive(page);
  });

  test.afterEach(async () => {
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

  test("a change made in this tab is attributed to this device", async ({ page }) => {
    const toggle = voicemailRow(page).locator('input[type="checkbox"]').first();
    await expect(toggle).toBeVisible();
    const before = await toggle.isChecked();

    await toggle.click();

    // Toast names this device as the source.
    await expect(attributionToast(page, /Automation status updated/i)).toContainText(
      /from this device/i,
      { timeout: 20_000 },
    );
    await expect(attributionToast(page, /Automation status updated/i)).toContainText(
      before ? /Voicemail OFF/i : /Voicemail ACTIVE/i,
    );

    // Tooltip attribution line agrees with the toast.
    const { panel } = await openTooltip(page);
    await expect(panel).toContainText(/Last live update from this device/i);
    await expect(panel).not.toContainText(/from another device|from the backend/i);
  });

  test("a change written from another session is attributed to another device", async ({ page }) => {
    const toggle = voicemailRow(page).locator('input[type="checkbox"]').first();
    await expect(toggle).toBeVisible();
    const before = await toggle.isChecked();

    // No local edit recorded in this tab → must read as a remote signed-in device.
    await patchProfile(api!, original!.id, { voicemail_enabled: !original!.voicemail_enabled });

    await expect(attributionToast(page, /Automation status updated/i)).toContainText(
      /from another device/i,
      { timeout: 20_000 },
    );
    await expect.poll(async () => toggle.isChecked(), { timeout: 20_000 }).toBe(!before);

    const { panel } = await openTooltip(page);
    await expect(panel).toContainText(/Last live update from another device/i);
    await expect(panel).not.toContainText(/from this device|from the backend/i);
  });

  test("a remote change outside the 15s local-edit window is not credited to this device", async ({
    page,
  }) => {
    const toggle = voicemailRow(page).locator('input[type="checkbox"]').first();
    await expect(toggle).toBeVisible();

    // Edit locally first, let the attribution window lapse, then write remotely.
    await toggle.click();
    await expect(attributionToast(page, /from this device/i)).toBeVisible({ timeout: 20_000 });
    const current = await readProfile(api!);
    await page.waitForTimeout(16_000);

    await patchProfile(api!, original!.id, { voicemail_enabled: !current!.voicemail_enabled });

    await expect(attributionToast(page, /from another device/i)).toBeVisible({ timeout: 20_000 });
    const { panel } = await openTooltip(page);
    await expect(panel).toContainText(/Last live update from another device/i);
  });

  test("backend-origin entries are filterable in the Activity log without mixing in device sources", async ({
    page,
  }) => {
    // The Activity log carries the same attribution as the tooltip/toast.
    await page.goto("/dashboard", { waitUntil: "domcontentloaded" });
    const activity = page.getByRole("button", { name: /activity/i }).first();
    if (await activity.isVisible().catch(() => false)) await activity.click();

    const backendChip = page.getByRole("button", { name: "Backend", exact: true }).first();
    await expect(backendChip).toBeVisible({ timeout: 20_000 });
    await backendChip.click();
    await expect(backendChip).toHaveAttribute("aria-pressed", "true");

    // Whatever rows remain must be backend-attributed only.
    const list = backendChip.locator("xpath=ancestor::div[contains(@class,'border-b')][1]/following::ul[1]");
    await expect(list).toBeVisible();
    await expect(list).not.toContainText("This device");
    await expect(list).not.toContainText("Another device");

    // Switching to the device filters excludes backend rows symmetrically.
    const thisDevice = page.getByRole("button", { name: "This device", exact: true }).first();
    await thisDevice.click();
    await expect(thisDevice).toHaveAttribute("aria-pressed", "true");
    await expect(list).not.toContainText("Backend");
  });
});
