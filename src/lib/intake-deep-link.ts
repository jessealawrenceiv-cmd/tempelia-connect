/**
 * Deep-link parsing for the project intakes list.
 *
 * Mirrors the proven deposit-timeline pattern (see `deposit-deep-link.ts`):
 *   ?intakeId=<uuid>     canonical param
 *   ?intake=<uuid>       alias param
 *   #intake-<uuid>       hash anchor
 *
 * Precedence: intakeId > intake > hash. Blank values never trigger a miss banner.
 */

export const INTAKE_HASH_PREFIX = "intake-";

export type IntakeDeepLink = {
  intakeId: string | null;
  source: "intakeId" | "intake" | "hash" | null;
};

function clean(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let value = raw.trim();
  if (value === "") return null;
  if (value.includes("%")) {
    try {
      value = decodeURIComponent(value).trim();
    } catch {
      // leave raw value on malformed escapes
    }
  }
  return value === "" ? null : value;
}

/** Extract the intake id from a hash such as `#intake-abc` or `intake-abc`. */
export function parseIntakeHash(hash: string | null | undefined): string | null {
  const value = clean(hash);
  if (!value) return null;
  const withoutHash = value.startsWith("#") ? value.slice(1) : value;
  if (!withoutHash.startsWith(INTAKE_HASH_PREFIX)) return null;
  return clean(withoutHash.slice(INTAKE_HASH_PREFIX.length));
}

export function parseIntakeDeepLink(
  searchStr: string | null | undefined,
  hash: string | null | undefined,
): IntakeDeepLink {
  const params = new URLSearchParams((searchStr ?? "").replace(/^\?/, ""));

  const fromIntakeId = clean(params.get("intakeId"));
  if (fromIntakeId) return { intakeId: fromIntakeId, source: "intakeId" };

  const fromIntake = clean(params.get("intake"));
  if (fromIntake) return { intakeId: fromIntake, source: "intake" };

  const fromHash = parseIntakeHash(hash);
  if (fromHash) return { intakeId: fromHash, source: "hash" };

  return { intakeId: null, source: null };
}

export type IntakeJumpMissReason = "filtered" | "missing" | "empty";

export type IntakeJumpResolution =
  | { kind: "hit"; index: number }
  | { kind: "miss"; reason: IntakeJumpMissReason; fallbackIndex: number };

/**
 * Resolve a deep-linked intake id against the visible (filtered) rows.
 * Misses fall back to index 0 (newest submission) so the reader lands somewhere sensible.
 */
export function resolveIntakeJump(
  intakeId: string,
  visibleIds: readonly string[],
  allIds: readonly string[],
): IntakeJumpResolution {
  const index = visibleIds.indexOf(intakeId);
  if (index >= 0) return { kind: "hit", index };

  const reason: IntakeJumpMissReason =
    allIds.length === 0 ? "empty" : allIds.includes(intakeId) ? "filtered" : "missing";

  return { kind: "miss", reason, fallbackIndex: 0 };
}

/** Build the suffix used by links that jump to a specific submission. */
export function intakeDeepLinkHref(intakeId: string, base = "/dashboard/intakes") {
  const id = encodeURIComponent(intakeId);
  return `${base}?intakeId=${id}#${INTAKE_HASH_PREFIX}${id}`;
}
