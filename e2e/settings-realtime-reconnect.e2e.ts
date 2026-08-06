import { test, expect, type Page, type WebSocketRoute } from "@playwright/test";
import { restoreSession } from "./support/session";

const SETTINGS_PATH = "/dashboard/settings";

/** The Live / Reconnecting / Connecting indicator next to "Refresh statuses". */
function indicator(page: Page) {
  return page
    .locator('[role="status"][aria-live="polite"]')
    .filter({ hasText: /Live|Reconnecting|Connecting/i })
    .first();
}

/**
 * Samples the indicator text every 50ms and records the timestamp of each
 * distinct value, so we can measure the app's own reconnect backoff from what
 * the user actually sees.
 */
async function watchIndicator(page: Page) {
  const samples: { text: string; at: number }[] = [];
  let stopped = false;
  const loop = (async () => {
    const el = indicator(page);
    while (!stopped) {
      let text = "";
      try {
        text = ((await el.textContent({ timeout: 1000 })) ?? "").replace(/\s+/g, " ").trim();
      } catch {
        text = "";
      }
      if (text && samples[samples.length - 1]?.text !== text) {
        samples.push({ text, at: Date.now() });
      }
      await page.waitForTimeout(50);
    }
  })();
  return {
    samples,
    async stop() {
      stopped = true;
      await loop;
    },
  };
}

test.describe("Settings · Realtime disconnect, backoff reconnect, and status indicator", () => {
  let dropConnections = false;
  const handshakes: number[] = [];
  let openSockets: WebSocketRoute[] = [];

  test.beforeEach(async ({ context, page, baseURL }) => {
    dropConnections = false;
    handshakes.length = 0;
    openSockets = [];

    const restored = await restoreSession(context, page, baseURL!);
    test.skip(!restored, "No Supabase session available for authenticated e2e tests.");

    // Proxy the Realtime websocket so the test can sever it on demand.
    await page.routeWebSocket(/\/realtime\/v1\//, (ws) => {
      handshakes.push(Date.now());
      ws.connectToServer();
      openSockets.push(ws);
      if (dropConnections) {
        // Reconnect attempt during the simulated outage: refuse it.
        ws.close({ code: 1006, reason: "simulated outage" });
      }
    });

    await page.goto(SETTINGS_PATH, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Settings" }).first()).toBeVisible();
  });

  test("severing the realtime socket flips the indicator to Reconnecting and back to Live", async ({ page }) => {
    const status = indicator(page);
    await expect(status).toContainText(/Live/i, { timeout: 20_000 });

    // Simulate a dropped realtime connection (one refused retry, then recovery).
    dropConnections = true;
    const beforeDrop = handshakes.length;
    openSockets.forEach((ws) => ws.close({ code: 1006, reason: "simulated outage" }));

    await expect(status).toContainText(/Reconnecting|Connecting/i, { timeout: 20_000 });
    await expect
      .poll(() => handshakes.length, { timeout: 20_000 })
      .toBeGreaterThan(beforeDrop);

    // Outage over — the next attempt is allowed through and the badge goes Live again.
    dropConnections = false;
    await expect(status).toContainText(/Live/i, { timeout: 40_000 });

    // The rest of the page is unaffected by the outage.
    await expect(page.getByRole("heading", { name: "Automations in Advanced" })).toBeVisible();
  });

  test("repeated failures back off exponentially and count the attempts in the indicator", async ({ page }) => {
    const status = indicator(page);
    await expect(status).toContainText(/Live/i, { timeout: 20_000 });

    const watcher = await watchIndicator(page);

    // Keep every reconnect attempt failing so the backoff ladder is observable.
    dropConnections = true;
    openSockets.forEach((ws) => ws.close({ code: 1006, reason: "simulated outage" }));

    // Wait until the 4th attempt is announced (1s + 2s + 4s ladder ≈ 7s).
    // By then the indicator has escalated from Reconnecting to Disconnected.
    await expect(status).toContainText(/Disconnected \(try 4\)/i, { timeout: 45_000 });
    await watcher.stop();

    // Attempt numbers are surfaced to the user in order.
    const attemptSamples = watcher.samples.filter((s) => /Reconnecting|Disconnected/i.test(s.text));
    expect(attemptSamples.length).toBeGreaterThanOrEqual(3);
    const attemptNumbers = attemptSamples.map((s) => Number(/try (\d+)/i.exec(s.text)?.[1] ?? 1));
    for (let i = 1; i < attemptNumbers.length; i += 1) {
      expect(attemptNumbers[i]!).toBeGreaterThanOrEqual(attemptNumbers[i - 1]!);
    }
    expect(Math.max(...attemptNumbers)).toBeGreaterThanOrEqual(4);

    // Gaps between announced attempts grow: ~1s, ~2s, ~4s (allow scheduler slack).
    const firstAt = (n: number) => attemptSamples.find((s) => Number(/try (\d+)/i.exec(s.text)?.[1] ?? 1) === n)?.at;
    const t2 = firstAt(2);
    const t3 = firstAt(3);
    const t4 = firstAt(4);
    expect(t2 && t3 && t4, "expected attempts 2, 3 and 4 to be announced").toBeTruthy();
    const gap23 = t3! - t2!;
    const gap34 = t4! - t3!;
    expect(gap23).toBeGreaterThanOrEqual(1_200);
    expect(gap34).toBeGreaterThanOrEqual(3_000);
    expect(gap34).toBeGreaterThan(gap23);

    // And the indicator recovers once connections are allowed again.
    dropConnections = false;
    await expect(status).toContainText(/Live/i, { timeout: 60_000 });
  });

  test("the indicator is an aria-live status region so screen readers hear the change", async ({ page }) => {
    const status = indicator(page);
    await expect(status).toHaveAttribute("aria-live", "polite");
    await expect(status).toHaveAttribute("aria-atomic", "true");
    await expect(status).toContainText(/Live/i, { timeout: 20_000 });

    dropConnections = true;
    openSockets.forEach((ws) => ws.close({ code: 1006, reason: "simulated outage" }));
    await expect(status).toContainText(/Reconnecting|Connecting/i, { timeout: 20_000 });
    // Same node stays mounted (announcement, not a remount).
    await expect(status).toHaveAttribute("role", "status");

    dropConnections = false;
    await expect(status).toContainText(/Live/i, { timeout: 40_000 });
  });
});
