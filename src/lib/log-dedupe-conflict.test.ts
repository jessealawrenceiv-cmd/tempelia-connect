/**
 * Conflicting-redelivery guard: the same dedupe_key arriving with different
 * payload fields must be refused with a clear error and recorded, never silently
 * dropped or upserted over the stored audit row.
 */
import { describe, expect, it } from "vitest";
import { insertLog, insertLogReturningId, LogAction, isDedupeConflictError } from "./log-action-types";
import { diffDedupeRow, DEDUPE_CONFLICT_CODE } from "./log-dedupe-conflict";

type Row = Record<string, unknown>;

/** In-memory logs table enforcing (user_id, dedupe_key), plus a rejections table. */
function makeClient(seed: Row[] = []) {
  const rows: Row[] = seed.map((r, i) => ({ id: `seed-${i + 1}`, ...r }));
  const rejections: Row[] = [];
  let seq = 0;

  const selectBuilder = (table: Row[]) => {
    const filters: [string, unknown][] = [];
    const builder: Record<string, unknown> = {
      eq: (col: string, val: unknown) => {
        filters.push([col, val]);
        return builder;
      },
      maybeSingle: async () => {
        const found = table.find((r) => filters.every(([c, v]) => r[c] === v)) ?? null;
        return { data: found, error: null };
      },
    };
    return builder as { eq: (c: string, v: unknown) => typeof builder; maybeSingle: () => Promise<{ data: Row | null; error: null }> };
  };

  const client = {
    from: (table: string) => {
      if (table === "log_write_rejections") {
        return {
          insert: async (input: Row) => {
            rejections.push(input);
            return { error: null };
          },
        };
      }
      return {
        select: () => selectBuilder(rows),
        insert: (input: Row | Row[]) => {
          const list = Array.isArray(input) ? input : [input];
          const written = list.map((r) => {
            const stored = { ...r, id: `log-${++seq}` };
            rows.push(stored);
            return stored;
          });
          const res = { error: null as null, data: written };
          return Object.assign(Promise.resolve(res), {
            select: () => ({ maybeSingle: async () => ({ data: written[0] ?? null, error: null }) }),
          });
        },
        upsert: (input: Row | Row[]) => {
          const list = Array.isArray(input) ? input : [input];
          const written: Row[] = [];
          for (const r of list) {
            const clash = rows.find(
              (x) => x["user_id"] === r["user_id"] && x["dedupe_key"] === r["dedupe_key"],
            );
            if (clash) continue;
            const stored = { ...r, id: `log-${++seq}` };
            rows.push(stored);
            written.push(stored);
          }
          const res = { error: null as null, data: written };
          return Object.assign(Promise.resolve(res), {
            select: () => ({ maybeSingle: async () => ({ data: written[0] ?? null, error: null }) }),
          });
        },
      };
    },
  };

  return { client, rows, rejections };
}

const base = {
  user_id: "user-1",
  action_type: LogAction.sms_inbound,
  status: "received",
  message_sent: "YES",
  dedupe_key: "SM123|sms_inbound",
};

describe("diffDedupeRow", () => {
  it("reports no conflict for a faithful redelivery", () => {
    expect(diffDedupeRow({ ...base, id: "log-1" }, { ...base })).toEqual([]);
  });

  it("ignores cosmetic whitespace and absent fields", () => {
    expect(diffDedupeRow({ ...base, id: "l" }, { ...base, message_sent: " YES " })).toEqual([]);
    expect(diffDedupeRow({ ...base, id: "l" }, { user_id: "user-1", action_type: base.action_type })).toEqual([]);
  });

  it("treats filling in an empty stored field as enrichment, not conflict", () => {
    const stored = { ...base, id: "l", voicemail_url: null };
    expect(diffDedupeRow(stored, { ...base, voicemail_url: "https://x/rec.mp3" })).toEqual([]);
  });

  it("flags every field that disagrees", () => {
    const stored = { ...base, id: "l", customer_id: "c-1" };
    const conflicts = diffDedupeRow(stored, { ...base, customer_id: "c-2", status: "opted_out" });
    expect(conflicts.map((c) => c.field).sort()).toEqual(["customer_id", "status"]);
  });
});

describe("insertLog dedupe conflict guard", () => {
  it("still upserts idempotently for an identical redelivery", async () => {
    const { client, rows, rejections } = makeClient([{ ...base }]);
    const res = (await insertLog(client as never, { ...base })) as { error: unknown };
    expect(res.error).toBeNull();
    expect(rows).toHaveLength(1);
    expect(rejections).toHaveLength(0);
  });

  it("refuses a conflicting payload and leaves the stored row untouched", async () => {
    const { client, rows, rejections } = makeClient([{ ...base, customer_id: "c-1" }]);
    const res = (await insertLog(client as never, {
      ...base,
      customer_id: "c-2",
      message_sent: "STOP",
    })) as { error: unknown };

    expect(isDedupeConflictError(res.error)).toBe(true);
    const err = res.error as { code: string; message: string; details: string; conflicts: { field: string }[] };
    expect(err.code).toBe(DEDUPE_CONFLICT_CODE);
    expect(err.message).toContain(base.dedupe_key);
    expect(err.conflicts.map((c) => c.field).sort()).toEqual(["customer_id", "message_sent"]);
    expect(err.details).toContain("stored=");

    expect(rows).toHaveLength(1);
    expect(rows[0]!["customer_id"]).toBe("c-1");
    expect(rejections).toHaveLength(1);
    expect(rejections[0]!["blocked_at"]).toBe("dedupe_conflict_guard");
    expect(rejections[0]!["error_code"]).toBe(DEDUPE_CONFLICT_CODE);
  });

  it("refuses the batch when any keyed row conflicts", async () => {
    const { client, rows } = makeClient([{ ...base }]);
    const res = (await insertLog(client as never, [
      { ...base, dedupe_key: "SM999|sms_inbound" },
      { ...base, status: "opted_out" },
    ])) as { error: unknown };
    expect(isDedupeConflictError(res.error)).toBe(true);
    expect(rows).toHaveLength(1); // nothing written
  });

  it("leaves unkeyed rows alone", async () => {
    const { client, rows } = makeClient();
    const { dedupe_key: _k, ...unkeyed } = base;
    await insertLog(client as never, unkeyed);
    await insertLog(client as never, unkeyed);
    expect(rows).toHaveLength(2);
  });
});

describe("insertLogReturningId dedupe conflict guard", () => {
  it("returns the original id for an identical redelivery", async () => {
    const { client } = makeClient([{ ...base }]);
    const res = await insertLogReturningId(client as never, { ...base });
    expect(res.error).toBeNull();
    expect(res.id).toBe("seed-1");
  });

  it("returns the conflict error plus the existing row id", async () => {
    const { client, rows, rejections } = makeClient([{ ...base }]);
    const res = await insertLogReturningId(client as never, { ...base, status: "failed" });
    expect(isDedupeConflictError(res.error)).toBe(true);
    expect(res.id).toBe("seed-1");
    expect(rows).toHaveLength(1);
    expect(rejections).toHaveLength(1);
  });
});
