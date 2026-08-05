/**
 * Deep-link parsing for the deposit status timeline.
 *
 * A shared deposit-row link can carry the target event in three places:
 *   ?eventId=<uuid>        canonical param
 *   ?depositEvent=<uuid>   legacy / alias param
 *   #deposit-event-<uuid>  hash anchor (works without JS on the print view)
 *
 * Precedence: eventId > depositEvent > hash. Blank / whitespace-only values are
 * ignored so `?eventId=` never triggers a jump-miss banner.
 */

export const DEPOSIT_EVENT_HASH_PREFIX = "deposit-event-";

export type DepositDeepLink = {
  /** The event id to jump to, or null when the link carries none. */
  eventId: string | null;
  /** Which location the id came from — useful for diagnostics/tests. */
  source: "eventId" | "depositEvent" | "hash" | null;
};

function clean(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let value = raw.trim();
  if (value === "") return null;
  // URLSearchParams already decodes, but hashes and hand-built links may not.
  if (value.includes("%")) {
    try {
      value = decodeURIComponent(value).trim();
    } catch {
      // Leave the raw value alone on malformed escapes.
    }
  }
  return value === "" ? null : value;
}

/** Extract the event id from a hash such as `#deposit-event-abc` or `deposit-event-abc`. */
export function parseDepositEventHash(hash: string | null | undefined): string | null {
  const value = clean(hash);
  if (!value) return null;
  const withoutHash = value.startsWith("#") ? value.slice(1) : value;
  if (!withoutHash.startsWith(DEPOSIT_EVENT_HASH_PREFIX)) return null;
  return clean(withoutHash.slice(DEPOSIT_EVENT_HASH_PREFIX.length));
}

/**
 * Parse a deposit deep link from a query string (with or without `?`) and a hash
 * (with or without `#`).
 */
export function parseDepositDeepLink(
  searchStr: string | null | undefined,
  hash: string | null | undefined,
): DepositDeepLink {
  const params = new URLSearchParams((searchStr ?? "").replace(/^\?/, ""));

  const fromEventId = clean(params.get("eventId"));
  if (fromEventId) return { eventId: fromEventId, source: "eventId" };

  const fromDepositEvent = clean(params.get("depositEvent"));
  if (fromDepositEvent) return { eventId: fromDepositEvent, source: "depositEvent" };

  const fromHash = parseDepositEventHash(hash);
  if (fromHash) return { eventId: fromHash, source: "hash" };

  return { eventId: null, source: null };
}

export type DepositJumpMissReason = "filtered" | "missing" | "empty";

export type DepositJumpResolution =
  | { kind: "hit"; index: number }
  | { kind: "miss"; reason: DepositJumpMissReason; fallbackIndex: number };

/**
 * Resolve a deep-linked event id against the visible (filtered) rows.
 *
 * - hit: the row is visible; jump to it.
 * - miss "empty": there are no audit events at all.
 * - miss "filtered": the event exists but the active filters hide it.
 * - miss "missing": the event does not belong to this quote / no longer exists.
 *
 * Misses always fall back to index 0 (most recent visible entry) so the reader
 * lands somewhere sensible instead of nowhere.
 */
export function resolveDepositJump(
  eventId: string,
  visibleIds: readonly string[],
  allIds: readonly string[],
): DepositJumpResolution {
  const index = visibleIds.indexOf(eventId);
  if (index >= 0) return { kind: "hit", index };

  const reason: DepositJumpMissReason =
    allIds.length === 0 ? "empty" : allIds.includes(eventId) ? "filtered" : "missing";

  return { kind: "miss", reason, fallbackIndex: 0 };
}
