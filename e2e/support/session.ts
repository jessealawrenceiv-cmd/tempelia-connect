import type { BrowserContext, Page } from "@playwright/test";

/**
 * Restores the Supabase session that the Lovable preview injects into the
 * environment so e2e tests can reach authenticated routes.
 *
 * Returns false when no session is available — tests should skip in that case
 * instead of failing.
 */
export async function restoreSession(context: BrowserContext, page: Page, baseURL: string) {
  const status = process.env["LOVABLE_BROWSER_AUTH_STATUS"];
  if (status && status !== "injected") return false;

  const cookiesJson = process.env["LOVABLE_BROWSER_SUPABASE_COOKIES_JSON"];
  if (cookiesJson) {
    const cookies = JSON.parse(cookiesJson) as Record<string, unknown>[];
    await context.addCookies(cookies.map((c) => ({ ...c, url: baseURL })) as never);
  }

  await page.goto(baseURL, { waitUntil: "domcontentloaded" });

  const storageKey = process.env["LOVABLE_BROWSER_SUPABASE_STORAGE_KEY"];
  const sessionJson = process.env["LOVABLE_BROWSER_SUPABASE_SESSION_JSON"];
  if (storageKey && sessionJson) {
    await page.evaluate(
      ([k, v]) => window.localStorage.setItem(k as string, v as string),
      [storageKey, sessionJson],
    );
  }

  return Boolean(cookiesJson || (storageKey && sessionJson));
}
