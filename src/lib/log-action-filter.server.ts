/**
 * Server-side action_type guard for the logs read path.
 *
 * The browser guard (log-action-query.ts) is a convenience, not a defence: a
 * caller can bypass it entirely by hitting a server function, a server route,
 * or the MCP endpoint directly. This module is the enforcement point that runs
 * on the server for EVERY logs API endpoint that filters by action_type.
 *
 * Rules enforced here:
 *  - values must be members of the generated whitelist (mirrors the DB CHECK)
 *  - a list containing any invalid value is rejected atomically (no partial
 *    filtering, which would silently return a different result set)
 *  - an empty list is rejected: `.in()` with no values matches nothing, which
 *    reads as "no results" instead of "bad request"
 *  - every rejection is logged structurally so bypass attempts are visible
 *
 * Import from server code only (`*.server.ts`, server-function handlers,
 * server routes, MCP tool handlers).
 */

import { LOG_ACTION_TYPES, type LogActionType } from "./log-action-types.generated";
import { logActionTypeSchema } from "./log-action-types.schema";

/** Error thrown when a logs endpoint receives an action_type it must not run. */
export class LogActionFilterError extends Error {
  readonly status = 400 as const;
  readonly code = "invalid_action_type_filter" as const;
  readonly endpoint: string;
  readonly rejected: string[];
  readonly allowed: readonly string[] = LOG_ACTION_TYPES;

  constructor(endpoint: string, rejected: string[], reason: string) {
    super(
      `Invalid action_type filter for ${endpoint}: ${reason}. ` +
        `Allowed values: ${LOG_ACTION_TYPES.join(", ")}`,
    );
    this.name = "LogActionFilterError";
    this.endpoint = endpoint;
    this.rejected = rejected;
  }

  /** JSON body for server routes / MCP responses. */
  toPayload() {
    return {
      error: this.code,
      message: this.message,
      endpoint: this.endpoint,
      rejected: this.rejected,
      allowed: this.allowed,
    };
  }

  /** 400 Response for raw HTTP boundaries. */
  toResponse(): Response {
    return new Response(JSON.stringify(this.toPayload()), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : String(value);
}

function reject(endpoint: string, rejected: string[], reason: string): never {
  // Single-line, greppable: logs_action_type_filter_rejected
  console.warn(
    `logs_action_type_filter_rejected ${JSON.stringify({
      endpoint,
      rejected,
      reason,
      at: new Date().toISOString(),
    })}`,
  );
  throw new LogActionFilterError(endpoint, rejected, reason);
}

/**
 * Validates a single action_type filter value on the server.
 * @param endpoint stable identifier used in logs (e.g. "mcp.list_recent_activity")
 */
export function assertLogActionFilter(endpoint: string, value: unknown): LogActionType {
  const parsed = logActionTypeSchema.safeParse(value);
  if (!parsed.success) {
    return reject(endpoint, [asText(value)], `${JSON.stringify(asText(value))} is not an allowed action_type`);
  }
  return parsed.data;
}

/**
 * Validates a list filter. Rejects atomically: one bad value fails the whole
 * request so a bypassing client cannot smuggle a narrowed result set through.
 */
export function assertLogActionFilters(
  endpoint: string,
  values: unknown,
): LogActionType[] {
  if (!Array.isArray(values)) {
    return reject(endpoint, [asText(values)], "expected an array of action_type values");
  }
  if (values.length === 0) {
    return reject(endpoint, [], "empty action_type list (would match nothing)");
  }
  const bad: string[] = [];
  const good: LogActionType[] = [];
  for (const value of values) {
    const parsed = logActionTypeSchema.safeParse(value);
    if (parsed.success) {
      if (!good.includes(parsed.data)) good.push(parsed.data);
    } else if (!bad.includes(asText(value))) {
      bad.push(asText(value));
    }
  }
  if (bad.length > 0) {
    return reject(endpoint, bad, `${bad.length} disallowed value(s): ${bad.join(", ")}`);
  }
  return good;
}

/** Optional-filter helper: `undefined`/`null` means "no filter", anything else is validated. */
export function assertOptionalLogActionFilter(
  endpoint: string,
  value: unknown,
): LogActionType | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return assertLogActionFilter(endpoint, value);
}

/** Non-throwing variant for boundaries that return an error payload instead. */
export function checkLogActionFilters(
  endpoint: string,
  values: unknown,
): { ok: true; values: LogActionType[] } | { ok: false; error: LogActionFilterError } {
  try {
    return { ok: true, values: assertLogActionFilters(endpoint, values) };
  } catch (err) {
    if (err instanceof LogActionFilterError) return { ok: false, error: err };
    throw err;
  }
}
