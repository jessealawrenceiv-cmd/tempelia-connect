import { describe, expect, it, vi } from "vitest";

import { LOG_ACTION_TYPES } from "@/lib/log-action-types.generated";
import { logActionTypeViolation } from "@/lib/log-action-types.schema";
import {
  describeLogActionTypeViolation,
  toastLogActionTypeViolation,
} from "@/lib/log-action-violation";

const toastError = vi.fn();
vi.mock("sonner", () => ({ toast: { error: (...args: unknown[]) => toastError(...args) } }));

describe("describeLogActionTypeViolation", () => {
  it("describes a locally blocked write with the allowed hints", () => {
    const display = describeLogActionTypeViolation(logActionTypeViolation("bogus_type"));
    expect(display).not.toBeNull();
    expect(display!.rejected).toBe("bogus_type");
    expect(display!.allowed).toEqual(LOG_ACTION_TYPES);
    expect(display!.hint).toContain(LOG_ACTION_TYPES[0]!);
  });

  it("describes a real Postgres 23514 constraint error", () => {
    const display = describeLogActionTypeViolation({
      code: "23514",
      message:
        'new row for relation "logs" violates check constraint "logs_action_type_check": action_type "nope"',
    });
    expect(display).not.toBeNull();
    expect(display!.title).toBe("Activity log write rejected");
  });

  it("ignores unrelated errors", () => {
    expect(describeLogActionTypeViolation({ message: "network down" })).toBeNull();
    expect(describeLogActionTypeViolation(null)).toBeNull();
  });
});

describe("toastLogActionTypeViolation", () => {
  it("shows a toast listing the allowed action types", () => {
    toastError.mockClear();
    expect(toastLogActionTypeViolation(logActionTypeViolation("nope"))).toBe(true);
    expect(toastError).toHaveBeenCalledTimes(1);
    const [title, opts] = toastError.mock.calls[0] as [string, { description: string }];
    expect(title).toBe("Activity log write rejected");
    expect(opts.description).toContain(LOG_ACTION_TYPES[0]!);
  });

  it("does not toast unrelated errors", () => {
    toastError.mockClear();
    expect(toastLogActionTypeViolation({ message: "boom" })).toBe(false);
    expect(toastError).not.toHaveBeenCalled();
  });
});
