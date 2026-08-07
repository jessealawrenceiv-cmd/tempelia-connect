/**
 * Correlation IDs for logs API failures.
 *
 * A rejected logs request (e.g. an action_type outside the generated
 * whitelist) is only debuggable if the message the user sees can be matched to
 * the server log line that recorded it. Every rejection mints one short ID and
 * repeats it in four places: the structured server log, the JSON error body,
 * the `x-request-id` response header, and the human-readable message text.
 *
 * Client-safe on purpose: the UI parses the ID back out of whatever error shape
 * it receives (typed payload, header, or plain message string).
 */

/** Marker used in message text so the ID survives string-only error paths. */
export const LOG_REQUEST_ID_PREFIX = "request id: ";

/** e.g. `lg_k3f9x2m1qz` — short enough to read aloud or retype. */
export function newLogRequestId(): string {
  const rand =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 10)
      : Math.random().toString(36).slice(2, 12).padEnd(10, "0");
  return `lg_${rand}`;
}

const ID_RE = /\blg_[a-z0-9]{6,32}\b/i;

/**
 * Pulls a correlation ID off any error shape: a typed payload field
 * (`requestId` / `request_id`), a response header bag, or the message text.
 */
export function logRequestIdFromError(err: unknown): string | undefined {
  if (typeof err === "string") return err.match(ID_RE)?.[0];
  if (!err || typeof err !== "object") return undefined;
  const e = err as Record<string, unknown>;
  for (const key of ["requestId", "request_id", "correlationId"]) {
    const value = e[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  const headers = e['headers'];
  if (headers && typeof (headers as Headers).get === "function") {
    const fromHeader = (headers as Headers).get("x-request-id");
    if (fromHeader) return fromHeader;
  }
  const blob = [e['message'], e['details'], e['hint']]
    .filter((v): v is string => typeof v === "string")
    .join(" ");
  return blob.match(ID_RE)?.[0];
}
