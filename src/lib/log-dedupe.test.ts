/**
 * Backend dedupe guard for the Activity log ingestion path.
 *
 * Verifies that rows carrying a dedupe_key are written idempotently (upsert with
 * ignoreDuplicates against the partial unique index), that a redelivery resolves
 * to the original row id instead of creating a second row, and that ordinary
 * app-generated rows with no key keep using a plain insert.
 */
import { describe, expect, it, vi } from "vitest";
import { insertLog, insertLogReturningId, LogAction } from "./log-action-types";
import { logDedupeKey, hasDedupeKey, LOG_DEDUPE_CONFLICT_TARGET } from "./log-dedupe";

/** Fake client backed by an in-memory table that enforces (user_id, dedupe_key). */
function makeClient() {
  const rows: Record<string, unknown>[] = [];
  let seq = 0;
  const insertCalls: unknown[] = [];
  const upsertCalls: { rows: unknown; options: unknown }[] = [];

  const write = (input: unknown, dedupe: boolean) => {
    const list = Array.isArray(input) ? input : [input];
    const written: Record<string, unknown>[] = [];
    for (const row of list as Record<string, unknown>[]) {
      const key = row["dedupe_key"];
      if (dedupe && typeof key === "string" && key) {
        const clash = rows.find((r) => r["user_id"] === row["user_id"] && r["dedupe_key"] === key);
        if (clash) continue; // ignoreDuplicates: collision is a silent no-op
      }
      const stored = { ...row, id: `log-${++seq}` };
      rows.push(stored);
      written.push(stored);
    }
    return written;
  };

  const client = {
    from: (_table: "logs") => ({
      insert: (input: unknown) => {
        insertCalls.push(input);
        const written = write(input, false);
        return {
          error: null,
          select: (_cols: string) => ({
            maybeSingle: async () => ({ data: written[0] ?? null, error: null }),
          }),
        };
      },
      upsert: (input: unknown, options: unknown) => {
        upsertCalls.push({ rows: input, options });
        const written = write(input, true);
        const result = {
          error: null,
          select: (_cols: string) => ({
            maybeSingle: async () => ({ data: written[0] ?? null, error: null }),
          }),
          // Awaited directly by insertLog for the array case.
          then: (resolve: (v: { error: null }) => unknown) => resolve({ error: null }),
        };
        return result;
      },
      select: (_cols: string) => {
        const filters: Record<string, unknown> = {};
        const builder = {
          eq: (col: string, val: unknown) => {
            filters[col] = val;
            return builder;
          },
          maybeSingle: async () => ({
            data:
              rows.find((r) => Object.entries(filters).every(([k, v]) => r[k] === v)) ?? null,
            error: null,
          }),
        };
        return builder;
      },
    }),
  };
  return { client, rows, insertCalls, upsertCalls };
}

const KEY = logDedupeKey("voice:CA123:completed", LogAction.missed_call_autotext)!;

function autotextRow(overrides: Record<string, unknown> = {}) {
  return {
    user_id: "biz-1",
    action_type: LogAction.missed_call_autotext,
    status: "sent",
    message_sent: "Sorry we missed you",
    dedupe_key: KEY,
    ...overrides,
  } as never;
}

describe("logDedupeKey", () => {
  it("composes provider key, action type, and discriminator", () => {
    expect(logDedupeKey("sms:SM1", LogAction.sms_inbound)).toBe("sms:SM1|sms_inbound");
    expect(logDedupeKey("sms:SM1", LogAction.sms_inbound, "opted_in")).toBe(
      "sms:SM1|sms_inbound|opted_in",
    );
  });

  it("returns undefined without a stable provider id, so the row is not deduped", () => {
    expect(logDedupeKey(null, LogAction.sms_inbound)).toBeUndefined();
    expect(logDedupeKey("", LogAction.sms_inbound)).toBeUndefined();
    expect(logDedupeKey("   ", LogAction.sms_inbound)).toBeUndefined();
  });

  it("distinguishes rows written by the same delivery", () => {
    const a = logDedupeKey("voice:CA1:completed", LogAction.missed_call_autotext);
    const b = logDedupeKey("voice:CA1:completed", LogAction.missed_call_excluded);
    expect(a).not.toBe(b);
  });

  it("only treats a non-empty string key as dedupable", () => {
    expect(hasDedupeKey({ dedupe_key: "k" })).toBe(true);
    expect(hasDedupeKey({ dedupe_key: "" })).toBe(false);
    expect(hasDedupeKey({ dedupe_key: null })).toBe(false);
    expect(hasDedupeKey({})).toBe(false);
  });
});

describe("insertLog dedupe guard", () => {
  it("routes keyed rows through an idempotent upsert on (user_id, dedupe_key)", async () => {
    const { client, upsertCalls, insertCalls } = makeClient();
    await insertLog(client as never, autotextRow());
    expect(insertCalls).toHaveLength(0);
    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0]!.options).toEqual({
      onConflict: LOG_DEDUPE_CONFLICT_TARGET,
      ignoreDuplicates: true,
    });
  });

  it("a redelivered event does not create a second row", async () => {
    const { client, rows } = makeClient();
    await insertLog(client as never, autotextRow());
    await insertLog(client as never, autotextRow());
    await insertLog(client as never, autotextRow());
    expect(rows).toHaveLength(1);
  });

  it("keeps rows for different businesses that share a delivery key", async () => {
    const { client, rows } = makeClient();
    await insertLog(client as never, autotextRow({ user_id: "biz-1" }));
    await insertLog(client as never, autotextRow({ user_id: "biz-2" }));
    expect(rows).toHaveLength(2);
  });

  it("still inserts unkeyed app-generated rows without deduping them", async () => {
    const { client, rows, insertCalls, upsertCalls } = makeClient();
    const row = { user_id: "biz-1", action_type: LogAction.status_refresh, status: "ok" } as never;
    await insertLog(client as never, row);
    await insertLog(client as never, row);
    expect(upsertCalls).toHaveLength(0);
    expect(insertCalls).toHaveLength(2);
    expect(rows).toHaveLength(2);
  });

  it("still blocks an invalid action_type before any write", async () => {
    const { client, rows } = makeClient();
    const res = (await insertLog(client as never, {
      user_id: "biz-1",
      action_type: "not_a_real_type",
      dedupe_key: "k",
    } as never)) as { error: { code?: string } | null };
    expect(res.error).toBeTruthy();
    expect(rows).toHaveLength(0);
  });
});

describe("insertLogReturningId dedupe guard", () => {
  it("returns the new id on first delivery", async () => {
    const { client } = makeClient();
    const { id, error } = await insertLogReturningId(client as never, autotextRow());
    expect(error).toBeNull();
    expect(id).toBe("log-1");
  });

  it("resolves a redelivery to the original row id instead of null", async () => {
    const { client, rows } = makeClient();
    const first = await insertLogReturningId(client as never, autotextRow());
    const retry = await insertLogReturningId(client as never, autotextRow());
    expect(rows).toHaveLength(1);
    expect(retry.id).toBe(first.id);
    expect(retry.error).toBeNull();
  });

  it("falls back to a plain insert when the client cannot upsert", async () => {
    const inserted: unknown[] = [];
    const legacy = {
      from: () => ({
        insert: (row: unknown) => {
          inserted.push(row);
          return { select: () => ({ maybeSingle: async () => ({ data: { id: "x" }, error: null }) }) };
        },
      }),
    };
    const { id } = await insertLogReturningId(legacy as never, autotextRow());
    expect(id).toBe("x");
    expect(inserted).toHaveLength(1);
  });

  it("does not throw when the dedupe lookup itself fails", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = {
      from: () => ({
        insert: () => ({ select: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
        upsert: () => ({
          select: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
        }),
        select: () => {
          throw new Error("network down");
        },
      }),
    };
    const { id, error } = await insertLogReturningId(broken as never, autotextRow());
    expect(id).toBeNull();
    expect(error).toBeNull();
    spy.mockRestore();
  });
});
