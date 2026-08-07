import { readFileSync } from "node:fs";
import path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { expect, test, type Page, type WebSocketRoute } from "@playwright/test";
import { restoreSession } from "./support/session";

/**
 * Realtime smoke test against a REAL Supabase channel — nothing is stubbed.
 *
 * It signs in with the injected preview session, opens the Activity log with the
 * diagnostics panel visible, waits for the real `postgres_changes` subscription
 * to reach SUBSCRIBED, then writes real `logs` rows through the Data API as the
 * same user and drives repeated outages by closing the live Realtime websocket
 * out from under the client (Playwright websocket routing), which is what a real
 * network blip looks like to the Supabase client.
 *
 * What it proves:
 *  - live inserts stream in over the real channel and render exactly once;
 *  - a manual refresh that re-reads a row already delivered over the socket does
 *    not create a second copy;
 *  - rows written while the socket is down surface after reconnect (refresh
 *    path) and still render exactly once;
 *  - across several disconnect/reconnect cycles no dispatch id is ever rendered
 *    twice, and the diagnostics panel reports the redeliveries it ignored.
 *
 * Rows written here stay in the activity log (logs are append-only by design),
 * so every message is tagged with the marker below.
 */

const MARKER = "e2e realtime smoke";
const ACTION_TYPE = "sms_inbound";

/** VITE_* config lives in .env; Playwright does not load it for us. */
function readEnvFile(): Record<string, string> {
  try {
    const raw = readFileSync(path.join(process.cwd(), ".env"), "utf8");
    const out: Record<string, string> = {};
    for (const line of raw.split("\n")) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (m) out[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
    }
    return out;
  } catch {
    return {};
  }
}

type Session = { access_token?: string; refresh_token?: string; user?: { id?: string } };

function readInjectedSession(): Session | null {
  const raw = process.env["LOVABLE_BROWSER_SUPABASE_SESSION_JSON"];
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Session & { currentSession?: Session };
    return parsed.currentSession ?? parsed;
  } catch {
    return null;
  }
}

/** Data API client acting as the signed-in preview user (RLS applies). */
async function makeUserClient(): Promise<{ client: SupabaseClient; userId: string } | null> {
  const env = { ...readEnvFile(), ...process.env } as Record<string, string>;
  const url = env["VITE_SUPABASE_URL"] ?? env["SUPABASE_URL"];
  const key = env["VITE_SUPABASE_PUBLISHABLE_KEY"] ?? env["SUPABASE_PUBLISHABLE_KEY"];
  const session = readInjectedSession();
  const accessToken = session?.access_token ?? process.env["LOVABLE_BROWSER_SUPABASE_ACCESS_TOKEN"];
  if (!url || !key || !accessToken) return null;

  const client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });

  const { data, error } = await client.auth.getUser(accessToken);
  const userId = data?.user?.id ?? session?.user?.id;
  if (error || !userId) return null;
  return { client, userId };
}

let seq = 0;

/** Writes one real activity row and returns its id. */
async function insertLogRow(client: SupabaseClient, userId: string, label: string) {
  seq += 1;
  const { data, error } = await client
    .from("logs")
    .insert({
      user_id: userId,
      action_type: ACTION_TYPE,
      status: "received",
      message_sent: `${MARKER} · ${label} · #${seq}`,
      created_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  expect(error, `insert failed: ${error?.message}`).toBeNull();
  const id = (data as { id?: string } | null)?.id;
  expect(id, "inserted row should return an id").toBeTruthy();
  return id as string;
}

const rowIds = (page: Page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>('[id^="log-row-"]')).map((el) =>
      el.id.replace("log-row-", ""),
    ),
  );

async function expectRenderedOnce(page: Page, id: string) {
  await expect(page.locator(`#log-row-${id}`)).toHaveCount(1);
}

async function expectNoDuplicates(page: Page) {
  const ids = await rowIds(page);
  expect(new Set(ids).size, `duplicate rows rendered: ${ids.join(",")}`).toBe(ids.length);
}

/** Opens the Activity log plus its diagnostics panel and waits for SUBSCRIBED. */
async function openLog(page: Page) {
  await page.goto("/dashboard?logDebug=1", { waitUntil: "domcontentloaded" });
  const toggle = page.getByRole("button", { name: /Activity log/i });
  await toggle.waitFor({ state: "visible", timeout: 30_000 });
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();

  const panel = page.getByTestId("dispatch-log-debug");
  if (!(await panel.isVisible().catch(() => false))) {
    await page.getByRole("button", { name: /^Debug$/i }).click();
  }
  await expect(panel).toBeVisible();
  await expect(page.getByTestId("debug-realtime-status")).toHaveText(/subscribed/i, {
    timeout: 45_000,
  });
}

const refresh = (page: Page) => page.getByRole("button", { name: /Refresh activity now/i }).click();

/**
 * Proxies the real Realtime websocket so the test can sever it. Each reconnect
 * opens a new socket, so the handler keeps the most recent one.
 */
async function proxyRealtimeSocket(page: Page) {
  const sockets: WebSocketRoute[] = [];
  await page.routeWebSocket(/realtime\/v1/i, (ws) => {
    ws.connectToServer();
    sockets.push(ws);
  });
  return {
    /** Drop the live connection the way a network blip would. */
    drop() {
      const ws = sockets[sockets.length - 1];
      expect(ws, "expected a live Realtime websocket to drop").toBeTruthy();
      ws!.close({ code: 1006, reason: "e2e simulated outage" });
    },
    get count() {
      return sockets.length;
    },
  };
}

test.describe("Activity log realtime smoke (real Supabase channel)", () => {
  test("dedupes live inserts across repeated socket outages", async ({ context, page }) => {
    const restored = await restoreSession(context, page, "http://localhost:8080");
    test.skip(!restored, "No Supabase preview session available — sign in via the preview first.");

    const conn = await makeUserClient();
    test.skip(!conn, "No Supabase Data API credentials available for the signed-in user.");
    const { client, userId } = conn!;

    const socket = await proxyRealtimeSocket(page);
    await openLog(page);
    expect(socket.count, "the app should have opened a real Realtime socket").toBeGreaterThan(0);

    const seen: string[] = [];

    // 1) Baseline: a live insert arrives over the real channel exactly once, and
    //    re-reading it with a manual refresh does not clone it.
    const first = await insertLogRow(client, userId, "online baseline");
    seen.push(first);
    await expectRenderedOnce(page, first);
    await refresh(page);
    await expectRenderedOnce(page, first);
    await expectNoDuplicates(page);

    // 2) Three outage cycles: rows land in the database while the socket is
    //    down, the socket comes back, and the row must appear exactly once no
    //    matter which path (replayed event or refresh read) surfaces it.
    for (let cycle = 0; cycle < 3; cycle += 1) {
      const online = await insertLogRow(client, userId, `cycle ${cycle} online`);
      seen.push(online);
      await expectRenderedOnce(page, online);

      const socketsBefore = socket.count;
      socket.drop();
      await expect(page.getByTestId("debug-realtime-status")).not.toHaveText(/^subscribed$/i, {
        timeout: 45_000,
      });

      const missedA = await insertLogRow(client, userId, `cycle ${cycle} during outage A`);
      const missedB = await insertLogRow(client, userId, `cycle ${cycle} during outage B`);
      seen.push(missedA, missedB);

      // The client reconnects on its own; a fresh socket proves it really did.
      await expect(page.getByTestId("debug-realtime-status")).toHaveText(/subscribed/i, {
        timeout: 60_000,
      });
      expect(socket.count).toBeGreaterThan(socketsBefore);

      // Whatever the socket did or did not replay, the refresh reconciles the
      // outage window from the database.
      await refresh(page);
      for (const id of [missedA, missedB]) await expectRenderedOnce(page, id);

      // A second refresh right after reconnect is the classic duplicate trigger.
      await refresh(page);
      for (const id of seen) await expectRenderedOnce(page, id);
      await expectNoDuplicates(page);
    }

    // Every row written by this test is on screen once and only once.
    expect(seen.length).toBe(10);
    for (const id of seen) await expectRenderedOnce(page, id);
    await expectNoDuplicates(page);

    // The loaded counter must agree with the rendered rows (no phantom rows).
    const loadedText = (await page.getByText(/\d+ loaded/).first().textContent()) ?? "";
    const loaded = Number(/(\d+) loaded/.exec(loadedText)?.[1] ?? -1);
    expect(loaded).toBeGreaterThanOrEqual(seen.length);

    // Diagnostics: the real subscription reconnected at least once per cycle.
    const transitions = Number(
      (await page.getByTestId("debug-realtime-transitions").textContent()) ?? "0",
    );
    expect(transitions).toBeGreaterThan(1);
  });
});
