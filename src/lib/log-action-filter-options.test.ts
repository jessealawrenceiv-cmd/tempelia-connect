/**
 * Options driving the Activity log's record-type filter control.
 *
 * The point of these tests is the type-safety contract: every value offered by
 * the picker must be an `action_type` the database CHECK constraint accepts, and
 * the option list must stay exhaustive as the generated enum grows — so a new
 * type can never be silently unfilterable.
 */
import { describe, expect, it } from "vitest";
import { LOG_ACTION_TYPES, LogAction } from "./log-action-types";
import { logActionFilterValue } from "./log-action-query";
import {
  LOG_ACTION_FILTER_OPTIONS,
  LOG_ACTION_FILTER_ORDER,
  availableLogActionOptions,
} from "./log-action-presentation";

describe("LOG_ACTION_FILTER_OPTIONS", () => {
  it("covers every allowed action_type exactly once", () => {
    expect(LOG_ACTION_FILTER_OPTIONS).toHaveLength(LOG_ACTION_TYPES.length);
    const values = LOG_ACTION_FILTER_OPTIONS.map((o) => o.value);
    expect(new Set(values).size).toBe(values.length);
    expect([...values].sort()).toEqual([...LOG_ACTION_TYPES].sort());
  });

  it("only offers values the query layer accepts", () => {
    for (const o of LOG_ACTION_FILTER_OPTIONS) {
      expect(() => logActionFilterValue(o.value)).not.toThrow();
      expect(logActionFilterValue(o.value)).toBe(o.value);
    }
  });

  it("gives every option a label and description", () => {
    for (const o of LOG_ACTION_FILTER_OPTIONS) {
      expect(o.label.length).toBeGreaterThan(0);
      expect(o.description.length).toBeGreaterThan(0);
      expect(typeof o.isNew).toBe("boolean");
    }
  });

  it("matches the chip row ordering so both controls agree", () => {
    expect(LOG_ACTION_FILTER_OPTIONS.map((o) => o.value)).toEqual([...LOG_ACTION_FILTER_ORDER]);
  });

  it("lists newly added types first", () => {
    const firstNonNew = LOG_ACTION_FILTER_OPTIONS.findIndex((o) => !o.isNew);
    const lastNew = LOG_ACTION_FILTER_OPTIONS.map((o) => o.isNew).lastIndexOf(true);
    if (firstNonNew !== -1 && lastNew !== -1) expect(lastNew).toBeLessThan(firstNonNew);
  });
});

describe("availableLogActionOptions", () => {
  it("offers everything when nothing is selected", () => {
    expect(availableLogActionOptions([])).toHaveLength(LOG_ACTION_TYPES.length);
  });

  it("hides types already selected", () => {
    const selected = [LogAction.status_refresh, LogAction.opt_in_prompt];
    const remaining = availableLogActionOptions(selected).map((o) => o.value);
    expect(remaining).toHaveLength(LOG_ACTION_TYPES.length - 2);
    expect(remaining).not.toContain(LogAction.status_refresh);
    expect(remaining).not.toContain(LogAction.opt_in_prompt);
  });

  it("returns an empty list once every type is selected", () => {
    expect(availableLogActionOptions([...LOG_ACTION_TYPES])).toHaveLength(0);
  });
});
