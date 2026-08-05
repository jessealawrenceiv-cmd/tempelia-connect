import { describe, expect, it } from "vitest";
import {
  parseDepositDeepLink,
  parseDepositEventHash,
  resolveDepositJump,
  consumeDepositJump,
  depositJumpKey,
} from "@/lib/deposit-deep-link";

describe("parseDepositDeepLink", () => {
  it("reads eventId from the query string", () => {
    expect(parseDepositDeepLink("?eventId=abc", "")).toEqual({
      eventId: "abc",
      source: "eventId",
    });
  });

  it("works without the leading question mark", () => {
    expect(parseDepositDeepLink("eventId=abc", "")).toEqual({
      eventId: "abc",
      source: "eventId",
    });
  });

  it("falls back to depositEvent when eventId is absent", () => {
    expect(parseDepositDeepLink("?depositEvent=xyz", "")).toEqual({
      eventId: "xyz",
      source: "depositEvent",
    });
  });

  it("prefers eventId over depositEvent when both are present", () => {
    expect(parseDepositDeepLink("?depositEvent=old&eventId=new", "").eventId).toBe("new");
  });

  it("ignores blank params and uses the hash instead", () => {
    expect(parseDepositDeepLink("?eventId=&depositEvent=%20", "#deposit-event-hashed")).toEqual({
      eventId: "hashed",
      source: "hash",
    });
  });

  it("accepts a hash with or without the # prefix", () => {
    expect(parseDepositDeepLink("", "#deposit-event-a1").eventId).toBe("a1");
    expect(parseDepositDeepLink("", "deposit-event-a1").eventId).toBe("a1");
  });

  it("decodes url-encoded ids", () => {
    expect(parseDepositDeepLink("?eventId=a%2Db", "").eventId).toBe("a-b");
    expect(parseDepositEventHash("#deposit-event-a%2Db")).toBe("a-b");
  });

  it("returns null when nothing matches", () => {
    expect(parseDepositDeepLink("?other=1", "#some-other-anchor")).toEqual({
      eventId: null,
      source: null,
    });
    expect(parseDepositDeepLink(undefined, undefined).eventId).toBeNull();
  });

  it("ignores unrelated hashes and empty hash suffixes", () => {
    expect(parseDepositEventHash("#deposit-event-")).toBeNull();
    expect(parseDepositEventHash("#quote-123")).toBeNull();
  });
});

describe("resolveDepositJump", () => {
  it("hits a visible row", () => {
    expect(resolveDepositJump("b", ["a", "b", "c"], ["a", "b", "c"])).toEqual({
      kind: "hit",
      index: 1,
    });
  });

  it("reports empty when there are no events", () => {
    expect(resolveDepositJump("a", [], [])).toEqual({
      kind: "miss",
      reason: "empty",
      fallbackIndex: 0,
    });
  });

  it("reports filtered when the event exists but is hidden", () => {
    expect(resolveDepositJump("c", ["a"], ["a", "c"])).toEqual({
      kind: "miss",
      reason: "filtered",
      fallbackIndex: 0,
    });
  });

  it("reports missing when the event is unknown", () => {
    expect(resolveDepositJump("zz", ["a"], ["a"])).toEqual({
      kind: "miss",
      reason: "missing",
      fallbackIndex: 0,
    });
  });
});

describe("consumeDepositJump", () => {
  function fakeStorage() {
    const map = new Map<string, string>();
    return {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
    };
  }

  it("allows the first jump and blocks repeats for the same link", () => {
    const s = fakeStorage();
    expect(consumeDepositJump(s, "/dashboard/quotes/1", "evt")).toBe(true);
    expect(consumeDepositJump(s, "/dashboard/quotes/1", "evt")).toBe(false);
    expect(consumeDepositJump(s, "/dashboard/quotes/1", "evt")).toBe(false);
  });

  it("tracks links per route and per event", () => {
    const s = fakeStorage();
    expect(consumeDepositJump(s, "/a", "evt")).toBe(true);
    expect(consumeDepositJump(s, "/b", "evt")).toBe(true);
    expect(consumeDepositJump(s, "/a", "other")).toBe(true);
    expect(consumeDepositJump(s, "/a", "evt")).toBe(false);
  });

  it("allows the jump when storage is unavailable or throws", () => {
    expect(consumeDepositJump(null, "/a", "evt")).toBe(true);
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {},
    };
    expect(consumeDepositJump(broken, "/a", "evt")).toBe(true);
  });

  it("builds a namespaced key", () => {
    expect(depositJumpKey("/a", "evt")).toBe("temaro:deposit-jump:/a:evt");
  });
});
