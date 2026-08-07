import { describe, it, expect, vi, beforeEach } from "vitest";

const toastError = vi.fn();
vi.mock("sonner", () => ({ toast: { error: toastError } }));

const {
  isLogActionTypeCheckViolation,
  extractRejectedActionType,
  describeLogActionTypeError,
  reportLogInsertError,
} = await import("./log-error");

const checkError = (details: string) => ({
  code: "23514",
  message: 'new row for relation "logs" violates check constraint "logs_action_type_check"',
  details,
  hint: null,
});

const FAILING_ROW =
  "Failing row contains (2f1c0f4e-1111-4222-8333-444455556666, 9a8b7c6d-1111-4222-8333-444455556666, null, totally_made_up_action, test, null, null, 2026-08-07 00:00:00+00).";

beforeEach(() => toastError.mockClear());

describe("isLogActionTypeCheckViolation", () => {
  it("detects the 23514 logs_action_type_check failure", () => {
    expect(isLogActionTypeCheckViolation(checkError(FAILING_ROW))).toBe(true);
  });

  it("ignores other errors", () => {
    expect(isLogActionTypeCheckViolation({ code: "23514", message: 'violates check constraint "other_check"' })).toBe(false);
    expect(isLogActionTypeCheckViolation({ code: "42501", message: "permission denied" })).toBe(false);
    expect(isLogActionTypeCheckViolation(new Error("network"))).toBe(false);
    expect(isLogActionTypeCheckViolation(null)).toBe(false);
  });
});

describe("extractRejectedActionType", () => {
  it("prefers the attempted value when supplied", () => {
    expect(extractRejectedActionType(checkError(FAILING_ROW), "MY_BAD_TYPE")).toBe("MY_BAD_TYPE");
  });

  it("recovers the value from the failing-row details", () => {
    expect(extractRejectedActionType(checkError(FAILING_ROW))).toBe("totally_made_up_action");
  });

  it("returns null when details are unavailable", () => {
    expect(extractRejectedActionType({ code: "23514", message: "x", details: null })).toBeNull();
  });
});

describe("describeLogActionTypeError", () => {
  it("names the rejected value", () => {
    expect(describeLogActionTypeError(checkError(FAILING_ROW))).toContain("totally_made_up_action");
  });

  it("labels an empty rejected value", () => {
    expect(describeLogActionTypeError(checkError(FAILING_ROW), "")).toContain("(empty)");
  });
});

describe("reportLogInsertError", () => {
  it("shows a clear toast naming the rejected action_type", () => {
    const handled = reportLogInsertError(checkError(FAILING_ROW), { context: "ACTIVE status change" });
    expect(handled).toBe(true);
    const [title, opts] = toastError.mock.calls[0]!;
    expect(title).toBe("Couldn’t record that activity");
    expect(opts.description).toContain("totally_made_up_action");
    expect(opts.description).toContain("ACTIVE status change");
  });

  it("handles locally-rejected values that never reached the database", () => {
    const handled = reportLogInsertError(new Error("Invalid option: expected one of action_type values"), {
      attempted: "bogus_local",
    });
    expect(handled).toBe(true);
    expect(toastError.mock.calls[0]![1].description).toContain("bogus_local");
  });

  it("falls back to a generic message for unrelated failures", () => {
    const handled = reportLogInsertError({ code: "08006", message: "connection failure" });
    expect(handled).toBe(false);
    expect(toastError.mock.calls[0]![1].description).toBe("connection failure");
  });
});
