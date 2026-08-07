import { describe, expect, it } from "vitest";

import { LOG_ACTION_TYPES, LOGS_ACTION_TYPE_CONSTRAINT } from "@/lib/log-action-types.generated";
import { buildLogActionTypesResponse } from "@/lib/log-action-types.dto";

describe("buildLogActionTypesResponse", () => {
  const payload = buildLogActionTypesResponse();

  it("reports the constraint and full whitelist", () => {
    expect(payload.constraint).toBe(LOGS_ACTION_TYPE_CONSTRAINT);
    expect(payload.values).toEqual(LOG_ACTION_TYPES);
    expect(payload.count).toBe(LOG_ACTION_TYPES.length);
  });

  it("returns one option per allowed action_type", () => {
    expect(payload.options).toHaveLength(LOG_ACTION_TYPES.length);
    expect([...payload.options.map((o) => o.value)].sort()).toEqual([...LOG_ACTION_TYPES].sort());
  });

  it("gives every option a label and a dot color", () => {
    for (const option of payload.options) {
      expect(option.label.length).toBeGreaterThan(0);
      expect(option.description.length).toBeGreaterThan(0);
      expect(option.dot).toMatch(/^bg-/);
      expect(option.dotToken).toBe(option.dot.slice(3));
      expect(typeof option.isNew).toBe("boolean");
    }
  });

  it("is JSON-serializable with no extra fields", () => {
    const parsed = JSON.parse(JSON.stringify(payload));
    expect(Object.keys(parsed).sort()).toEqual(["constraint", "count", "options", "values"]);
    expect(Object.keys(parsed.options[0]).sort()).toEqual([
      "description",
      "dot",
      "dotToken",
      "isNew",
      "label",
      "value",
    ]);
  });
});
