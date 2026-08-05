/**
 * Retry tracking for deposit deep-link jumps.
 *
 * When a deep link misses, we open a short-lived "miss session" in
 * sessionStorage keyed by quote. Every later jump attempt for that quote — a new
 * shared link, a fresh navigation, or a refresh — counts as a retry, so we can
 * report `attempt_index` (0 = the original miss) and the total elapsed time
 * since the first miss. A successful jump closes the session.
 */

export interface DepositMissSession {
  /** Correlation id shared by every event in this retry chain. */
  correlationId: string;
  /** Epoch ms of the original miss. */
  firstMissAt: number;
  /** Event id that originally missed. */
  firstEventId: string;
  /** Reason of the original miss. */
  firstReason: string | null;
  /** Highest attempt index recorded so far (0 = original miss). */
  attemptIndex: number;
}

type SessionStorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function missSessionKey(quoteId: string) {
  return `temaro:deposit-jump-miss:${quoteId}`;
}

/** Sessions older than this are treated as stale and restarted. */
export const MISS_SESSION_TTL_MS = 30 * 60 * 1000;

export function readMissSession(
  storage: SessionStorageLike | null | undefined,
  quoteId: string,
  now: number = Date.now(),
): DepositMissSession | null {
  if (!storage) return null;
  let raw: string | null = null;
  try {
    raw = storage.getItem(missSessionKey(quoteId));
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<DepositMissSession>;
    if (
      typeof parsed?.correlationId !== "string" ||
      typeof parsed?.firstMissAt !== "number" ||
      !Number.isFinite(parsed.firstMissAt)
    ) {
      return null;
    }
    if (now - parsed.firstMissAt > MISS_SESSION_TTL_MS) return null;
    return {
      correlationId: parsed.correlationId,
      firstMissAt: parsed.firstMissAt,
      firstEventId: typeof parsed.firstEventId === "string" ? parsed.firstEventId : "",
      firstReason: typeof parsed.firstReason === "string" ? parsed.firstReason : null,
      attemptIndex:
        typeof parsed.attemptIndex === "number" && Number.isFinite(parsed.attemptIndex)
          ? Math.max(0, Math.round(parsed.attemptIndex))
          : 0,
    };
  } catch {
    return null;
  }
}

function write(
  storage: SessionStorageLike | null | undefined,
  quoteId: string,
  session: DepositMissSession,
) {
  if (!storage) return;
  try {
    storage.setItem(missSessionKey(quoteId), JSON.stringify(session));
  } catch {
    // Private mode / quota: retry tracking is best-effort.
  }
}

export function clearMissSession(
  storage: SessionStorageLike | null | undefined,
  quoteId: string,
) {
  if (!storage) return;
  try {
    storage.removeItem(missSessionKey(quoteId));
  } catch {
    // ignore
  }
}

/**
 * Record a miss. Opens a session on the first miss, or bumps the retry counter
 * when a session already exists. Returns the attempt metadata to report.
 */
export function recordMiss(
  storage: SessionStorageLike | null | undefined,
  input: {
    quoteId: string;
    eventId: string;
    reason: string | null;
    correlationId: string;
    now?: number;
  },
): { session: DepositMissSession; attemptIndex: number; msSinceFirstMiss: number; isRetry: boolean } {
  const now = input.now ?? Date.now();
  const existing = readMissSession(storage, input.quoteId, now);
  const session: DepositMissSession = existing
    ? { ...existing, attemptIndex: existing.attemptIndex + 1 }
    : {
        correlationId: input.correlationId,
        firstMissAt: now,
        firstEventId: input.eventId,
        firstReason: input.reason,
        attemptIndex: 0,
      };
  write(storage, input.quoteId, session);
  return {
    session,
    attemptIndex: session.attemptIndex,
    msSinceFirstMiss: Math.max(0, now - session.firstMissAt),
    isRetry: Boolean(existing),
  };
}

/**
 * A jump attempt made while a miss session is open — i.e. the reader is retrying
 * after an earlier miss. Returns null when there's nothing to retry.
 */
export function peekRetry(
  storage: SessionStorageLike | null | undefined,
  quoteId: string,
  now: number = Date.now(),
): { attemptIndex: number; msSinceFirstMiss: number; correlationId: string; firstEventId: string; firstReason: string | null } | null {
  const existing = readMissSession(storage, quoteId, now);
  if (!existing) return null;
  return {
    // The retry we're about to run is one past the last recorded attempt.
    attemptIndex: existing.attemptIndex + 1,
    msSinceFirstMiss: Math.max(0, now - existing.firstMissAt),
    correlationId: existing.correlationId,
    firstEventId: existing.firstEventId,
    firstReason: existing.firstReason,
  };
}

/** A retry that finally landed: report it, then close the session. */
export function resolveRetry(
  storage: SessionStorageLike | null | undefined,
  quoteId: string,
  now: number = Date.now(),
): { attemptIndex: number; msSinceFirstMiss: number; correlationId: string } | null {
  const retry = peekRetry(storage, quoteId, now);
  clearMissSession(storage, quoteId);
  if (!retry) return null;
  return {
    attemptIndex: retry.attemptIndex,
    msSinceFirstMiss: retry.msSinceFirstMiss,
    correlationId: retry.correlationId,
  };
}
