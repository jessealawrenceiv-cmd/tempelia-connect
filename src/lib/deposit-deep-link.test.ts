import { describe, expect, it } from "vitest";
import {
  parseDepositDeepLink,
  parseDepositEventHash,
  resolveDepositJump,
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
