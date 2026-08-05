import { describe, expect, it } from "vitest";
import {
  MISS_SESSION_TTL_MS,
  clearMissSession,
  peekRetry,
  readMissSession,
  recordMiss,
  resolveRetry,
} from "@/lib/deposit-jump-retry";

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

describe("deposit jump retry sessions", () => {
  it("opens a session on the first miss with attempt index 0", () => {
    const s = memoryStorage();
    const r = recordMiss(s, {
      quoteId: "q1",
      eventId: "e1",
      reason: "filtered",
      correlationId: "djp-1",
      now: 1000,
    });
    expect(r.attemptIndex).toBe(0);
    expect(r.isRetry).toBe(false);
    expect(r.msSinceFirstMiss).toBe(0);
  });

  it("counts later misses as retries and keeps the original correlation id", () => {
    const s = memoryStorage();
    recordMiss(s, { quoteId: "q1", eventId: "e1", reason: "filtered", correlationId: "djp-1", now: 1000 });
    const second = recordMiss(s, {
      quoteId: "q1",
      eventId: "e2",
      reason: "missing",
      correlationId: "djp-2",
      now: 4000,
    });
    expect(second.attemptIndex).toBe(1);
    expect(second.isRetry).toBe(true);
    expect(second.msSinceFirstMiss).toBe(3000);
    expect(second.session.correlationId).toBe("djp-1");
    expect(second.session.firstEventId).toBe("e1");
  });

  it("peekRetry reports the next attempt index without consuming the session", () => {
    const s = memoryStorage();
    recordMiss(s, { quoteId: "q1", eventId: "e1", reason: "empty", correlationId: "djp-1", now: 1000 });
    const peek = peekRetry(s, "q1", 2500);
    expect(peek?.attemptIndex).toBe(1);
    expect(peek?.msSinceFirstMiss).toBe(1500);
    expect(readMissSession(s, "q1", 2500)).not.toBeNull();
  });

  it("returns null when no session is open", () => {
    const s = memoryStorage();
    expect(peekRetry(s, "q1")).toBeNull();
    expect(resolveRetry(s, "q1")).toBeNull();
  });

  it("resolveRetry reports the landing attempt and closes the session", () => {
    const s = memoryStorage();
    recordMiss(s, { quoteId: "q1", eventId: "e1", reason: "filtered", correlationId: "djp-1", now: 1000 });
    const resolved = resolveRetry(s, "q1", 6000);
    expect(resolved).toEqual({ attemptIndex: 1, msSinceFirstMiss: 5000, correlationId: "djp-1" });
    expect(readMissSession(s, "q1", 6000)).toBeNull();
  });

  it("treats stale sessions as expired", () => {
    const s = memoryStorage();
    recordMiss(s, { quoteId: "q1", eventId: "e1", reason: "filtered", correlationId: "djp-1", now: 1000 });
    expect(readMissSession(s, "q1", 1000 + MISS_SESSION_TTL_MS + 1)).toBeNull();
    const fresh = recordMiss(s, {
      quoteId: "q1",
      eventId: "e1",
      reason: "filtered",
      correlationId: "djp-9",
      now: 1000 + MISS_SESSION_TTL_MS + 2,
    });
    expect(fresh.attemptIndex).toBe(0);
    expect(fresh.session.correlationId).toBe("djp-9");
  });

  it("scopes sessions per quote and clears cleanly", () => {
    const s = memoryStorage();
    recordMiss(s, { quoteId: "q1", eventId: "e1", reason: "filtered", correlationId: "djp-1", now: 1000 });
    expect(peekRetry(s, "q2", 1000)).toBeNull();
    clearMissSession(s, "q1");
    expect(readMissSession(s, "q1", 1000)).toBeNull();
  });

  it("survives malformed stored data", () => {
    const s = memoryStorage();
    s.setItem("temaro:deposit-jump-miss:q1", "{not json");
    expect(readMissSession(s, "q1")).toBeNull();
  });
});
