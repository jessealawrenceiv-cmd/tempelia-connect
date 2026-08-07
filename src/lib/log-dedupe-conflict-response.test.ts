import { describe, expect, it } from "vitest";
import { dedupeConflictError } from "./log-dedupe-conflict";
import {
  DEDUPE_CONFLICT_FIELDS_HEADER,
  DEDUPE_CONFLICT_HEADER,
  DEDUPE_CONFLICT_LOG_HEADER,
  DEDUPE_CONFLICT_STATUS,
  LogDedupeConflictError,
  asDedupeConflict,
  dedupeConflictBody,
  dedupeConflictResponse,
  throwOnDedupeConflict,
} from "./log-dedupe-conflict-response";

const error = () =>
  dedupeConflictError("sms:SM123|sms_inbound", "log-1", [
    { field: "message_sent", existing: "on my way", incoming: "cancel please" },
    { field: "customer_id", existing: "cust-a", incoming: "cust-b" },
  ]);

describe("dedupe conflict responses", () => {
  it("answers 409 with the differing fields in body and headers", async () => {
    const res = dedupeConflictResponse(error(), "json");
    expect(res.status).toBe(DEDUPE_CONFLICT_STATUS);
    expect(res.status).toBe(409);
    expect(res.headers.get(DEDUPE_CONFLICT_HEADER)).toBe("dedupe_key_conflict");
    expect(res.headers.get(DEDUPE_CONFLICT_FIELDS_HEADER)).toBe("message_sent,customer_id");
    expect(res.headers.get(DEDUPE_CONFLICT_LOG_HEADER)).toBe("log-1");

    const body = (await res.json()) as ReturnType<typeof dedupeConflictBody>;
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("dedupe_key_conflict");
    expect(body.error.retryable).toBe(false);
    expect(body.error.dedupe_key).toBe("sms:SM123|sms_inbound");
    expect(body.error.existing_log_id).toBe("log-1");
    expect(body.error.conflict_fields).toEqual(["message_sent", "customer_id"]);
    expect(body.error.conflicts).toEqual([
      { field: "message_sent", stored: "on my way", incoming: "cancel please" },
      { field: "customer_id", stored: "cust-a", incoming: "cust-b" },
    ]);
    expect(body.error.hint).toMatch(/same payload/i);
  });

  it("keeps the same status, code and field list for twiml and text surfaces", async () => {
    for (const format of ["twiml", "text"] as const) {
      const res = dedupeConflictResponse(error(), format);
      expect(res.status).toBe(409);
      expect(res.headers.get(DEDUPE_CONFLICT_HEADER)).toBe("dedupe_key_conflict");
      expect(res.headers.get(DEDUPE_CONFLICT_FIELDS_HEADER)).toBe("message_sent,customer_id");
      const text = await res.text();
      expect(text).toContain("message_sent");
      expect(text).toContain("customer_id");
    }
  });

  it("emits parseable TwiML with the summary in an XML comment", async () => {
    const res = dedupeConflictResponse(error(), "twiml");
    expect(res.headers.get("Content-Type")).toBe("text/xml");
    const xml = await res.text();
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?><Response>')).toBe(true);
    expect(xml.endsWith("</Response>")).toBe(true);
    // No "--" inside the comment, which would make the XML invalid.
    const comment = xml.slice(xml.indexOf("<!--") + 4, xml.indexOf("-->"));
    expect(comment).not.toContain("--");
  });

  it("recognizes a conflict from a bare error, an { error } result, or a cause", () => {
    const conflict = error();
    expect(asDedupeConflict(conflict)).toBe(conflict);
    expect(asDedupeConflict({ error: conflict })).toBe(conflict);
    expect(asDedupeConflict({ cause: conflict })).toBe(conflict);
    expect(asDedupeConflict({ code: "23514" })).toBeNull();
    expect(asDedupeConflict(null)).toBeNull();
    expect(asDedupeConflict(new Error("boom"))).toBeNull();
  });

  it("throws the same shape from server functions", () => {
    expect(() => throwOnDedupeConflict({ error: null })).not.toThrow();
    expect(() => throwOnDedupeConflict({ error: { code: "23514" } })).not.toThrow();

    let thrown: unknown;
    try {
      throwOnDedupeConflict({ error: error() });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(LogDedupeConflictError);
    const err = thrown as LogDedupeConflictError;
    expect(err.code).toBe("dedupe_key_conflict");
    expect(err.status).toBe(409);
    expect(err.retryable).toBe(false);
    expect(err.conflictFields).toEqual(["message_sent", "customer_id"]);
    expect(err.existingLogId).toBe("log-1");
    expect(err.message).toContain("message_sent");
    expect(err.toJSON()).toMatchObject({
      code: "dedupe_key_conflict",
      status: 409,
      conflict_fields: ["message_sent", "customer_id"],
    });
  });
});
